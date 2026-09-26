import "server-only";
import { eq, isNotNull, lt, or, type SQL } from "drizzle-orm";
import { messageRequest } from "@/drizzle/schema";
import { queryJson } from "@/lib/clickhouse/client";
import {
  type ClickHouseConfig,
  getClickHouseConfig,
  isClickHouseSyncEnabled,
  qualifiedTableName,
} from "@/lib/clickhouse/config";
import { readClickHouseFloor, writeClickHouseFloorIfAbsent } from "@/lib/clickhouse/source";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";

/**
 * 同步进度模型
 *
 * 进度记录在每一行自己身上（message_request.clickhouse_synced_at），而不是一个 id 游标：
 * async INSERT 模式下预留的 id 可能在数小时后才被使用，"游标以下都已同步"这一假设不成立。
 *
 * 唯一的全局状态是同步范围下界 floor（clickhouse_sync_state.floor_at）：
 * created_at 早于它的行属于启用同步之前的历史，不回填、也不阻止日志清理。
 * 下界存放在 PostgreSQL，首次初始化后不再自动修改。
 */

/** 旧版 id 游标进度的 Redis 键，仅用于升级后清理 */
const LEGACY_REDIS_STATE_KEY = "clickhouse_sync:state";

export class SyncStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncStateUnavailableError";
  }
}

/**
 * ClickHouse 中已有数据的最早 created_at（毫秒）；表为空时返回 null。
 */
async function readClickHouseEarliest(config: ClickHouseConfig): Promise<number | null> {
  const rows = await queryJson<{ cnt: string | number; min_ms: string | number }>(
    config,
    `SELECT count() AS cnt, toUnixTimestamp64Milli(min(created_at)) AS min_ms FROM ${qualifiedTableName(config)}`
  );

  const row = rows[0];
  if (!row || Number(row.cnt) <= 0) {
    return null;
  }

  const minMs = Number(row.min_ms);
  return Number.isFinite(minMs) && minMs > 0 ? minMs : null;
}

/** 升级后删除旧版游标进度；失败无害（它已不再被读取） */
async function dropLegacyRedisState(): Promise<void> {
  try {
    const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (redis?.status === "ready") {
      await redis.del(LEGACY_REDIS_STATE_KEY);
    }
  } catch {
    // 忽略：旧键残留不影响正确性
  }
}

/**
 * 决定同步范围下界。
 *
 * 1. PostgreSQL 已有下界 -> 直接沿用
 * 2. ClickHouse 已有数据 -> 取其最早 created_at：已在 ClickHouse 覆盖范围内、却缺少同步标记的行
 *    （包括旧版游标漏掉的行）会被重新发送，重复由 ReplacingMergeTree 合并
 * 3. ClickHouse 为空 -> now - maxPendingAgeMs：不回填历史，但覆盖正在进行中的请求
 *    （created_at 已打上、尚未提交或尚未终态的行）
 *
 * 写入采用"不存在才写"，多个 leader 并发初始化时以库里的值为准。
 */
export async function resolveFloor(config: ClickHouseConfig): Promise<Date> {
  const existing = await readClickHouseFloor();
  if (existing) {
    return existing;
  }

  const earliestMs = await readClickHouseEarliest(config);
  const candidate =
    earliestMs === null ? new Date(Date.now() - config.maxPendingAgeMs) : new Date(earliestMs);

  const floor = await writeClickHouseFloorIfAbsent(candidate);
  await dropLegacyRedisState();

  logger.info("[ClickHouseSync] Initialized sync scope floor", {
    floor: floor.toISOString(),
    source: earliestMs === null ? "empty_clickhouse" : "clickhouse_earliest",
  });
  return floor;
}

/**
 * 日志清理的同步围栏：返回一个附加到删除条件上的 SQL 谓词，只放行已经同步
 * 或不在同步范围内的行。
 *
 * - 未启用同步 -> null（调用方保持原有行为）
 * - 启用但下界尚未初始化 -> 抛错（调用方必须中止删除，宁可多留数据）
 * - 否则：已同步 OR 已软删除 OR warmup OR created_at 早于下界
 *
 * 尚未确认进入 ClickHouse 的范围内行，无论 id 大小都不会被删除。
 */
export async function getClickHouseCleanupCondition(): Promise<SQL | null> {
  if (!isClickHouseSyncEnabled()) {
    return null;
  }

  const config = getClickHouseConfig();
  if (!config) {
    return null;
  }

  const floor = await readClickHouseFloor();
  if (!floor) {
    throw new SyncStateUnavailableError(
      "ClickHouse sync is enabled but its scope floor is not initialized; refusing to compute cleanup fence"
    );
  }

  return or(
    isNotNull(messageRequest.clickhouseSyncedAt),
    isNotNull(messageRequest.deletedAt),
    eq(messageRequest.blockedBy, "warmup"),
    lt(messageRequest.createdAt, floor)
  ) as SQL;
}
