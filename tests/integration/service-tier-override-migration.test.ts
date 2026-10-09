import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";
import { convertLegacyCodexServiceTierToRules } from "@/lib/service-tier-override";

const dsn = process.env.DSN || process.env.DATABASE_URL;
const run = describe.skipIf(!dsn);

type Row = {
  id: number;
  provider_type: string;
  codex_service_tier_preference: string | null;
  service_tier_override_rules: unknown;
};

let admin: ReturnType<typeof postgres> | null = null;

function findMigrationSql(): string {
  const drizzleDirectory = resolve(process.cwd(), "drizzle");
  const migrationFile = readdirSync(drizzleDirectory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => resolve(drizzleDirectory, file))
    .find((file) =>
      readFileSync(file, "utf8").includes(
        'ALTER TABLE "providers" ADD COLUMN "service_tier_override_rules" jsonb'
      )
    );

  if (!migrationFile) {
    throw new Error("Generated service tier override migration was not found");
  }

  return readFileSync(migrationFile, "utf8");
}

function databaseUrl(databaseName: string): string {
  if (!dsn) {
    throw new Error("A database DSN is required for the isolated migration test");
  }

  const url = new URL(dsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

run("service tier override migration", () => {
  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    admin = null;
  });

  test("backfills concrete legacy tiers into catch-all rules and is idempotent", async () => {
    if (!dsn) return;

    const database = `cch_service_tier_rules_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    admin = postgres(dsn, { max: 1 });
    const isolated = postgres(databaseUrl(database), { max: 1 });
    const migration = findMigrationSql();
    const updateStart = migration.indexOf('UPDATE "providers"');
    if (updateStart < 0) {
      await isolated.end({ timeout: 5 });
      throw new Error("Generated migration does not contain the required backfill");
    }

    const alterSql = migration.slice(0, updateStart).trim();
    const updateSql = migration.slice(updateStart).trim();

    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      await isolated.unsafe(`
        CREATE TABLE "providers" (
          "id" integer PRIMARY KEY,
          "provider_type" varchar(20) NOT NULL,
          "codex_service_tier_preference" varchar(20)
        )
      `);
      await isolated`
        INSERT INTO "providers" ("id", "provider_type", "codex_service_tier_preference")
        VALUES
          (1, 'codex', 'priority'),
          (2, 'codex', 'flex'),
          (3, 'codex', 'inherit'),
          (4, 'codex', NULL),
          (5, 'claude', 'priority'),
          (6, 'codex', 'auto'),
          (7, 'codex', 'default')
      `;

      await isolated.unsafe(alterSql);

      const existingRules = [{ when: {}, overrideServiceTier: null }];
      await isolated`
        INSERT INTO "providers" (
          "id", "provider_type", "codex_service_tier_preference", "service_tier_override_rules"
        )
        VALUES (8, 'codex', 'priority', ${isolated.json(existingRules)})
      `;

      await isolated.unsafe(updateSql);
      const first = await isolated<Row[]>`SELECT * FROM "providers" ORDER BY "id"`;

      const byId = new Map(first.map((row) => [row.id, row.service_tier_override_rules]));
      for (const id of [1, 2, 6, 7]) {
        const row = first.find((candidate) => candidate.id === id);
        expect(byId.get(id)).toEqual(
          convertLegacyCodexServiceTierToRules(row?.codex_service_tier_preference)
        );
      }
      expect(byId.get(3)).toBeNull();
      expect(byId.get(4)).toBeNull();
      expect(byId.get(5)).toBeNull();
      expect(byId.get(8)).toEqual(existingRules);

      await isolated.unsafe(updateSql);
      const second = await isolated<Row[]>`SELECT * FROM "providers" ORDER BY "id"`;
      expect(second).toEqual(first);
    } finally {
      await isolated.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
  });
});
