import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";
import {
  convertLegacyAnthropicAdaptiveThinkingToRules,
  convertLegacyCodexReasoningEffortToRules,
} from "@/lib/reasoning-effort-override";

const dsn = process.env.DSN || process.env.DATABASE_URL;
const run = describe.skipIf(!dsn);

type LegacyRow = {
  id: number;
  provider_type: string;
  codex_reasoning_effort_preference: string | null;
  anthropic_adaptive_thinking: unknown;
};

type RulesRow = LegacyRow & {
  reasoning_effort_override_rules: unknown;
};

let admin: ReturnType<typeof postgres> | null = null;

function findMigrationSql(): string {
  const drizzleDirectory = resolve(process.cwd(), "drizzle");
  const migrationFile = readdirSync(drizzleDirectory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => resolve(drizzleDirectory, file))
    .find((file) =>
      readFileSync(file, "utf8").includes(
        'ALTER TABLE "providers" ADD COLUMN "reasoning_effort_override_rules" jsonb'
      )
    );

  if (!migrationFile) {
    throw new Error("Generated reasoning effort override migration was not found");
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

function databaseName(): string {
  return `cch_reasoning_rules_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function dropDatabase(database: string): Promise<void> {
  if (!admin) return;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}

run("reasoning effort override migration", () => {
  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    admin = null;
  });

  test("backfills legacy rules without overwriting data and is idempotent", async () => {
    if (!dsn) return;

    const database = databaseName();
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
          "codex_reasoning_effort_preference" varchar(20),
          "anthropic_adaptive_thinking" jsonb
        )
      `);

      await isolated`
        INSERT INTO "providers" (
          "id",
          "provider_type",
          "codex_reasoning_effort_preference",
          "anthropic_adaptive_thinking"
        )
        VALUES
          (1, 'codex', 'high', NULL),
          (2, 'claude', NULL, ${isolated.json({ effort: "max", modelMatchMode: "all", models: [] })}),
          (3, 'claude-auth', NULL, ${isolated.json({
            effort: "high",
            modelMatchMode: "specific",
            models: ["claude-opus-4-1"],
          })}),
          (4, 'claude', NULL, ${isolated.json({ effort: "medium", modelMatchMode: "specific", models: [] })}),
          (5, 'codex', 'inherit', NULL)
      `;

      const legacyBefore = await isolated<LegacyRow[]>`
        SELECT
          "id",
          "provider_type",
          "codex_reasoning_effort_preference",
          "anthropic_adaptive_thinking"
        FROM "providers"
        ORDER BY "id"
      `;

      await isolated.unsafe(alterSql);

      const populatedRules = [
        {
          when: { originalReasoningEffort: null },
          overrideEffort: "low",
        },
      ];
      await isolated`
        INSERT INTO "providers" (
          "id",
          "provider_type",
          "codex_reasoning_effort_preference",
          "anthropic_adaptive_thinking",
          "reasoning_effort_override_rules"
        )
        VALUES (
          6,
          'codex',
          'none',
          NULL,
          ${isolated.json(populatedRules)}
        )
      `;

      await isolated.unsafe(updateSql);

      const rowsAfterFirstRun = await isolated<RulesRow[]>`
        SELECT
          "id",
          "provider_type",
          "codex_reasoning_effort_preference",
          "anthropic_adaptive_thinking",
          "reasoning_effort_override_rules"
        FROM "providers"
        ORDER BY "id"
      `;

      expect(rowsAfterFirstRun.map((row) => row.reasoning_effort_override_rules)).toStrictEqual([
        convertLegacyCodexReasoningEffortToRules("high"),
        convertLegacyAnthropicAdaptiveThinkingToRules({
          effort: "max",
          modelMatchMode: "all",
          models: [],
        }),
        convertLegacyAnthropicAdaptiveThinkingToRules({
          effort: "high",
          modelMatchMode: "specific",
          models: ["claude-opus-4-1"],
        }),
        convertLegacyAnthropicAdaptiveThinkingToRules({
          effort: "medium",
          modelMatchMode: "specific",
          models: [],
        }),
        null,
        populatedRules,
      ]);
      expect(rowsAfterFirstRun.slice(0, 5).map(toLegacyRow)).toEqual(legacyBefore);

      await isolated.unsafe(updateSql);

      const rowsAfterSecondRun = await isolated<RulesRow[]>`
        SELECT
          "id",
          "provider_type",
          "codex_reasoning_effort_preference",
          "anthropic_adaptive_thinking",
          "reasoning_effort_override_rules"
        FROM "providers"
        ORDER BY "id"
      `;

      expect(rowsAfterSecondRun).toStrictEqual(rowsAfterFirstRun);
    } finally {
      await isolated.end({ timeout: 5 });
      await dropDatabase(database);
    }
  });
});

function toLegacyRow(row: RulesRow): LegacyRow {
  return {
    id: row.id,
    provider_type: row.provider_type,
    codex_reasoning_effort_preference: row.codex_reasoning_effort_preference,
    anthropic_adaptive_thinking: row.anthropic_adaptive_thinking,
  };
}
