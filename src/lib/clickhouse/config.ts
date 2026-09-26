import "server-only";
import { getEnvConfig } from "@/lib/config/env.schema";

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
  database: string;
  table: string;
  ttlDays?: number;
  requestTimeoutMs: number;
  syncIntervalMs: number;
  syncBatchSize: number;
  syncSettleMs: number;
  maxPendingAgeMs: number;
}

/**
 * 是否启用 ClickHouse 请求日志同步。
 * 仿 isLangfuseEnabled：由凭据（这里是 URL）的存在与否决定，不额外引入开关变量。
 */
export function isClickHouseSyncEnabled(): boolean {
  return !!getEnvConfig().CLICKHOUSE_URL;
}

/**
 * 读取 ClickHouse 配置；未配置 CLICKHOUSE_URL 时返回 null。
 * 库名/表名已在 env schema 里做过标识符白名单校验，可以安全拼进 SQL。
 */
export function getClickHouseConfig(): ClickHouseConfig | null {
  const env = getEnvConfig();
  if (!env.CLICKHOUSE_URL) {
    return null;
  }

  return {
    url: env.CLICKHOUSE_URL.replace(/\/+$/, ""),
    user: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DATABASE,
    table: env.CLICKHOUSE_TABLE,
    ttlDays: env.CLICKHOUSE_TTL_DAYS,
    requestTimeoutMs: env.CLICKHOUSE_REQUEST_TIMEOUT_MS,
    syncIntervalMs: env.CLICKHOUSE_SYNC_INTERVAL_MS,
    syncBatchSize: env.CLICKHOUSE_SYNC_BATCH_SIZE,
    syncSettleMs: env.CLICKHOUSE_SYNC_SETTLE_MS,
    maxPendingAgeMs: env.CLICKHOUSE_SYNC_MAX_PENDING_AGE_MS,
  };
}

/**
 * 完整限定的目标表名，用于拼接 DDL / INSERT。
 */
export function qualifiedTableName(config: ClickHouseConfig): string {
  return `${config.database}.${config.table}`;
}
