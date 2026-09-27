import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const settings = vi.hoisted(() => ({
  value: { enabled: true, thresholdPercent: 10, intervalMinutes: 10 },
}));
vi.mock("@/lib/provider-upstream-quota/settings", () => ({
  getUpstreamQuotaSettings: vi.fn(async () => settings.value),
}));

const stateMocks = vi.hoisted(() => ({
  getUpstreamQuotaSnapshotCached: vi.fn(async () => null as UpstreamQuotaSnapshot | null),
  markProviderUpstreamQuotaExhausted: vi.fn(async () => ({}) as never),
}));
vi.mock("@/lib/provider-upstream-quota/state", () => stateMocks);

import {
  checkProviderUpstreamQuota,
  maybeMarkUpstreamQuotaExhausted,
} from "@/lib/provider-upstream-quota/verdict";

const kimi = { id: 1, name: "kimi", url: "https://api.kimi.com/coding/v1" };
const relay = { id: 2, name: "relay", url: "https://relay.example.com/v1" };
const deepseek = { id: 3, name: "ds", url: "https://api.deepseek.com" };

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = { enabled: true, thresholdPercent: 10, intervalMinutes: 10 };
});

describe("checkProviderUpstreamQuota", () => {
  test("short-circuits when disabled or untracked", async () => {
    settings.value = { ...settings.value, enabled: false };
    expect(await checkProviderUpstreamQuota(kimi)).toEqual({ status: "ok", reason: "disabled" });
    settings.value = { ...settings.value, enabled: true };
    expect(await checkProviderUpstreamQuota(relay)).toEqual({
      status: "ok",
      reason: "not_applicable",
    });
    expect(stateMocks.getUpstreamQuotaSnapshotCached).not.toHaveBeenCalled();
  });

  test("evaluates the cached snapshot", async () => {
    const now = 10_000_000;
    stateMocks.getUpstreamQuotaSnapshotCached.mockResolvedValueOnce({
      providerId: 1,
      probeType: "kimi-coding",
      windows: [{ window: "5h", usedPercent: 95, resetAt: null }],
      planLevel: null,
      credentialValid: true,
      lastError: null,
      lastErrorStatus: null,
      fetchedAt: now - 1_000,
      probedAt: now - 1_000,
      reactivePauseUntil: null,
      reactivePauseReason: null,
    });
    expect(await checkProviderUpstreamQuota(kimi, { now })).toMatchObject({
      status: "low",
      remainingPercent: 5,
    });
  });

  test("fails open when the lookup throws", async () => {
    stateMocks.getUpstreamQuotaSnapshotCached.mockRejectedValueOnce(new Error("boom"));
    expect(await checkProviderUpstreamQuota(kimi)).toEqual({
      status: "unknown",
      reason: "no_snapshot",
    });
  });
});

describe("maybeMarkUpstreamQuotaExhausted", () => {
  test("marks tracked providers on 402 and balance 429s", async () => {
    expect(await maybeMarkUpstreamQuotaExhausted(deepseek, { statusCode: 402 })).toBe(true);
    expect(stateMocks.markProviderUpstreamQuotaExhausted).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ reason: "reactive_402", message: "reactive_402: HTTP 402" })
    );
    const [, input] = stateMocks.markProviderUpstreamQuotaExhausted.mock.calls[0] as unknown as [
      number,
      { untilMs: number; now: number },
    ];
    expect(input.untilMs - input.now).toBe(20 * 60_000);

    expect(
      await maybeMarkUpstreamQuotaExhausted(kimi, {
        statusCode: 429,
        upstreamError: { body: '{"error":{"message":"余额不足"}}' },
      })
    ).toBe(true);
  });

  test("ignores unrelated errors, untracked providers and disabled scheduling", async () => {
    expect(await maybeMarkUpstreamQuotaExhausted(kimi, new Error("x"))).toBe(false);
    expect(await maybeMarkUpstreamQuotaExhausted(kimi, null)).toBe(false);
    expect(await maybeMarkUpstreamQuotaExhausted(kimi, { statusCode: "402" })).toBe(false);
    expect(await maybeMarkUpstreamQuotaExhausted(kimi, { statusCode: 429 })).toBe(false);
    expect(await maybeMarkUpstreamQuotaExhausted(relay, { statusCode: 402 })).toBe(false);
    settings.value = { ...settings.value, enabled: false };
    expect(await maybeMarkUpstreamQuotaExhausted(kimi, { statusCode: 402 })).toBe(false);
    expect(stateMocks.markProviderUpstreamQuotaExhausted).not.toHaveBeenCalled();
  });

  test("never throws when marking fails", async () => {
    stateMocks.markProviderUpstreamQuotaExhausted.mockRejectedValueOnce(new Error("redis"));
    expect(await maybeMarkUpstreamQuotaExhausted(kimi, { statusCode: 402 })).toBe(false);
  });
});
