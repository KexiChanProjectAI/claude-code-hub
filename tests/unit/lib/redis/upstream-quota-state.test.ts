import { beforeEach, describe, expect, test, vi } from "vitest";

const redis = vi.hoisted(() => ({
  client: null as null | {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  },
  getRedisClient: vi.fn(),
}));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: redis.getRedisClient }));

import {
  deleteUpstreamQuotaState,
  getUpstreamQuotaStateKey,
  isUpstreamQuotaRedisAvailable,
  loadUpstreamQuotaState,
  saveUpstreamQuotaState,
} from "@/lib/redis/upstream-quota-state";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const snapshot: UpstreamQuotaSnapshot = {
  providerId: 4,
  probeType: "minimax-coding",
  windows: [{ window: "5h", usedPercent: 20, resetAt: 99 }],
  planLevel: "Plus",
  credentialValid: true,
  lastError: null,
  lastErrorStatus: null,
  fetchedAt: 10,
  probedAt: 10,
  reactivePauseUntil: null,
  reactivePauseReason: null,
};

beforeEach(() => {
  const store = new Map<string, string>();
  redis.client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
  redis.getRedisClient.mockImplementation(() => redis.client);
});

describe("upstream quota Redis state", () => {
  test("round-trips a snapshot with a TTL", async () => {
    expect(isUpstreamQuotaRedisAvailable()).toBe(true);
    expect(await saveUpstreamQuotaState(snapshot)).toBe(true);
    expect(redis.client?.set).toHaveBeenCalledWith(
      getUpstreamQuotaStateKey(4),
      JSON.stringify(snapshot),
      "EX",
      7 * 24 * 60 * 60
    );
    expect(await loadUpstreamQuotaState(4)).toEqual(snapshot);
    expect(redis.getRedisClient).toHaveBeenCalledWith({ allowWhenRateLimitDisabled: true });
  });

  test("normalizes partial or invalid payloads", async () => {
    await redis.client?.set(getUpstreamQuotaStateKey(5), JSON.stringify({ probedAt: 1 }));
    expect(await loadUpstreamQuotaState(5)).toEqual({
      providerId: 5,
      probeType: null,
      windows: [],
      planLevel: null,
      credentialValid: true,
      lastError: null,
      lastErrorStatus: null,
      fetchedAt: null,
      probedAt: 1,
      reactivePauseUntil: null,
      reactivePauseReason: null,
    });
    await redis.client?.set(getUpstreamQuotaStateKey(6), JSON.stringify({ windows: [] }));
    expect(await loadUpstreamQuotaState(6)).toBeNull();
    expect(await loadUpstreamQuotaState(7)).toBeNull();
  });

  test("returns undefined or false when Redis is missing or failing", async () => {
    redis.getRedisClient.mockReturnValue(null);
    expect(isUpstreamQuotaRedisAvailable()).toBe(false);
    expect(await loadUpstreamQuotaState(4)).toBeUndefined();
    expect(await saveUpstreamQuotaState(snapshot)).toBe(false);
    await expect(deleteUpstreamQuotaState(4)).resolves.toBeUndefined();

    redis.getRedisClient.mockImplementation(() => redis.client);
    redis.client?.get.mockRejectedValueOnce(new Error("down"));
    expect(await loadUpstreamQuotaState(4)).toBeUndefined();
    redis.client?.set.mockRejectedValueOnce(new Error("down"));
    expect(await saveUpstreamQuotaState(snapshot)).toBe(false);
    redis.client?.del.mockRejectedValueOnce(new Error("down"));
    await expect(deleteUpstreamQuotaState(4)).resolves.toBeUndefined();
  });

  test("deletes the key", async () => {
    await saveUpstreamQuotaState(snapshot);
    await deleteUpstreamQuotaState(4);
    expect(await loadUpstreamQuotaState(4)).toBeNull();
  });
});
