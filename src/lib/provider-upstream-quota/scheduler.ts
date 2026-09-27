import "server-only";

import { logger } from "@/lib/logger";
import {
  acquireLeaderLock,
  type LeaderLock,
  releaseLeaderLock,
  renewLeaderLock,
  startLeaderLockKeepAlive,
} from "@/lib/provider-endpoints/leader-lock";
import {
  findProviderUpstreamQuotaSnapshots,
  findUpstreamQuotaProbeTargets,
} from "@/repository/provider-upstream-quota";
import type { UpstreamQuotaSnapshot } from "@/types/upstream-quota";
import { resolveUpstreamQuotaProbeType } from "./detect";
import type { UpstreamQuotaSettings } from "./evaluate";
import { probeAndStoreProviderUpstreamQuota } from "./probe-service";
import { getUpstreamQuotaSettings } from "./settings";
import { seedUpstreamQuotaSnapshot } from "./state";
import type { UpstreamQuotaProbeTarget } from "./types";

const LOCK_KEY = "locks:upstream-quota-scheduler";
const TICK_INTERVAL_MS = 30_000;
const LOCK_TTL_MS = 60_000;
const CONCURRENCY = 4;
const CYCLE_JITTER_MS = 2_000;

const schedulerState = globalThis as unknown as {
  __CCH_UPSTREAM_QUOTA_SCHEDULER_STARTED__?: boolean;
  __CCH_UPSTREAM_QUOTA_SCHEDULER_INTERVAL_ID__?: ReturnType<typeof setInterval>;
  __CCH_UPSTREAM_QUOTA_SCHEDULER_RUNNING__?: boolean;
  __CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__?: LeaderLock;
  __CCH_UPSTREAM_QUOTA_SCHEDULER_STOP_REQUESTED__?: boolean;
  __CCH_UPSTREAM_QUOTA_SCHEDULER_SEEDED__?: boolean;
  __CCH_UPSTREAM_QUOTA_SCHEDULER_CURRENT_PROMISE__?: Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Targets whose last probe attempt is older than the configured interval (or never probed). */
export function selectDueUpstreamQuotaTargets(
  targets: UpstreamQuotaProbeTarget[],
  snapshots: Map<number, UpstreamQuotaSnapshot>,
  settings: Pick<UpstreamQuotaSettings, "intervalMinutes">,
  nowMs: number
): UpstreamQuotaProbeTarget[] {
  const intervalMs = settings.intervalMinutes * 60_000;
  return targets.filter((target) => {
    if (resolveUpstreamQuotaProbeType(target) === "none") return false;
    const snapshot = snapshots.get(target.id);
    if (!snapshot) return true;
    return nowMs - snapshot.probedAt >= intervalMs;
  });
}

async function ensureLeaderLock(): Promise<boolean> {
  const current = schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__;
  if (current) {
    if (await renewLeaderLock(current, LOCK_TTL_MS)) return true;
    schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__ = undefined;
    schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_SEEDED__ = false;
    await releaseLeaderLock(current);
  }
  const acquired = await acquireLeaderLock(LOCK_KEY, LOCK_TTL_MS);
  if (!acquired) return false;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__ = acquired;
  return true;
}

function isStopRequested(): boolean {
  return schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STOP_REQUESTED__ === true;
}

export async function runUpstreamQuotaProbeCycle(): Promise<void> {
  if (schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_RUNNING__ || isStopRequested()) return;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_RUNNING__ = true;

  let leadershipLost = false;
  let stopKeepAlive: (() => void) | undefined;
  try {
    const settings = await getUpstreamQuotaSettings();
    if (!settings.enabled) return;

    if (!(await ensureLeaderLock())) return;

    stopKeepAlive = startLeaderLockKeepAlive({
      getLock: () => schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__,
      clearLock: () => {
        schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__ = undefined;
      },
      ttlMs: LOCK_TTL_MS,
      logTag: "UpstreamQuotaScheduler",
      onLost: () => {
        leadershipLost = true;
      },
    }).stop;

    if (CYCLE_JITTER_MS > 0) await sleep(Math.floor(Math.random() * CYCLE_JITTER_MS));
    if (leadershipLost || isStopRequested()) return;

    const targets = await findUpstreamQuotaProbeTargets();
    if (targets.length === 0) return;

    const snapshotList = await findProviderUpstreamQuotaSnapshots(targets.map((t) => t.id));
    const snapshots = new Map(snapshotList.map((snapshot) => [snapshot.providerId, snapshot]));

    // After a restart or Redis flush, re-seed the hot-path store from PostgreSQL once.
    if (!schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_SEEDED__) {
      for (const snapshot of snapshotList) {
        await seedUpstreamQuotaSnapshot(snapshot);
      }
      schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_SEEDED__ = true;
    }

    const due = selectDueUpstreamQuotaTargets(targets, snapshots, settings, Date.now());
    if (due.length === 0) return;

    let index = 0;
    const worker = async () => {
      while (!leadershipLost && !isStopRequested()) {
        const target = due[index];
        index += 1;
        if (!target) return;
        await probeAndStoreProviderUpstreamQuota(target, { settings });
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(CONCURRENCY, due.length)) }, () => worker())
    );
  } catch (error) {
    logger.warn("[UpstreamQuotaScheduler] Probe cycle error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    stopKeepAlive?.();
    schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_RUNNING__ = false;
  }
}

function launchCycle(): void {
  if (schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_CURRENT_PROMISE__) return;
  const current = runUpstreamQuotaProbeCycle().finally(() => {
    if (schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_CURRENT_PROMISE__ === current) {
      schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_CURRENT_PROMISE__ = undefined;
    }
  });
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_CURRENT_PROMISE__ = current;
}

/**
 * Start the upstream quota scheduler. It ticks every 30s but only probes when the
 * feature is enabled in system settings and a provider's interval has elapsed.
 */
export function startUpstreamQuotaScheduler(): void {
  if (schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STARTED__) return;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STOP_REQUESTED__ = false;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STARTED__ = true;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_SEEDED__ = false;

  launchCycle();
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_INTERVAL_ID__ = setInterval(
    launchCycle,
    TICK_INTERVAL_MS
  );
  logger.info("[UpstreamQuotaScheduler] Started", {
    tickIntervalMs: TICK_INTERVAL_MS,
    concurrency: CONCURRENCY,
    lockTtlMs: LOCK_TTL_MS,
  });
}

export async function stopUpstreamQuotaScheduler(): Promise<void> {
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STOP_REQUESTED__ = true;
  const intervalId = schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_INTERVAL_ID__;
  if (intervalId) clearInterval(intervalId);
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_INTERVAL_ID__ = undefined;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STARTED__ = false;

  await schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_CURRENT_PROMISE__;

  const lock = schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__;
  schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_LOCK__ = undefined;
  if (lock) await releaseLeaderLock(lock);
}

export function getUpstreamQuotaSchedulerStatus(): {
  started: boolean;
  running: boolean;
  tickIntervalMs: number;
  concurrency: number;
} {
  return {
    started: schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_STARTED__ === true,
    running: schedulerState.__CCH_UPSTREAM_QUOTA_SCHEDULER_RUNNING__ === true,
    tickIntervalMs: TICK_INTERVAL_MS,
    concurrency: CONCURRENCY,
  };
}
