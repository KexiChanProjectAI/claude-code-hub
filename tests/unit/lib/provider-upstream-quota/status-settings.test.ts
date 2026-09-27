import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const repoMocks = vi.hoisted(() => ({
  findProviderUpstreamQuotaSnapshots: vi.fn(async () => [] as UpstreamQuotaSnapshot[]),
  findUpstreamQuotaProbeTargetById: vi.fn(async () => null as never),
}));
vi.mock("@/repository/provider-upstream-quota", () => repoMocks);

const probeMocks = vi.hoisted(() => ({
  probeAndStoreProviderUpstreamQuota: vi.fn(async () => ({ snapshot: null }) as never),
}));
vi.mock("@/lib/provider-upstream-quota/probe-service", () => probeMocks);

const cacheMocks = vi.hoisted(() => ({ getCachedSystemSettings: vi.fn() }));
vi.mock("@/lib/config/system-settings-cache", () => cacheMocks);

import { getUpstreamQuotaSettings } from "@/lib/provider-upstream-quota/settings";
import {
  buildProviderUpstreamQuotaStatusMap,
  refreshProviderUpstreamQuotaNow,
} from "@/lib/provider-upstream-quota/status";

const NOW = 50_000_000;

function snap(providerId: number, used: number): UpstreamQuotaSnapshot {
  return {
    providerId,
    probeType: "kimi-coding",
    windows: [{ window: "5h", usedPercent: used, resetAt: null }],
    planLevel: null,
    credentialValid: true,
    lastError: null,
    lastErrorStatus: null,
    fetchedAt: NOW - 1_000,
    probedAt: NOW - 1_000,
    reactivePauseUntil: null,
    reactivePauseReason: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheMocks.getCachedSystemSettings.mockResolvedValue({
    upstreamQuotaSchedulingEnabled: false,
    upstreamQuotaThresholdPercent: 20,
    upstreamQuotaProbeIntervalMinutes: 5,
  });
});

describe("getUpstreamQuotaSettings", () => {
  test("reads and clamps values from the settings cache", async () => {
    expect(await getUpstreamQuotaSettings()).toEqual({
      enabled: false,
      thresholdPercent: 20,
      intervalMinutes: 5,
    });
    cacheMocks.getCachedSystemSettings.mockResolvedValueOnce({
      upstreamQuotaSchedulingEnabled: true,
      upstreamQuotaThresholdPercent: 500,
      upstreamQuotaProbeIntervalMinutes: undefined,
    });
    expect(await getUpstreamQuotaSettings()).toEqual({
      enabled: true,
      thresholdPercent: 99,
      intervalMinutes: 10,
    });
  });

  test("falls back to disabled defaults when settings fail", async () => {
    cacheMocks.getCachedSystemSettings.mockRejectedValueOnce(new Error("db"));
    expect(await getUpstreamQuotaSettings()).toEqual({
      enabled: false,
      thresholdPercent: 10,
      intervalMinutes: 10,
    });
  });
});

describe("buildProviderUpstreamQuotaStatusMap", () => {
  test("includes only tracked providers and previews verdicts even when disabled", async () => {
    repoMocks.findProviderUpstreamQuotaSnapshots.mockResolvedValueOnce([snap(1, 85)]);
    const map = await buildProviderUpstreamQuotaStatusMap(
      [
        { id: 1, url: "https://api.kimi.com/coding/v1", upstreamQuotaThresholdPercent: null },
        { id: 2, url: "https://relay.example.com" },
        { id: 3, url: "https://api.deepseek.com" },
      ],
      { now: NOW }
    );
    expect(Object.keys(map)).toEqual(["1", "3"]);
    expect(repoMocks.findProviderUpstreamQuotaSnapshots).toHaveBeenCalledWith([1, 3]);
    expect(map[1]).toMatchObject({
      resolvedProbeType: "kimi-coding",
      verdict: { status: "low", remainingPercent: 15, thresholdPercent: 20 },
    });
    expect(map[3]).toMatchObject({
      resolvedProbeType: "none",
      snapshot: null,
      verdict: { status: "ok", reason: "not_applicable" },
    });
  });

  test("skips the DB when nothing is tracked", async () => {
    expect(
      await buildProviderUpstreamQuotaStatusMap([{ id: 2, url: "https://x.example" }])
    ).toEqual({});
    expect(repoMocks.findProviderUpstreamQuotaSnapshots).not.toHaveBeenCalled();
  });
});

describe("refreshProviderUpstreamQuotaNow", () => {
  const target = {
    id: 1,
    name: "kimi",
    url: "https://api.kimi.com/coding/v1",
    key: "sk",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    upstreamQuotaProbeType: "auto" as const,
    upstreamQuotaProbeOptions: null,
  };

  test("reports missing and unsupported providers", async () => {
    expect(await refreshProviderUpstreamQuotaNow(1)).toMatchObject({
      ok: false,
      errorCode: "PROVIDER_NOT_FOUND",
    });
    repoMocks.findUpstreamQuotaProbeTargetById.mockResolvedValueOnce({
      ...target,
      url: "https://relay.example.com",
    } as never);
    expect(await refreshProviderUpstreamQuotaNow(1)).toMatchObject({
      ok: false,
      errorCode: "UPSTREAM_QUOTA_NOT_SUPPORTED",
    });
  });

  test("probes and returns the stored status", async () => {
    repoMocks.findUpstreamQuotaProbeTargetById.mockResolvedValueOnce(target as never);
    repoMocks.findProviderUpstreamQuotaSnapshots.mockResolvedValueOnce([snap(1, 10)]);
    const result = await refreshProviderUpstreamQuotaNow(1);
    expect(probeMocks.probeAndStoreProviderUpstreamQuota).toHaveBeenCalledWith(target, {
      settings: { enabled: false, thresholdPercent: 20, intervalMinutes: 5 },
    });
    expect(result).toMatchObject({
      ok: true,
      status: { providerId: 1, snapshot: { providerId: 1 } },
    });
  });

  test("falls back to the probe outcome when the DB has no row", async () => {
    repoMocks.findUpstreamQuotaProbeTargetById.mockResolvedValueOnce(target as never);
    probeMocks.probeAndStoreProviderUpstreamQuota.mockResolvedValueOnce({
      snapshot: snap(1, 30),
    } as never);
    const result = await refreshProviderUpstreamQuotaNow(1);
    expect(result).toMatchObject({
      ok: true,
      status: { snapshot: { windows: [{ usedPercent: 30 }] } },
    });
  });
});
