import "server-only";

import { logger } from "@/lib/logger";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";
import { getRedisClient } from "./client";

/** Snapshots stay in Redis for a week; freshness is judged by fetchedAt, not key TTL. */
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

export function getUpstreamQuotaStateKey(providerId: number): string {
  return `upstream_quota:state:${providerId}`;
}

function getClient() {
  return getRedisClient({ allowWhenRateLimitDisabled: true });
}

export function isUpstreamQuotaRedisAvailable(): boolean {
  return getClient() !== null;
}

function normalizeSnapshot(providerId: number, raw: unknown): UpstreamQuotaSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<UpstreamQuotaSnapshot>;
  if (typeof value.probedAt !== "number") return null;
  return {
    providerId,
    probeType: value.probeType ?? null,
    windows: Array.isArray(value.windows) ? value.windows : [],
    planLevel: value.planLevel ?? null,
    credentialValid: value.credentialValid !== false,
    lastError: value.lastError ?? null,
    lastErrorStatus: value.lastErrorStatus ?? null,
    fetchedAt: typeof value.fetchedAt === "number" ? value.fetchedAt : null,
    probedAt: value.probedAt,
    reactivePauseUntil:
      typeof value.reactivePauseUntil === "number" ? value.reactivePauseUntil : null,
    reactivePauseReason: value.reactivePauseReason ?? null,
  };
}

/**
 * Load a snapshot.
 * Returns undefined when Redis is unavailable or failed (caller should fall back),
 * null when Redis has no entry.
 */
export async function loadUpstreamQuotaState(
  providerId: number
): Promise<UpstreamQuotaSnapshot | null | undefined> {
  const redis = getClient();
  if (!redis) return undefined;
  try {
    const raw = await redis.get(getUpstreamQuotaStateKey(providerId));
    if (!raw) return null;
    return normalizeSnapshot(providerId, JSON.parse(raw));
  } catch (error) {
    logger.warn("[UpstreamQuotaState] Failed to load from Redis", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function saveUpstreamQuotaState(snapshot: UpstreamQuotaSnapshot): Promise<boolean> {
  const redis = getClient();
  if (!redis) return false;
  try {
    await redis.set(
      getUpstreamQuotaStateKey(snapshot.providerId),
      JSON.stringify(snapshot),
      "EX",
      STATE_TTL_SECONDS
    );
    return true;
  } catch (error) {
    logger.warn("[UpstreamQuotaState] Failed to save to Redis", {
      providerId: snapshot.providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deleteUpstreamQuotaState(providerId: number): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(getUpstreamQuotaStateKey(providerId));
  } catch (error) {
    logger.warn("[UpstreamQuotaState] Failed to delete from Redis", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
