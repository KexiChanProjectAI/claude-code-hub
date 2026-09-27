import "server-only";

import { TTLMap } from "@/lib/cache/ttl-map";
import { logger } from "@/lib/logger";
import {
  deleteUpstreamQuotaState,
  loadUpstreamQuotaState,
  saveUpstreamQuotaState,
} from "@/lib/redis/upstream-quota-state";
import {
  deleteProviderUpstreamQuotaSnapshot,
  upsertProviderUpstreamQuotaSnapshot,
} from "@/repository/provider-upstream-quota";
import type { UpstreamQuotaPauseReason, UpstreamQuotaSnapshot } from "@/types/upstream-quota";

/** Hot-path cache: each process re-reads Redis at most once per provider per TTL. */
const LOCAL_CACHE_TTL_MS = 5_000;

const localCache = new TTLMap<number, UpstreamQuotaSnapshot | null>({
  ttlMs: LOCAL_CACHE_TTL_MS,
  maxSize: 10_000,
});

/** Fallback store used when Redis is unavailable (single-process deployments). */
const memoryStore = new Map<number, UpstreamQuotaSnapshot>();

export async function getUpstreamQuotaSnapshotCached(
  providerId: number
): Promise<UpstreamQuotaSnapshot | null> {
  if (localCache.has(providerId)) {
    return localCache.get(providerId) ?? null;
  }
  const loaded = await loadUpstreamQuotaState(providerId);
  const snapshot = loaded === undefined ? (memoryStore.get(providerId) ?? null) : loaded;
  localCache.set(providerId, snapshot);
  return snapshot;
}

/** Read the latest snapshot bypassing the local cache (used by write paths). */
export async function getUpstreamQuotaSnapshotFresh(
  providerId: number
): Promise<UpstreamQuotaSnapshot | null> {
  const loaded = await loadUpstreamQuotaState(providerId);
  return loaded === undefined ? (memoryStore.get(providerId) ?? null) : loaded;
}

/**
 * Persist a snapshot to the local cache, Redis (hot path) and PostgreSQL (UI and restarts).
 * DB failures are logged and never propagate.
 */
export async function storeUpstreamQuotaSnapshot(
  snapshot: UpstreamQuotaSnapshot,
  options: { persistToDb?: boolean } = {}
): Promise<void> {
  memoryStore.set(snapshot.providerId, snapshot);
  localCache.set(snapshot.providerId, snapshot);
  await saveUpstreamQuotaState(snapshot);
  if (options.persistToDb === false) return;
  try {
    await upsertProviderUpstreamQuotaSnapshot(snapshot);
  } catch (error) {
    logger.warn("[UpstreamQuota] Failed to persist snapshot", {
      providerId: snapshot.providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Seed Redis from a DB snapshot without writing it back to the DB. */
export async function seedUpstreamQuotaSnapshot(snapshot: UpstreamQuotaSnapshot): Promise<void> {
  const existing = await loadUpstreamQuotaState(snapshot.providerId);
  if (existing) return;
  await storeUpstreamQuotaSnapshot(snapshot, { persistToDb: false });
}

/**
 * Reactively mark a provider as out of upstream quota until `untilMs`.
 * Keeps any existing window data; a later healthy probe clears the pause.
 */
export async function markProviderUpstreamQuotaExhausted(
  providerId: number,
  input: { untilMs: number; reason: UpstreamQuotaPauseReason; now?: number; message?: string }
): Promise<UpstreamQuotaSnapshot> {
  const now = input.now ?? Date.now();
  const existing = await getUpstreamQuotaSnapshotFresh(providerId);
  const next: UpstreamQuotaSnapshot = {
    providerId,
    probeType: existing?.probeType ?? null,
    windows: existing?.windows ?? [],
    planLevel: existing?.planLevel ?? null,
    credentialValid: existing?.credentialValid ?? true,
    lastError: input.message ?? existing?.lastError ?? null,
    lastErrorStatus: existing?.lastErrorStatus ?? null,
    fetchedAt: existing?.fetchedAt ?? null,
    probedAt: existing?.probedAt ?? now,
    reactivePauseUntil: Math.max(input.untilMs, existing?.reactivePauseUntil ?? 0),
    reactivePauseReason: input.reason,
  };
  await storeUpstreamQuotaSnapshot(next);
  return next;
}

/** Drop all state for a provider (deleted, or key/url changed). */
export async function clearUpstreamQuotaState(providerId: number): Promise<void> {
  memoryStore.delete(providerId);
  localCache.delete(providerId);
  await deleteUpstreamQuotaState(providerId);
  try {
    await deleteProviderUpstreamQuotaSnapshot(providerId);
  } catch (error) {
    logger.warn("[UpstreamQuota] Failed to delete snapshot", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resetUpstreamQuotaCacheForTests(): void {
  localCache.clear();
  memoryStore.clear();
}
