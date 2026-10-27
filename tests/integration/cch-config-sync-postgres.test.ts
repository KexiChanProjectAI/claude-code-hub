import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { main, parsePolicy, parseRules, syncConfig, TABLES } from "../../scripts/sync-cch-config";

const dsn = process.env.CCH_CONFIG_SYNC_TEST_DSN;
const run = describe.skipIf(!dsn);
const prefix = `cch_sync_test_${process.pid}_${Date.now()}`;
let admin: postgres.Sql;
let source: postgres.Sql;
let target: postgres.Sql;
let sourceDsn: string;
let targetDsn: string;

const ddl = `
  CREATE TABLE provider_vendors (id serial PRIMARY KEY, website_domain text NOT NULL UNIQUE, display_name text);
  CREATE TABLE provider_groups (id serial PRIMARY KEY, name text NOT NULL UNIQUE, cost_multiplier numeric(10,4), description text);
  CREATE TABLE providers (id serial PRIMARY KEY, name text NOT NULL, url text NOT NULL, key text NOT NULL,
    provider_vendor_id int NOT NULL REFERENCES provider_vendors(id), provider_type text NOT NULL,
    is_enabled boolean NOT NULL, proxy_url text, custom_headers jsonb, new_api_access_token text,
    allowed_models jsonb, model_redirects jsonb, weight int NOT NULL CHECK (weight > 0),
    proxy_fallback_to_direct boolean NOT NULL DEFAULT true,
    total_cost_reset_at timestamptz, updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
  CREATE TABLE provider_endpoints (id serial PRIMARY KEY, vendor_id int NOT NULL REFERENCES provider_vendors(id),
    provider_type text NOT NULL, url text NOT NULL, is_enabled boolean NOT NULL, last_probe_ok boolean,
    updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
  CREATE UNIQUE INDEX endpoint_unique ON provider_endpoints(vendor_id, provider_type, url) WHERE deleted_at IS NULL;
  CREATE TABLE model_prices (id serial PRIMARY KEY, model_name text NOT NULL, price_data jsonb NOT NULL,
    source text NOT NULL, created_at timestamptz NOT NULL);
  CREATE TABLE cloud_pricing_catalog (id serial PRIMARY KEY, version text NOT NULL, providers jsonb, vendors jsonb);
  CREATE TABLE message_request (id serial PRIMARY KEY, provider_id int NOT NULL, cost numeric);
`;

async function seed(sql: postgres.Sql, isSource: boolean) {
  await sql.unsafe(
    `TRUNCATE message_request, ${[...TABLES].reverse().join(",")} RESTART IDENTITY CASCADE`
  );
  await sql`INSERT INTO provider_vendors (website_domain, display_name) VALUES ('api.example', ${isSource ? "source vendor" : "old vendor"})`;
  await sql`INSERT INTO provider_groups (name, cost_multiplier, description) VALUES (${isSource ? "team" : "stale"}, 0.1234, 'group')`;
  await sql`INSERT INTO providers (name, url, key, provider_vendor_id, provider_type, is_enabled, weight,
    custom_headers, proxy_url, new_api_access_token, allowed_models, model_redirects, total_cost_reset_at)
    VALUES (${isSource ? "source provider" : "old provider"}, 'https://api.example/v1', 'private-key', 1,
    'codex', false, 1, '{"Authorization":"private-header","Other":"keep"}', 'http://u:p@proxy.example',
    'private-token', '["gpt-model"]', '{"gpt-alias":"gpt-model"}', '2025-01-01')`;
  await sql`INSERT INTO provider_endpoints (vendor_id, provider_type, url, is_enabled, last_probe_ok)
    VALUES (1, 'codex', 'https://api.example/v1', false, true)`;
  await sql`INSERT INTO model_prices (model_name, price_data, source, created_at)
    VALUES (${isSource ? "gpt-model" : "stale"}, '{"input_cost_per_token":0.001,"providers":{"a":{"output_cost_per_token":0.002}}}', 'cloud', '2026-01-01 00:00:00.123456+00')`;
  await sql`INSERT INTO cloud_pricing_catalog (version, providers, vendors) VALUES (${isSource ? "new" : "old"}, '{"a":{"name":"A"}}', '[{"vendor":"a"}]')`;
  if (isSource) {
    await sql`INSERT INTO providers (name, url, key, provider_vendor_id, provider_type, is_enabled, weight, deleted_at)
      VALUES ('deleted', 'https://deleted.example', 'unused', 1, 'codex', true, 1, now())`;
    await sql`INSERT INTO provider_endpoints (vendor_id, provider_type, url, is_enabled, deleted_at)
      VALUES (1, 'codex', 'https://deleted.example', true, now())`;
    await sql`INSERT INTO model_prices (model_name, price_data, source, created_at)
      VALUES ('gpt-model', '{"input_cost_per_token":0.003}', 'manual', '2026-02-01')`;
  } else await sql`INSERT INTO message_request (provider_id, cost) VALUES (1, 0.25)`;
}

run("CCH configuration sync PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(dsn!);
    if (!url.pathname.includes("test"))
      throw new Error("CCH_CONFIG_SYNC_TEST_DSN must use a dedicated test database");
    admin = postgres(dsn!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${prefix}_source`);
    await admin.unsafe(`CREATE DATABASE ${prefix}_target`);
    url.pathname = `/${prefix}_source`;
    sourceDsn = url.toString();
    url.pathname = `/${prefix}_target`;
    targetDsn = url.toString();
    source = postgres(sourceDsn, { max: 1 });
    target = postgres(targetDsn, { max: 1 });
    await source.unsafe(ddl);
    await target.unsafe(ddl);
  });
  beforeEach(async () => {
    await seed(source, true);
    await seed(target, false);
  });
  afterAll(async () => {
    await Promise.all([source?.end(), target?.end()]);
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${prefix}_source`);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${prefix}_target`);
      await admin.end();
    }
  });

  test("mirrors full secrets, model history and catalog, remaps identities, and retains target usage", async () => {
    const rules = parseRules([
      {
        tables: ["providers", "provider_endpoints"],
        when: { field: "url.host", op: "eq", value: "api.example" },
        set: { "url.host": "other.example:9443" },
      },
      {
        tables: ["providers"],
        when: { field: "url.host", op: "not_like", value: "internal%" },
        set: { proxy_url: "socks5://localhost:1080" },
      },
    ]);
    const counts = await syncConfig(sourceDsn, targetDsn, rules, true);
    expect(counts.providers).toEqual({ source: 1, target: 1 });
    expect(counts.model_prices).toEqual({ source: 2, target: 1 });
    const [provider] = await target`SELECT * FROM providers WHERE deleted_at IS NULL`;
    expect(provider).toMatchObject({
      name: "source provider",
      url: "https://other.example:9443/v1",
      key: "private-key",
      custom_headers: { Authorization: "private-header", Other: "keep" },
      new_api_access_token: "private-token",
      is_enabled: false,
      proxy_url: "socks5://localhost:1080",
      allowed_models: ["gpt-model"],
      model_redirects: { "gpt-alias": "gpt-model" },
      total_cost_reset_at: null,
    });
    expect(provider.id).not.toBe(1);
    const [history] =
      await target`SELECT p.name, m.cost FROM message_request m JOIN providers p ON p.id = m.provider_id`;
    expect(history).toEqual({ name: "old provider", cost: "0.25" });
    const [vendor] =
      await target`SELECT * FROM provider_vendors WHERE id = ${provider.provider_vendor_id}`;
    expect(vendor.display_name).toBe("source vendor");
    const [endpoint] = await target`SELECT * FROM provider_endpoints WHERE deleted_at IS NULL`;
    expect(endpoint).toMatchObject({
      vendor_id: vendor.id,
      url: provider.url,
      is_enabled: false,
      last_probe_ok: null,
    });
    const prices =
      await target`SELECT model_name, price_data, source, created_at::text FROM model_prices ORDER BY created_at`;
    expect(prices).toEqual(
      Array.from(
        await source`SELECT model_name, price_data, source, created_at::text FROM model_prices ORDER BY created_at`
      )
    );
    expect(Array.from(await target`SELECT name, cost_multiplier FROM provider_groups`)).toEqual([
      { name: "team", cost_multiplier: "0.1234" },
    ]);
    expect(
      Array.from(await target`SELECT version, providers, vendors FROM cloud_pricing_catalog`)
    ).toEqual(
      Array.from(await source`SELECT version, providers, vendors FROM cloud_pricing_catalog`)
    );
    expect((await source`SELECT url FROM providers WHERE deleted_at IS NULL`)[0].url).toBe(
      "https://api.example/v1"
    );
    await syncConfig(sourceDsn, targetDsn, [], true);
    expect(
      (await target`SELECT count(*)::int AS n FROM providers WHERE deleted_at IS NULL`)[0].n
    ).toBe(1);
    expect((await target`SELECT key FROM providers WHERE deleted_at IS NULL`)[0].key).toBe(
      "private-key"
    );
  });

  test("preview never mutates either instance", async () => {
    const before = await target`SELECT row_to_json(p) AS row FROM providers p ORDER BY id`;
    await syncConfig(sourceDsn, targetDsn, [], false);
    expect(
      Array.from(await target`SELECT row_to_json(p) AS row FROM providers p ORDER BY id`)
    ).toEqual(Array.from(before));
    expect((await target`SELECT model_name FROM model_prices`)[0].model_name).toBe("stale");
  });

  test("preserves both official providers, IDs, credentials, vendor and endpoint pools on repeated overwrite", async () => {
    await target`UPDATE providers SET name='cc官key', provider_type='claude' WHERE id=1`;
    await target`INSERT INTO providers(name,url,key,provider_vendor_id,provider_type,is_enabled,weight,proxy_url)
      VALUES ('openai 官key','https://api.example/v1','target-official-key',1,'codex',true,1,'http://target:secret@proxy.example')`;
    await target`INSERT INTO provider_endpoints(vendor_id,provider_type,url,is_enabled,last_probe_ok)
      VALUES (1,'claude','https://api.example/claude',true,true)`;
    await source`INSERT INTO providers(name,url,key,provider_vendor_id,provider_type,is_enabled,weight)
      VALUES ('cc官key','https://changed.example','source-official-key',1,'claude',true,1),
        ('openai 官key','https://changed.example','source-openai-key',1,'codex',true,1)`;
    await source`INSERT INTO provider_endpoints(vendor_id,provider_type,url,is_enabled)
      VALUES (1,'claude','https://changed.example',true), (1,'gemini','https://gemini.example',true)`;
    const before = Array.from(
      await target`SELECT row_to_json(p) AS row FROM providers p WHERE deleted_at IS NULL ORDER BY id`
    );
    const vendor = Array.from(
      await target`SELECT row_to_json(v) AS row FROM provider_vendors v ORDER BY id`
    );
    const endpoints = Array.from(
      await target`SELECT row_to_json(e) AS row FROM provider_endpoints e ORDER BY id`
    );
    const policy = parsePolicy(JSON.parse(await readFile("scripts/sync-cch1-policy.json", "utf8")));
    const rules = [
      ...parseRules([
        { tables: ["providers", "provider_endpoints"], set: { "url.host": "changed.example" } },
      ]),
      ...policy.rules,
    ];
    const counts = await syncConfig(sourceDsn, targetDsn, rules, false, policy.preserveProviders);
    expect(counts.providers).toEqual({ source: 1, target: 2, preserved: 2 });
    for (let i = 0; i < 2; i++) {
      await syncConfig(sourceDsn, targetDsn, rules, true, policy.preserveProviders);
      expect(
        Array.from(
          await target`SELECT row_to_json(p) AS row FROM providers p WHERE name = ANY(${policy.preserveProviders}) ORDER BY id`
        )
      ).toEqual(before);
      expect(
        Array.from(await target`SELECT row_to_json(v) AS row FROM provider_vendors v ORDER BY id`)
      ).toEqual(vendor);
      expect(
        Array.from(
          await target`SELECT row_to_json(e) AS row FROM provider_endpoints e WHERE provider_type IN ('claude','codex') ORDER BY id`
        )
      ).toEqual(endpoints);
      const providers =
        await target`SELECT name,key,proxy_fallback_to_direct FROM providers WHERE deleted_at IS NULL ORDER BY name`;
      expect(providers).toHaveLength(3);
      expect(providers.find((p) => p.name === "source provider")).toMatchObject({
        key: "private-key",
        proxy_fallback_to_direct: false,
      });
      expect(
        (
          await target`SELECT url FROM provider_endpoints WHERE provider_type='gemini' AND deleted_at IS NULL`
        )[0].url
      ).toBe("https://changed.example/");
    }
  });

  test("fails closed when a whitelisted target provider is missing", async () => {
    for (const overwrite of [false, true]) {
      await expect(syncConfig(sourceDsn, targetDsn, [], overwrite, ["missing"])).rejects.toThrow(
        "missing_preserved_provider"
      );
      expect((await target`SELECT name FROM providers WHERE deleted_at IS NULL`)[0].name).toBe(
        "old provider"
      );
    }
  });

  test("rolls back all configuration tables on an invalid overridden value", async () => {
    const rules = parseRules([{ tables: ["providers"], set: { weight: -1 } }]);
    await expect(syncConfig(sourceDsn, targetDsn, rules, true)).rejects.toThrow();
    expect((await target`SELECT name FROM providers WHERE deleted_at IS NULL`)[0].name).toBe(
      "old provider"
    );
    expect((await target`SELECT name FROM provider_groups`)[0].name).toBe("stale");
    expect((await target`SELECT model_name FROM model_prices`)[0].model_name).toBe("stale");
  });

  test("rejects the same DB even through a different connection string", async () => {
    await expect(
      syncConfig(sourceDsn, `${sourceDsn}?application_name=alias`, [], true)
    ).rejects.toThrow("same_database");
  });

  test("rejects a schema mismatch before target mutation", async () => {
    await target`ALTER TABLE providers ADD COLUMN extra text`;
    try {
      await expect(syncConfig(sourceDsn, targetDsn, [], true)).rejects.toThrow("schema_mismatch");
      expect((await target`SELECT name FROM providers WHERE deleted_at IS NULL`)[0].name).toBe(
        "old provider"
      );
    } finally {
      await target`ALTER TABLE providers DROP COLUMN extra`;
    }
  });

  test.each(["typo", "key.child"])(
    "rejects unknown or non-JSON field %s before writing",
    async (field) => {
      await expect(
        syncConfig(
          sourceDsn,
          targetDsn,
          parseRules([{ tables: ["providers"], set: { [field]: "x" } }]),
          true
        )
      ).rejects.toThrow("invalid_field");
      expect((await target`SELECT name FROM providers WHERE deleted_at IS NULL`)[0].name).toBe(
        "old provider"
      );
    }
  );

  test("inserts missing vendors and fails atomically on dangling vendor references", async () => {
    await target`UPDATE provider_vendors SET website_domain = 'target-only.example'`;
    await syncConfig(sourceDsn, targetDsn, [], true);
    const [provider] =
      await target`SELECT provider_vendor_id FROM providers WHERE deleted_at IS NULL`;
    expect(provider.provider_vendor_id).not.toBe(1);
    await source`ALTER TABLE providers DROP CONSTRAINT providers_provider_vendor_id_fkey`;
    try {
      await source`UPDATE providers SET provider_vendor_id = 999 WHERE deleted_at IS NULL`;
      await expect(syncConfig(sourceDsn, targetDsn, [], true)).rejects.toThrow("missing_vendor");
      expect((await target`SELECT name FROM providers WHERE deleted_at IS NULL`)[0].name).toBe(
        "source provider"
      );
    } finally {
      await source`UPDATE providers SET provider_vendor_id = 1`;
      await source`ALTER TABLE providers ADD CONSTRAINT providers_provider_vendor_id_fkey FOREIGN KEY (provider_vendor_id) REFERENCES provider_vendors(id)`;
    }
  });

  test("CLI dry-run wins over overwrite and errors never print secrets", async () => {
    const rulesPath = join(tmpdir(), `${prefix}_rules.json`);
    const policyPath = join(tmpdir(), `${prefix}_policy.json`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CCH_SOURCE_DSN", sourceDsn);
    vi.stubEnv("CCH_TARGET_DSN", targetDsn);
    try {
      await writeFile(rulesPath, JSON.stringify([{ tables: ["providers"], set: { weight: -1 } }]));
      await main(["--overwrite", "--dry-run", "--lang", "en"]);
      expect((await target`SELECT name FROM providers WHERE deleted_at IS NULL`)[0].name).toBe(
        "old provider"
      );
      await main(["--overwrite", "--rules", rulesPath, "--lang", "en"]);
      expect(process.exitCode).toBe(1);
      expect(error.mock.calls.flat().join(" ")).not.toMatch(
        /private-key|private-token|private-header/
      );
      process.exitCode = 0;
      await writeFile(
        policyPath,
        JSON.stringify({
          preserveProviders: ["old provider"],
          rules: [{ tables: ["providers"], set: { proxy_fallback_to_direct: false } }],
        })
      );
      await writeFile(
        rulesPath,
        JSON.stringify([{ tables: ["providers"], set: { proxy_fallback_to_direct: true } }])
      );
      await main(["--overwrite", "--rules", rulesPath, "--policy", policyPath, "--lang", "en"]);
      expect(
        Array.from(
          await target`SELECT name,proxy_fallback_to_direct FROM providers WHERE deleted_at IS NULL ORDER BY name`
        )
      ).toEqual([
        { name: "old provider", proxy_fallback_to_direct: true },
        { name: "source provider", proxy_fallback_to_direct: false },
      ]);
      await writeFile(policyPath, JSON.stringify({ preserveProviders: null }));
      await main(["--policy", policyPath, "--lang", "en"]);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await main(["--help"]);
      vi.stubEnv("CCH_SOURCE_DSN", "");
      await main([]);
      expect(process.exitCode).toBe(1);
      await expect(main(["--lang", "unknown"])).rejects.toThrow("invalid_locale");
    } finally {
      process.exitCode = 0;
      vi.unstubAllEnvs();
      log.mockRestore();
      error.mockRestore();
      await rm(rulesPath, { force: true });
      await rm(policyPath, { force: true });
    }
  });
});
