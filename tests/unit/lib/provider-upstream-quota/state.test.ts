import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const redisState = vi.hoisted(() => ({
  available: true,
  store: new Map<number, UpstreamQuotaSnapshot>(),
  loadUpstreamQuotaState: vi.fn(),
  saveUpstreamQuotaState: vi.fn(),
  deleteUpstreamQuotaState: vi.fn(),
}));
vi.mock("@/lib/redis/upstream-quota-state", () => ({
  loadUpstreamQuotaState: redisState.loadUpstreamQuotaState,
  saveUpstreamQuotaState: redisState.saveUpstreamQuotaState,
  deleteUpstreamQuotaState: redisState.deleteUpstreamQuotaState,
}));

const repo = vi.hoisted(() => ({
  upsertProviderUpstreamQuotaSnapshot: vi.fn(async () => undefined),
  deleteProviderUpstreamQuotaSnapshot: vi.fn(async () => undefined),
}));
vi.mock("@/repository/provider-upstream-quota", () => repo);

import {
  clearUpstreamQuotaState,
  getUpstreamQuotaSnapshotCached,
  getUpstreamQuotaSnapshotFresh,
  markProviderUpstreamQuotaExhausted,
  resetUpstreamQuotaCacheForTests,
  seedUpstreamQuotaSnapshot,
  storeUpstreamQuotaSnapshot,
} from "@/lib/provider-upstream-quota/state";

function snapshot(overrides: Partial<UpstreamQuotaSnapshot> = {}): UpstreamQuotaSnapshot {
  return {
    providerId: 1,
    probeType: "kimi-coding",
    windows: [{ window: "5h", usedPercent: 10, resetAt: null }],
    planLevel: null,
    credentialValid: true,
    lastError: null,
    lastErrorStatus: null,
    fetchedAt: 1_000,
    probedAt: 1_000,
    reactivePauseUntil: null,
    reactivePauseReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetUpstreamQuotaCacheForTests();
  redisState.available = true;
  redisState.store.clear();
  redisState.loadUpstreamQuotaState.mockImplementation(async (id: number) =>
    redisState.available ? (redisState.store.get(id) ?? null) : undefined
  );
  redisState.saveUpstreamQuotaState.mockImplementation(async (snap: UpstreamQuotaSnapshot) => {
    if (!redisState.available) return false;
    redisState.store.set(snap.providerId, snap);
    return true;
  });
  redisState.deleteUpstreamQuotaState.mockImplementation(async (id: number) => {
    redisState.store.delete(id);
  });
});

describe("upstream quota state", () => {
  test("caches Redis reads for a short TTL, including misses", async () => {
    vi.useFakeTimers();
    expect(await getUpstreamQuotaSnapshotCached(1)).toBeNull();
    redisState.store.set(1, snapshot());
    expect(await getUpstreamQuotaSnapshotCached(1)).toBeNull();
    expect(redisState.loadUpstreamQuotaState).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);
    expect(await getUpstreamQuotaSnapshotCached(1)).toMatchObject({ providerId: 1 });
    expect(redisState.loadUpstreamQuotaState).toHaveBeenCalledTimes(2);
  });

  test("store writes the local cache, Redis and the DB", async () => {
    const snap = snapshot({ providerId: 2 });
    await storeUpstreamQuotaSnapshot(snap);
    expect(redisState.store.get(2)).toEqual(snap);
    expect(repo.upsertProviderUpstreamQuotaSnapshot).toHaveBeenCalledWith(snap);
    expect(await getUpstreamQuotaSnapshotCached(2)).toEqual(snap);
    expect(redisState.loadUpstreamQuotaState).not.toHaveBeenCalled();
  });

  test("DB failures are swallowed and persistToDb=false skips the DB", async () => {
    repo.upsertProviderUpstreamQuotaSnapshot.mockRejectedValueOnce(new Error("db down"));
    await expect(storeUpstreamQuotaSnapshot(snapshot())).resolves.toBeUndefined();
    await storeUpstreamQuotaSnapshot(snapshot({ providerId: 3 }), { persistToDb: false });
    expect(repo.upsertProviderUpstreamQuotaSnapshot).toHaveBeenCalledTimes(1);
  });

  test("falls back to the in-memory store when Redis is unavailable", async () => {
    redisState.available = false;
    const snap = snapshot({ providerId: 4 });
    await storeUpstreamQuotaSnapshot(snap);
    resetUpstreamQuotaCacheForTests();
    expect(await getUpstreamQuotaSnapshotCached(4)).toBeNull();
    await storeUpstreamQuotaSnapshot(snap);
    expect(await getUpstreamQuotaSnapshotFresh(4)).toEqual(snap);
  });

  test("seed only fills a missing Redis entry", async () => {
    const existing = snapshot({ providerId: 5, planLevel: "redis" });
    redisState.store.set(5, existing);
    await seedUpstreamQuotaSnapshot(snapshot({ providerId: 5, planLevel: "db" }));
    expect(redisState.store.get(5)?.planLevel).toBe("redis");

    await seedUpstreamQuotaSnapshot(snapshot({ providerId: 6, planLevel: "db" }));
    expect(redisState.store.get(6)?.planLevel).toBe("db");
    expect(repo.upsertProviderUpstreamQuotaSnapshot).not.toHaveBeenCalled();
  });

  test("marking exhausted keeps window data and never shortens a pause", async () => {
    redisState.store.set(
      1,
      snapshot({ reactivePauseUntil: 9_000, reactivePauseReason: "probe_402" })
    );
    const marked = await markProviderUpstreamQuotaExhausted(1, {
      untilMs: 5_000,
      reason: "reactive_402",
      now: 2_000,
      message: "reactive_402: HTTP 402",
    });
    expect(marked).toMatchObject({
      windows: [{ window: "5h", usedPercent: 10, resetAt: null }],
      reactivePauseUntil: 9_000,
      reactivePauseReason: "reactive_402",
      lastError: "reactive_402: HTTP 402",
    });

    const fresh = await markProviderUpstreamQuotaExhausted(8, {
      untilMs: 5_000,
      reason: "reactive_429_balance",
      now: 2_000,
    });
    expect(fresh).toMatchObject({
      providerId: 8,
      probeType: null,
      windows: [],
      fetchedAt: null,
      probedAt: 2_000,
      reactivePauseUntil: 5_000,
    });
  });

  test("clear removes every layer and tolerates DB errors", async () => {
    await storeUpstreamQuotaSnapshot(snapshot({ providerId: 9 }));
    repo.deleteProviderUpstreamQuotaSnapshot.mockRejectedValueOnce(new Error("db down"));
    await clearUpstreamQuotaState(9);
    expect(redisState.store.has(9)).toBe(false);
    expect(await getUpstreamQuotaSnapshotCached(9)).toBeNull();
  });
});
