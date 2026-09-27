import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";

const lockMocks = vi.hoisted(() => ({
  acquireLeaderLock: vi.fn(async () => ({ key: "k", lockId: "1", lockType: "memory" }) as never),
  renewLeaderLock: vi.fn(async () => true),
  releaseLeaderLock: vi.fn(async () => undefined),
  startLeaderLockKeepAlive: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("@/lib/provider-endpoints/leader-lock", () => lockMocks);

const repoMocks = vi.hoisted(() => ({
  findUpstreamQuotaProbeTargets: vi.fn(async () => [] as never[]),
  findProviderUpstreamQuotaSnapshots: vi.fn(async () => [] as UpstreamQuotaSnapshot[]),
}));
vi.mock("@/repository/provider-upstream-quota", () => repoMocks);

const probeMocks = vi.hoisted(() => ({
  probeAndStoreProviderUpstreamQuota: vi.fn(async () => ({}) as never),
}));
vi.mock("@/lib/provider-upstream-quota/probe-service", () => probeMocks);

const settings = vi.hoisted(() => ({
  value: { enabled: true, thresholdPercent: 10, intervalMinutes: 10 },
}));
vi.mock("@/lib/provider-upstream-quota/settings", () => ({
  getUpstreamQuotaSettings: vi.fn(async () => settings.value),
}));

const stateMocks = vi.hoisted(() => ({ seedUpstreamQuotaSnapshot: vi.fn(async () => undefined) }));
vi.mock("@/lib/provider-upstream-quota/state", () => stateMocks);

import {
  getUpstreamQuotaSchedulerStatus,
  runUpstreamQuotaProbeCycle,
  selectDueUpstreamQuotaTargets,
  startUpstreamQuotaScheduler,
  stopUpstreamQuotaScheduler,
} from "@/lib/provider-upstream-quota/scheduler";
import type { UpstreamQuotaProbeTarget } from "@/lib/provider-upstream-quota/types";

function target(id: number, url = "https://api.kimi.com/coding/v1"): UpstreamQuotaProbeTarget {
  return {
    id,
    name: `p${id}`,
    url,
    key: "sk",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    upstreamQuotaProbeType: "auto",
    upstreamQuotaProbeOptions: null,
  };
}

function snap(providerId: number, probedAt: number): UpstreamQuotaSnapshot {
  return {
    providerId,
    probeType: "kimi-coding",
    windows: [],
    planLevel: null,
    credentialValid: true,
    lastError: null,
    lastErrorStatus: null,
    fetchedAt: probedAt,
    probedAt,
    reactivePauseUntil: null,
    reactivePauseReason: null,
  };
}

async function runCycle() {
  const promise = runUpstreamQuotaProbeCycle();
  await vi.runAllTimersAsync();
  await promise;
}

function resetSchedulerGlobals() {
  const state = globalThis as Record<string, unknown>;
  const intervalId = state.__CCH_UPSTREAM_QUOTA_SCHEDULER_INTERVAL_ID__;
  if (intervalId) clearInterval(intervalId as ReturnType<typeof setInterval>);
  for (const key of Object.keys(state)) {
    if (key.startsWith("__CCH_UPSTREAM_QUOTA_SCHEDULER_")) state[key] = undefined;
  }
}

beforeEach(() => {
  resetSchedulerGlobals();
  vi.useFakeTimers();
  vi.clearAllMocks();
  settings.value = { enabled: true, thresholdPercent: 10, intervalMinutes: 10 };
});

afterEach(() => {
  resetSchedulerGlobals();
  vi.useRealTimers();
});

describe("selectDueUpstreamQuotaTargets", () => {
  test("selects never-probed and expired targets and skips none types", () => {
    const now = 100 * 60_000;
    const snapshots = new Map([
      [1, snap(1, now - 5 * 60_000)],
      [2, snap(2, now - 10 * 60_000)],
    ]);
    const due = selectDueUpstreamQuotaTargets(
      [target(1), target(2), target(3), target(4, "https://relay.example.com")],
      snapshots,
      { intervalMinutes: 10 },
      now
    );
    expect(due.map((t) => t.id)).toEqual([2, 3]);
  });
});

describe("runUpstreamQuotaProbeCycle", () => {
  test("does nothing when the feature is disabled", async () => {
    settings.value = { ...settings.value, enabled: false };
    await runCycle();
    expect(lockMocks.acquireLeaderLock).not.toHaveBeenCalled();
    expect(repoMocks.findUpstreamQuotaProbeTargets).not.toHaveBeenCalled();
  });

  test("does nothing without the leader lock", async () => {
    lockMocks.acquireLeaderLock.mockResolvedValueOnce(null as never);
    await runCycle();
    expect(repoMocks.findUpstreamQuotaProbeTargets).not.toHaveBeenCalled();
  });

  test("seeds Redis once and probes only due targets", async () => {
    const now = Date.now();
    repoMocks.findUpstreamQuotaProbeTargets.mockResolvedValue([target(1), target(2)] as never[]);
    repoMocks.findProviderUpstreamQuotaSnapshots.mockResolvedValue([snap(1, now)]);

    await runCycle();
    expect(stateMocks.seedUpstreamQuotaSnapshot).toHaveBeenCalledTimes(1);
    expect(probeMocks.probeAndStoreProviderUpstreamQuota).toHaveBeenCalledTimes(1);
    expect(probeMocks.probeAndStoreProviderUpstreamQuota).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      { settings: settings.value }
    );

    await runCycle();
    expect(stateMocks.seedUpstreamQuotaSnapshot).toHaveBeenCalledTimes(1);
    expect(lockMocks.renewLeaderLock).toHaveBeenCalled();
  });

  test("returns early when there are no targets or nothing is due", async () => {
    await runCycle();
    expect(repoMocks.findProviderUpstreamQuotaSnapshots).not.toHaveBeenCalled();

    repoMocks.findUpstreamQuotaProbeTargets.mockResolvedValue([target(1)] as never[]);
    repoMocks.findProviderUpstreamQuotaSnapshots.mockResolvedValue([snap(1, Date.now())]);
    await runCycle();
    expect(probeMocks.probeAndStoreProviderUpstreamQuota).not.toHaveBeenCalled();
  });

  test("reacquires the lock when renewal fails and logs cycle errors", async () => {
    await runCycle();
    lockMocks.renewLeaderLock.mockResolvedValueOnce(false);
    await runCycle();
    expect(lockMocks.releaseLeaderLock).toHaveBeenCalled();
    expect(lockMocks.acquireLeaderLock).toHaveBeenCalledTimes(2);

    repoMocks.findUpstreamQuotaProbeTargets.mockRejectedValueOnce(new Error("db down"));
    await expect(runCycle()).resolves.toBeUndefined();
  });

  test("stops probing when leadership is lost", async () => {
    lockMocks.startLeaderLockKeepAlive.mockImplementationOnce(((opts: { onLost: () => void }) => {
      opts.onLost();
      return { stop: vi.fn() };
    }) as never);
    repoMocks.findUpstreamQuotaProbeTargets.mockResolvedValue([target(1)] as never[]);
    await runCycle();
    expect(repoMocks.findUpstreamQuotaProbeTargets).not.toHaveBeenCalled();
  });
});

describe("start/stop", () => {
  test("starts once, reports status and releases the lock on stop", async () => {
    startUpstreamQuotaScheduler();
    startUpstreamQuotaScheduler();
    expect(getUpstreamQuotaSchedulerStatus()).toMatchObject({
      started: true,
      tickIntervalMs: 30_000,
      concurrency: 4,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(lockMocks.acquireLeaderLock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(lockMocks.renewLeaderLock).toHaveBeenCalled();

    await stopUpstreamQuotaScheduler();
    expect(getUpstreamQuotaSchedulerStatus()).toMatchObject({ started: false, running: false });
    expect(lockMocks.releaseLeaderLock).toHaveBeenCalled();

    // A cycle requested after stop is a no-op.
    await runUpstreamQuotaProbeCycle();
    expect(lockMocks.acquireLeaderLock).toHaveBeenCalledTimes(1);
  });
});
