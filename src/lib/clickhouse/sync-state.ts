import "server-only";
import { queryJson } from "@/lib/clickhouse/client";
import {
  type ClickHouseConfig,
  getClickHouseConfig,
  isClickHouseSyncEnabled,
  qualifiedTableName,
} from "@/lib/clickhouse/config";
import { findCursorBefore, getMaxId } from "@/lib/clickhouse/source";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";

const REDIS_KEYS = {
  /** 同步进度: clickhouse_sync:state */
  state: () => "clickhouse_sync:state",
};

/**
 * 同步进度。
 *
 * - cursor: 已扫描到的最大 message_request.id（该 id 及之前的行不会再被扫描）
 * - pending: 游标已越过、但当时还不可发送的行（长流式请求尚未终态/未静置）
 */
export interface SyncState {
  cursor: number;
  pending: number[];
}

export class SyncStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncStateUnavailableError";
  }
}

function requireRedis() {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") {
    throw new SyncStateUnavailableError("Redis unavailable for ClickHouse sync state");
  }
  return redis;
}

function isValidState(value: unknown): value is SyncState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { cursor?: unknown; pending?: unknown };
  return (
    typeof candidate.cursor === "number" &&
    Number.isFinite(candidate.cursor) &&
    Array.isArray(candidate.pending) &&
    candidate.pending.every((id) => typeof id === "number" && Number.isFinite(id))
  );
}

export async function readState(): Promise<SyncState | null> {
  const raw = await requireRedis().get(REDIS_KEYS.state());
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isValidState(parsed)) {
      return { cursor: parsed.cursor, pending: parsed.pending };
    }
  } catch {
    // 落到下面的告警：状态不可解析时按"无状态"处理并走恢复流程
  }

  logger.warn("[ClickHouseSync] Discarding unreadable sync state");
  return null;
}

export async function writeState(state: SyncState): Promise<void> {
  await requireRedis().set(REDIS_KEYS.state(), JSON.stringify(state));
}

/**
 * ClickHouse 中已有数据的最新 created_at（毫秒）；表为空时返回 null。
 */
async function readClickHouseWatermark(config: ClickHouseConfig): Promise<number | null> {
  const rows = await queryJson<{ cnt: string | number; max_ms: string | number }>(
    config,
    `SELECT count() AS cnt, toUnixTimestamp64Milli(max(created_at)) AS max_ms FROM ${qualifiedTableName(config)}`
  );

  const row = rows[0];
  if (!row || Number(row.cnt) <= 0) {
    return null;
  }

  const maxMs = Number(row.max_ms);
  return Number.isFinite(maxMs) && maxMs > 0 ? maxMs : null;
}

/**
 * 决定起始进度。
 *
 * 1. Redis 里有状态 -> 直接沿用
 * 2. 状态丢失但 ClickHouse 已有数据 -> 从"最新数据时间 - 最长等待窗口"回看重扫，
 *    重复写入由 ReplacingMergeTree 合并
 * 3. 两边都是空的 -> 从当前最大 id 开始，不回填历史
 */
export async function resolveInitialState(config: ClickHouseConfig): Promise<SyncState> {
  const existing = await readState();
  if (existing) {
    return existing;
  }

  const watermarkMs = await readClickHouseWatermark(config);

  if (watermarkMs === null) {
    const maxId = await getMaxId();
    logger.info("[ClickHouseSync] No prior state or data; starting from current tail", {
      cursor: maxId,
    });
    return { cursor: maxId, pending: [] };
  }

  const since = new Date(watermarkMs - config.maxPendingAgeMs);
  const cursor = await findCursorBefore(since);
  logger.warn("[ClickHouseSync] Sync state lost; recovering from ClickHouse watermark", {
    watermark: new Date(watermarkMs).toISOString(),
    rescanFrom: since.toISOString(),
    cursor,
  });
  return { cursor, pending: [] };
}

/**
 * 计算同步围栏：id 不大于该值的行都已经进入 ClickHouse，可以安全地从 PG 删除。
 *
 * - 未启用同步 -> null（调用方保持原有行为）
 * - 启用但进度不可读 -> 抛错（调用方必须中止删除，宁可多留数据）
 */
export async function getClickHouseSyncFence(): Promise<number | null> {
  if (!isClickHouseSyncEnabled()) {
    return null;
  }

  const config = getClickHouseConfig();
  if (!config) {
    return null;
  }

  const state = await readState();
  if (!state) {
    throw new SyncStateUnavailableError(
      "ClickHouse sync is enabled but sync progress is unknown; refusing to compute cleanup fence"
    );
  }

  if (state.pending.length === 0) {
    return state.cursor;
  }

  return Math.min(state.cursor, Math.min(...state.pending) - 1);
}
