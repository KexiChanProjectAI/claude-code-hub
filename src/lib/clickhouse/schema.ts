import "server-only";
import { exec, queryJson } from "@/lib/clickhouse/client";
import { type ClickHouseConfig, qualifiedTableName } from "@/lib/clickhouse/config";
import { logger } from "@/lib/logger";

/**
 * 目标表列定义。
 *
 * 同一份定义同时驱动 CREATE TABLE 和 ADD COLUMN IF NOT EXISTS，
 * 这样给已存在的表增列时不会漏掉任何一列。
 */
export const CLICKHOUSE_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "id", type: "UInt64" },
  { name: "created_at", type: "DateTime64(3, 'UTC')" },
  { name: "updated_at", type: "DateTime64(3, 'UTC')" },
  { name: "user_id", type: "UInt32" },
  { name: "user_name", type: "String" },
  { name: "key_id", type: "UInt32" },
  { name: "key_name", type: "String" },
  { name: "client_ip", type: "IPv6" },
  { name: "user_agent", type: "String" },
  { name: "model", type: "LowCardinality(String)" },
  { name: "original_model", type: "LowCardinality(String)" },
  { name: "actual_response_model", type: "LowCardinality(String)" },
  { name: "provider_id", type: "UInt32" },
  { name: "provider_name", type: "LowCardinality(String)" },
  { name: "endpoint", type: "LowCardinality(String)" },
  { name: "api_type", type: "LowCardinality(String)" },
  { name: "session_id", type: "String" },
  { name: "request_sequence", type: "UInt32" },
  { name: "is_replay", type: "UInt8" },
  // 0 表示超过等待上限仍未终态（PG 侧的孤儿行），便于和真实 HTTP 状态区分
  { name: "status_code", type: "UInt16" },
  { name: "blocked_by", type: "LowCardinality(String)" },
  { name: "duration_ms", type: "UInt32" },
  { name: "ttft_ms", type: "UInt32" },
  { name: "input_tokens", type: "UInt64" },
  { name: "output_tokens", type: "UInt64" },
  { name: "cache_read_input_tokens", type: "UInt64" },
  { name: "cache_creation_input_tokens", type: "UInt64" },
  { name: "cost_usd", type: "Decimal(38, 15)" },
  { name: "error_message", type: "String" },
  { name: "synced_at", type: "DateTime DEFAULT now()" },
];

export function buildCreateTableSql(config: ClickHouseConfig): string {
  const columns = CLICKHOUSE_COLUMNS.map((column) => `  ${column.name} ${column.type}`).join(",\n");
  const ttl =
    config.ttlDays === undefined
      ? ""
      : `\nTTL toDateTime(created_at) + INTERVAL ${config.ttlDays} DAY`;

  return `CREATE TABLE IF NOT EXISTS ${qualifiedTableName(config)} (
${columns},
  INDEX idx_client_ip client_ip TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (created_at, id)${ttl}
SETTINGS index_granularity = 8192`;
}

export function buildAddColumnSql(config: ClickHouseConfig, columnIndex: number): string {
  const column = CLICKHOUSE_COLUMNS[columnIndex];
  return `ALTER TABLE ${qualifiedTableName(config)} ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}`;
}

/**
 * 确保库、表与全部列存在。幂等，可在每次成为 leader 后调用。
 *
 * 刻意不执行 MODIFY TTL：那会触发 mutation 重写数据分片，不适合在启动路径上
 * 隐式发生。表已存在但未设置 TTL 时只给出告警和待执行语句，由运维决定。
 */
export async function ensureSchema(config: ClickHouseConfig): Promise<void> {
  await exec(config, `CREATE DATABASE IF NOT EXISTS ${config.database}`);
  await exec(config, buildCreateTableSql(config));

  for (let index = 0; index < CLICKHOUSE_COLUMNS.length; index += 1) {
    await exec(config, buildAddColumnSql(config, index));
  }

  await warnOnMissingTtl(config);
}

async function warnOnMissingTtl(config: ClickHouseConfig): Promise<void> {
  if (config.ttlDays === undefined) {
    return;
  }

  try {
    const rows = await queryJson<{ engine_full?: string }>(
      config,
      `SELECT engine_full FROM system.tables WHERE database = '${config.database}' AND name = '${config.table}'`
    );
    const engineFull = rows[0]?.engine_full ?? "";
    if (engineFull && !engineFull.includes("TTL ")) {
      logger.warn("[ClickHouseSync] Existing table has no TTL; configured TTL was not applied", {
        table: qualifiedTableName(config),
        ttlDays: config.ttlDays,
        applyManually: `ALTER TABLE ${qualifiedTableName(config)} MODIFY TTL toDateTime(created_at) + INTERVAL ${config.ttlDays} DAY`,
      });
    }
  } catch (error) {
    // TTL 巡检失败不影响同步
    logger.debug("[ClickHouseSync] TTL inspection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
