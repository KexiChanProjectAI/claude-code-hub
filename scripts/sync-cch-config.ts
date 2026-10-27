#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createTranslator } from "next-intl";
import postgres from "postgres";
import en from "../messages/en/configSync.json";
import ja from "../messages/ja/configSync.json";
import ru from "../messages/ru/configSync.json";
import zhCN from "../messages/zh-CN/configSync.json";
import zhTW from "../messages/zh-TW/configSync.json";

const catalogs = { en, ja, ru, "zh-CN": zhCN, "zh-TW": zhTW };
export const TABLES = [
  "provider_vendors",
  "provider_groups",
  "providers",
  "provider_endpoints",
  "model_prices",
  "cloud_pricing_catalog",
] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, unknown>;
type Snapshot = Record<Table, Row[]>;
type Column = { name: string; type: string };
type Schema = Record<Table, Column[]>;
type Sql = postgres.Sql | postgres.TransactionSql;
const protectedFields: Record<string, boolean> = {
  id: true,
  provider_vendor_id: true,
  vendor_id: true,
  created_at: true,
  updated_at: true,
  deleted_at: true,
  total_cost_reset_at: true,
  ["__proto__"]: true,
  prototype: true,
  constructor: true,
};

export type Rule = {
  tables: Table[];
  when?: { field: string; op: "eq" | "ne" | "like" | "not_like"; value: unknown };
  set: Row;
};

function fail(code: string): never {
  throw new Error(code);
}

function pathParts(field: string): string[] {
  const parts = field.split(".");
  if (
    parts.some(
      (part) => !part || Object.hasOwn(protectedFields, part) || part.startsWith("last_probe")
    )
  ) {
    fail("invalid_field");
  }
  return parts;
}

export function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) fail("invalid_rules");
  return value.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_rules");
    const rule = input as Rule;
    if (Object.keys(rule).some((key) => !["tables", "when", "set"].includes(key))) {
      fail("invalid_rules");
    }
    if (
      !Array.isArray(rule.tables) ||
      !rule.tables.length ||
      rule.tables.some((table) => !TABLES.includes(table))
    )
      fail("invalid_rules");
    if (
      !rule.set ||
      typeof rule.set !== "object" ||
      Array.isArray(rule.set) ||
      !Object.keys(rule.set).length
    )
      fail("invalid_rules");
    for (const field of Object.keys(rule.set)) pathParts(field);
    if (rule.when !== undefined) {
      const when = rule.when;
      if (
        !when ||
        typeof when !== "object" ||
        Array.isArray(when) ||
        typeof when.field !== "string" ||
        !["eq", "ne", "like", "not_like"].includes(when.op) ||
        !Object.hasOwn(when, "value") ||
        Object.keys(when).some((key) => !["field", "op", "value"].includes(key))
      ) {
        fail("invalid_rules");
      }
      pathParts(when.field);
      if ((when.op === "like" || when.op === "not_like") && typeof when.value !== "string") {
        fail("invalid_rules");
      }
    }
    return rule;
  });
}

export function parsePolicy(value: unknown): { preserveProviders: string[]; rules: Rule[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_policy");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).some((key) => !["preserveProviders", "rules"].includes(key))) {
    fail("invalid_policy");
  }
  const names = Object.hasOwn(policy, "preserveProviders") ? policy.preserveProviders : [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name.trim())) {
    fail("invalid_policy");
  }
  return {
    preserveProviders: [...new Set<string>(names)],
    rules: parseRules(Object.hasOwn(policy, "rules") ? policy.rules : []),
  };
}

function getField(row: Row, field: string): unknown {
  if (field === "url.host") return new URL(String(row.url)).host;
  let value: unknown = row;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Row)[part];
  }
  return value;
}

function setField(row: Row, field: string, value: unknown): void {
  if (field === "url.host") {
    if (typeof value !== "string" || !value) fail("invalid_host");
    const host = new URL(`http://${value}`);
    if (
      (host.host !== value && `${host.hostname}:80` !== value) ||
      host.username ||
      host.password ||
      host.pathname !== "/" ||
      host.search ||
      host.hash
    )
      fail("invalid_host");
    const url = new URL(String(row.url));
    url.host = value;
    // URL.host does not clear an existing port when the replacement omits it.
    url.port = value.slice(host.hostname.length).replace(/^:/, "");
    row.url = url.toString();
    return;
  }
  const parts = pathParts(field);
  let parent = row;
  for (const part of parts.slice(0, -1)) {
    const current = parent[part];
    if (current === null || current === undefined) parent[part] = {};
    else if (typeof current !== "object" || Array.isArray(current)) fail("invalid_field");
    parent = parent[part] as Row;
  }
  parent[parts[parts.length - 1]] = structuredClone(value);
}

function like(value: string, pattern: string): boolean {
  let expression = "^";
  for (const char of pattern) {
    expression +=
      char === "%" ? ".*" : char === "_" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "s").test(value);
}

export function applyRules(table: Table, original: Row, rules: Rule[]): Row {
  const row = structuredClone(original);
  for (const rule of rules) {
    if (!rule.tables.includes(table)) continue;
    let matches = true;
    if (rule.when) {
      const actual = getField(row, rule.when.field);
      const { op, value } = rule.when;
      if (op === "eq" || op === "ne") {
        matches = actual === value;
        if (op === "ne") matches = !matches;
      } else {
        // SQL LIKE / NOT LIKE do not match NULL or absent fields.
        matches =
          typeof actual === "string" &&
          typeof value === "string" &&
          (op === "like" ? like(actual, value) : !like(actual, value));
      }
    }
    if (matches) for (const [field, value] of Object.entries(rule.set)) setField(row, field, value);
  }
  return row;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function schema(sql: Sql): Promise<Schema> {
  const result = {} as Schema;
  for (const table of TABLES) {
    const columns = await sql<Column[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      WHERE a.attrelid = to_regclass(${`public.${table}`})
        AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname
    `;
    if (!columns.length || !columns.some((column) => column.name === "id")) fail("schema_mismatch");
    result[table] = Array.from(columns);
  }
  return result;
}

function validateRules(rules: Rule[], columns: Schema): void {
  for (const rule of rules) {
    const fields = [...Object.keys(rule.set), ...(rule.when ? [rule.when.field] : [])];
    for (const table of rule.tables) {
      for (const field of fields) {
        const [root] = pathParts(field);
        const column = columns[table].find((item) => item.name === root);
        if (
          !column ||
          (field.includes(".") &&
            field !== "url.host" &&
            column.type !== "jsonb" &&
            column.type !== "json")
        )
          fail("invalid_field");
      }
    }
  }
}

async function identity(sql: Sql): Promise<string> {
  const [row] = await sql`
    SELECT current_database() AS database, inet_server_addr()::text AS address,
      inet_server_port() AS port, pg_postmaster_start_time()::text AS started
  `;
  return JSON.stringify(row);
}

async function insert(sql: Sql, table: Table, row: Row, upsert = false): Promise<number> {
  const fields = Object.keys(row).filter((field) => field !== "id");
  const names = fields.map(quote).join(", ");
  const conflict = upsert
    ? ` ON CONFLICT (website_domain) DO UPDATE SET ${fields
        .filter((field) => field !== "website_domain")
        .map((field) => `${quote(field)} = EXCLUDED.${quote(field)}`)
        .join(", ")}`
    : "";
  const [inserted] = await sql.unsafe(
    `INSERT INTO public.${quote(table)} (${names})
     SELECT ${names} FROM jsonb_populate_record(NULL::public.${quote(table)}, $1::text::jsonb)
     ${conflict} RETURNING id`,
    [JSON.stringify(row)]
  );
  return inserted.id;
}

export async function syncConfig(
  sourceDsn: string,
  targetDsn: string,
  rules: Rule[],
  overwrite: boolean,
  preserveProviders: string[] = []
): Promise<Record<Table, { source: number; target: number; preserved?: number }>> {
  const source = postgres(sourceDsn, { max: 1, connect_timeout: 10 });
  const target = postgres(targetDsn, { max: 1, connect_timeout: 10 });
  try {
    if ((await identity(source)) === (await identity(target))) fail("same_database");
    const preservedNames = new Set(preserveProviders);
    const snapshot = {} as Snapshot;
    let sourceSchema: Schema;
    await source.begin("isolation level repeatable read read only", async (sql) => {
      sourceSchema = await schema(sql);
      validateRules(rules, sourceSchema);
      for (const table of TABLES) {
        const filter =
          table === "providers" || table === "provider_endpoints"
            ? " WHERE deleted_at IS NULL"
            : "";
        const rows = await sql.unsafe(
          `SELECT row_to_json(t) AS row FROM public.${quote(table)} t${filter} ORDER BY id`
        );
        snapshot[table] = rows
          .filter(({ row }) => table !== "providers" || !preservedNames.has(row.name))
          .map(({ row }) => applyRules(table, row, rules))
          .filter((row) => table !== "providers" || !preservedNames.has(String(row.name)));
      }
    });
    return await target.begin(async (sql) => {
      if (overwrite)
        await sql.unsafe(
          `LOCK TABLE ${TABLES.map((table) => `public.${quote(table)}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`
        );
      const targetSchema = await schema(sql);
      if (JSON.stringify(sourceSchema) !== JSON.stringify(targetSchema)) fail("schema_mismatch");
      const preserved = await sql`
        SELECT id, name, provider_vendor_id, provider_type FROM public.providers
        WHERE deleted_at IS NULL AND name = ANY(${preserveProviders})
      `;
      const foundNames = new Set(preserved.map((row) => row.name));
      if (preserveProviders.some((name) => !foundNames.has(name)))
        fail("missing_preserved_provider");
      const preservedIds = preserved.map((row) => row.id);
      const preservedPools = new Set(
        preserved.map((row) => JSON.stringify([row.provider_vendor_id, row.provider_type]))
      );
      const vendors = await sql`
        SELECT id, website_domain FROM public.provider_vendors
        WHERE id = ANY(${preserved.map((row) => row.provider_vendor_id)})
      `;
      const preservedVendors = new Map(vendors.map((row) => [row.website_domain, row.id]));
      const counts = {} as Record<Table, { source: number; target: number; preserved?: number }>;
      for (const table of TABLES) {
        const filter =
          table === "providers" || table === "provider_endpoints"
            ? " WHERE deleted_at IS NULL"
            : "";
        const [count] = await sql.unsafe(
          `SELECT count(*)::int AS count FROM public.${quote(table)}${filter}`
        );
        counts[table] = { source: snapshot[table].length, target: count.count };
      }
      if (preserveProviders.length) counts.providers.preserved = preserved.length;
      if (!overwrite) return counts;
      // Retain historical identities; never reuse source IDs in the target.
      await sql`UPDATE public.providers SET deleted_at = now(), updated_at = now()
        WHERE deleted_at IS NULL AND NOT (id = ANY(${preservedIds}))`;
      await sql`UPDATE public.provider_endpoints e SET deleted_at = now(), updated_at = now()
        WHERE e.deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM public.providers p WHERE p.id = ANY(${preservedIds})
            AND p.provider_vendor_id = e.vendor_id AND p.provider_type = e.provider_type
        )`;
      for (const table of ["provider_groups", "model_prices", "cloud_pricing_catalog"] as const) {
        await sql.unsafe(`DELETE FROM public.${quote(table)}`);
      }
      const vendorIds = new Map<unknown, number>();
      for (const row of snapshot.provider_vendors) {
        vendorIds.set(
          row.id,
          preservedVendors.get(row.website_domain) ??
            (await insert(sql, "provider_vendors", row, true))
        );
      }
      for (const table of TABLES.filter((table) => table !== "provider_vendors")) {
        for (const original of snapshot[table]) {
          const row = { ...original };
          const reference =
            table === "providers"
              ? "provider_vendor_id"
              : table === "provider_endpoints"
                ? "vendor_id"
                : null;
          if (reference) {
            const vendorId = vendorIds.get(row[reference]);
            if (!vendorId) fail("missing_vendor");
            row[reference] = vendorId;
          }
          if (
            table === "provider_endpoints" &&
            preservedPools.has(JSON.stringify([row.vendor_id, row.provider_type]))
          ) {
            continue;
          }
          if (table === "providers") row.total_cost_reset_at = null;
          if (table === "provider_endpoints") {
            for (const field of Object.keys(row))
              if (field.startsWith("last_probe")) row[field] = null;
          }
          await insert(sql, table, row);
        }
      }
      return counts;
    });
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      rules: { type: "string" },
      policy: { type: "string" },
      overwrite: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      lang: { type: "string", default: "zh-CN" },
    },
    allowPositionals: false,
  });
  const locale = values.lang as keyof typeof catalogs;
  if (!Object.hasOwn(catalogs, locale)) fail("invalid_locale");
  const t = createTranslator({ locale, messages: catalogs[locale] });
  try {
    if (values.help) {
      console.log(t("usage"));
      return;
    }
    const source = process.env.CCH_SOURCE_DSN;
    const target = process.env.CCH_TARGET_DSN;
    if (!source || !target) fail("missing_dsn");
    const rules = values.rules ? parseRules(JSON.parse(await readFile(values.rules, "utf8"))) : [];
    const policy = values.policy
      ? parsePolicy(JSON.parse(await readFile(values.policy, "utf8")))
      : { preserveProviders: [], rules: [] };
    const overwrite = values.overwrite && !values["dry-run"];
    const counts = await syncConfig(
      source,
      target,
      [...rules, ...policy.rules],
      overwrite,
      policy.preserveProviders
    );
    console.log(t(overwrite ? "applied" : "preview"));
    console.log(JSON.stringify(counts, null, 2));
    if (overwrite) console.log(t("restart"));
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const known = [
      "invalid_rules",
      "invalid_policy",
      "missing_preserved_provider",
      "invalid_field",
      "invalid_host",
      "schema_mismatch",
      "same_database",
      "missing_vendor",
      "missing_dsn",
    ];
    // Database errors can contain credentials or entire failing rows. Do not print them.
    console.error(t(known.includes(code) ? (code as "invalid_rules") : "failed"));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("config_sync.invalid_arguments");
    process.exitCode = 1;
  });
}
