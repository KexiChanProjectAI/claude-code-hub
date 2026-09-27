import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const stateMocks = vi.hoisted(() => ({
  getUpstreamQuotaSnapshotFresh: vi.fn(async () => null as UpstreamQuotaSnapshot | null),
  storeUpstreamQuotaSnapshot: vi.fn(async () => undefined),
}));
vi.mock("@/lib/provider-upstream-quota/state", () => stateMocks);

const proberMocks = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("@/lib/provider-upstream-quota/probers", () => ({
  UPSTREAM_QUOTA_PROBERS: {
    "kimi-coding": { type: "kimi-coding", probe: proberMocks.probe },
    "zhipu-coding": { type: "zhipu-coding", probe: proberMocks.probe },
    "minimax-coding": { type: "minimax-coding", probe: proberMocks.probe },
    "opencode-go": { type: "opencode-go", probe: proberMocks.probe },
  },
}));

const settingsMocks = vi.hoisted(() => ({
  getUpstreamQuotaSettings: vi.fn(async () => ({
    enabled: true,
    thresholdPercent: 10,
    intervalMinutes: 10,
  })),
}));
vi.mock("@/lib/provider-upstream-quota/settings", () => settingsMocks);

import {
  mergeUpstreamQuotaProbeResult,
  probeAndStoreProviderUpstreamQuota,
} from "@/lib/provider-upstream-quota/probe-service";
import type { UpstreamQuotaProbeTarget } from "@/lib/provider-upstream-quota/types";

const NOW = 1_000_000;

function previous(overrides: Partial<UpstreamQuotaSnapshot> = {}): UpstreamQuotaSnapshot {
  return {
    providerId: 1,
    probeType: "kimi-coding",
    windows: [{ window: "5h", usedPercent: 40, resetAt: null }],
    planLevel: "pro",
    credentialValid: true,
    lastError: null,
    lastErrorStatus: null,
    fetchedAt: 500,
    probedAt: 500,
    reactivePauseUntil: 2_000_000,
    reactivePauseReason: "reactive_402",
    ...overrides,
  };
}

function target(overrides: Partial<UpstreamQuotaProbeTarget> = {}): UpstreamQuotaProbeTarget {
  return {
    id: 1,
    name: "kimi",
    url: "https://api.kimi.com/coding/v1",
    key: "sk",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    upstreamQuotaProbeType: "auto",
    upstreamQuotaProbeOptions: null,
    ...overrides,
  };
}

const merge = (
  result: Parameters<typeof mergeUpstreamQuotaProbeResult>[0]["result"],
  prev = previous()
) =>
  mergeUpstreamQuotaProbeResult({
    providerId: 1,
    probeType: "kimi-coding",
    previous: prev,
    result,
    settings: { intervalMinutes: 10 },
    now: NOW,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mergeUpstreamQuotaProbeResult", () => {
  test("success replaces data and clears errors and reactive pause", () => {
    expect(
      merge({
        ok: true,
        windows: [{ window: "weekly", usedPercent: 5, resetAt: 9 }],
        planLevel: null,
      })
    ).toEqual({
      providerId: 1,
      probeType: "kimi-coding",
      windows: [{ window: "weekly", usedPercent: 5, resetAt: 9 }],
      planLevel: null,
      credentialValid: true,
      lastError: null,
      lastErrorStatus: null,
      fetchedAt: NOW,
      probedAt: NOW,
      reactivePauseUntil: null,
      reactivePauseReason: null,
    });
  });

  test("credential_invalid keeps windows and marks the credential", () => {
    expect(
      merge({ ok: false, kind: "credential_invalid", statusCode: 401, message: "bad key" })
    ).toMatchObject({
      windows: previous().windows,
      fetchedAt: 500,
      probedAt: NOW,
      credentialValid: false,
      lastError: "credential_invalid: bad key",
      lastErrorStatus: 401,
      reactivePauseUntil: 2_000_000,
    });
  });

  test("insufficient_balance pauses for two intervals without shortening", () => {
    expect(
      merge(
        { ok: false, kind: "insufficient_balance", statusCode: 402, message: "pay" },
        previous({ reactivePauseUntil: null, reactivePauseReason: null })
      )
    ).toMatchObject({ reactivePauseUntil: NOW + 20 * 60_000, reactivePauseReason: "probe_402" });
    expect(
      merge(
        { ok: false, kind: "insufficient_balance", message: "pay" },
        previous({ reactivePauseUntil: NOW * 10 })
      ).reactivePauseUntil
    ).toBe(NOW * 10);
  });

  test("transient errors keep old data and work without a previous snapshot", () => {
    expect(merge({ ok: false, kind: "network", message: "timeout" }, null as never)).toEqual({
      providerId: 1,
      probeType: "kimi-coding",
      windows: [],
      planLevel: null,
      credentialValid: true,
      lastError: "network: timeout",
      lastErrorStatus: null,
      fetchedAt: null,
      probedAt: NOW,
      reactivePauseUntil: null,
      reactivePauseReason: null,
    });
  });
});

describe("probeAndStoreProviderUpstreamQuota", () => {
  test("skips providers without a probe type", async () => {
    const outcome = await probeAndStoreProviderUpstreamQuota(
      target({ url: "https://relay.example.com" })
    );
    expect(outcome).toEqual({ resolvedProbeType: "none", result: null, snapshot: null });
    expect(proberMocks.probe).not.toHaveBeenCalled();
  });

  test("probes, merges with the previous snapshot and stores", async () => {
    stateMocks.getUpstreamQuotaSnapshotFresh.mockResolvedValueOnce(previous());
    proberMocks.probe.mockResolvedValueOnce({ ok: true, windows: [], planLevel: "max" });
    const outcome = await probeAndStoreProviderUpstreamQuota(target(), { now: () => NOW });
    expect(outcome.resolvedProbeType).toBe("kimi-coding");
    expect(outcome.snapshot).toMatchObject({ planLevel: "max", fetchedAt: NOW });
    expect(stateMocks.storeUpstreamQuotaSnapshot).toHaveBeenCalledWith(outcome.snapshot);
    expect(settingsMocks.getUpstreamQuotaSettings).toHaveBeenCalled();
  });

  test("converts prober exceptions into network failures", async () => {
    proberMocks.probe.mockRejectedValueOnce(new Error("kaboom"));
    const outcome = await probeAndStoreProviderUpstreamQuota(target(), {
      settings: { enabled: true, thresholdPercent: 10, intervalMinutes: 5 },
      now: () => NOW,
    });
    expect(outcome.result).toEqual({ ok: false, kind: "network", message: "kaboom" });
    expect(outcome.snapshot?.lastError).toBe("network: kaboom");
    expect(settingsMocks.getUpstreamQuotaSettings).not.toHaveBeenCalled();

    proberMocks.probe.mockRejectedValueOnce("string failure");
    const second = await probeAndStoreProviderUpstreamQuota(target(), { now: () => NOW });
    expect(second.result).toMatchObject({ message: "string failure" });
  });

  test("never throws when storing fails", async () => {
    proberMocks.probe.mockResolvedValueOnce({ ok: true, windows: [], planLevel: null });
    stateMocks.storeUpstreamQuotaSnapshot.mockRejectedValueOnce(new Error("redis down"));
    const outcome = await probeAndStoreProviderUpstreamQuota(target());
    expect(outcome.snapshot).toBeNull();
    expect(outcome.result).toMatchObject({ ok: true });
  });
});
