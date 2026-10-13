import "server-only";

import { logger } from "@/lib/logger";
import type { UpstreamGzipRecord } from "@/types/upstream-gzip";
import { getRedisClient } from "./client";

/** 与进程内 "supported" 缓存的最长 TTL 对齐；过期即回到 unknown。 */
const STATE_TTL_SECONDS = 24 * 60 * 60;

type Direction = keyof UpstreamGzipRecord;

export function getUpstreamGzipStateKey(providerId: number): string {
  return `upstream_gzip:state:${providerId}`;
}

function getClient() {
  return getRedisClient({ allowWhenRateLimitDisabled: true });
}

function parseField<D extends Direction>(
  direction: D,
  raw: string | undefined
): UpstreamGzipRecord[D] | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { state?: unknown; updatedAt?: unknown };
    if (typeof value.updatedAt !== "number" || typeof value.state !== "string") return undefined;
    const allowed =
      direction === "request" ? ["supported", "unsupported"] : ["compressed", "uncompressed"];
    if (!allowed.includes(value.state)) return undefined;
    return { state: value.state, updatedAt: value.updatedAt } as UpstreamGzipRecord[D];
  } catch {
    return undefined;
  }
}

/** 记录某个方向的最新观测。只在状态变化时由调用方触发，失败仅记日志。 */
export async function saveUpstreamGzipObservation<D extends Direction>(
  providerId: number,
  direction: D,
  observation: NonNullable<UpstreamGzipRecord[D]>
): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  const key = getUpstreamGzipStateKey(providerId);
  try {
    await redis
      .pipeline()
      .hset(key, direction, JSON.stringify(observation))
      .expire(key, STATE_TTL_SECONDS)
      .exec();
  } catch (error) {
    logger.warn("[UpstreamGzipState] Failed to save to Redis", {
      providerId,
      direction,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 批量读取；Redis 不可用或失败时返回空 Map（调用方回退到进程内快照）。 */
export async function loadUpstreamGzipStates(
  providerIds: number[]
): Promise<Map<number, UpstreamGzipRecord>> {
  const result = new Map<number, UpstreamGzipRecord>();
  const redis = getClient();
  if (!redis || providerIds.length === 0) return result;
  try {
    const pipeline = redis.pipeline();
    for (const id of providerIds) pipeline.hgetall(getUpstreamGzipStateKey(id));
    const replies = (await pipeline.exec()) ?? [];
    replies.forEach(([error, value], index) => {
      if (error || !value || typeof value !== "object") return;
      const hash = value as Record<string, string>;
      const record: UpstreamGzipRecord = {
        request: parseField("request", hash.request),
        response: parseField("response", hash.response),
      };
      if (record.request || record.response) result.set(providerIds[index], record);
    });
  } catch (error) {
    logger.warn("[UpstreamGzipState] Failed to load from Redis", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}
