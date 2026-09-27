import type {
  ResolvedUpstreamQuotaProbeType,
  UpstreamQuotaSnapshot,
  UpstreamQuotaVerdict,
} from "@/types/upstream-quota";
import { UPSTREAM_QUOTA_STALE_INTERVAL_MULTIPLIER } from "./constants";

export interface UpstreamQuotaSettings {
  enabled: boolean;
  /** Minimum remaining percent required for new sessions. */
  thresholdPercent: number;
  intervalMinutes: number;
}

export interface EvaluateUpstreamQuotaInput {
  snapshot: UpstreamQuotaSnapshot | null;
  settings: UpstreamQuotaSettings;
  resolvedProbeType: ResolvedUpstreamQuotaProbeType;
  /** Per-provider override of the remaining-percent threshold. */
  providerThresholdPercent?: number | null;
  now: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Pure verdict for upstream quota scheduling.
 *
 * - "exhausted": no remaining quota (or reactive pause); blocks new and sticky sessions.
 * - "low": remaining below threshold; blocks new sessions only.
 * - "unknown": no fresh data; never blocks.
 */
export function evaluateUpstreamQuota(input: EvaluateUpstreamQuotaInput): UpstreamQuotaVerdict {
  const { snapshot, settings, resolvedProbeType, now } = input;

  if (!settings.enabled) {
    return { status: "ok", reason: "disabled" };
  }

  if (snapshot?.reactivePauseUntil && snapshot.reactivePauseUntil > now) {
    return { status: "exhausted", reason: "reactive_pause" };
  }

  if (resolvedProbeType === "none") {
    return { status: "ok", reason: "not_applicable" };
  }

  if (!snapshot || snapshot.fetchedAt === null) {
    return { status: "unknown", reason: "no_snapshot" };
  }

  const staleAfterMs =
    Math.max(1, settings.intervalMinutes) * 60_000 * UPSTREAM_QUOTA_STALE_INTERVAL_MULTIPLIER;
  if (now - snapshot.fetchedAt > staleAfterMs) {
    return { status: "unknown", reason: "stale_snapshot" };
  }

  const thresholdPercent = input.providerThresholdPercent ?? settings.thresholdPercent;

  let minRemaining: number | null = null;
  let blockingWindow: UpstreamQuotaVerdict["blockingWindow"];
  for (const window of snapshot.windows) {
    // A window whose reset time has passed has been refilled upstream.
    if (window.resetAt !== null && window.resetAt <= now) continue;
    const remaining = 100 - clampPercent(window.usedPercent);
    if (minRemaining === null || remaining < minRemaining) {
      minRemaining = remaining;
      blockingWindow = window.window;
    }
  }

  if (minRemaining === null) {
    return { status: "ok", reason: "no_active_window", thresholdPercent };
  }

  const remainingPercent = Math.round(minRemaining * 100) / 100;
  if (remainingPercent <= 0) {
    return {
      status: "exhausted",
      reason: "exhausted",
      remainingPercent,
      blockingWindow,
      thresholdPercent,
    };
  }
  if (remainingPercent < thresholdPercent) {
    return {
      status: "low",
      reason: "below_threshold",
      remainingPercent,
      blockingWindow,
      thresholdPercent,
    };
  }
  return { status: "ok", reason: "healthy", remainingPercent, blockingWindow, thresholdPercent };
}

/** Short decision-chain detail string, e.g. "5h remaining 3% < 10%". */
export function describeUpstreamQuotaVerdict(verdict: UpstreamQuotaVerdict): string {
  if (verdict.reason === "reactive_pause") return "upstream_balance_exhausted";
  if (verdict.remainingPercent === undefined) return verdict.reason;
  const window = verdict.blockingWindow ?? "window";
  if (verdict.status === "exhausted") return `${window} remaining 0%`;
  // Integers only: details may be looked up as an i18n key, where dots are path separators.
  const floored = Math.floor(verdict.remainingPercent);
  const remaining = floored < 1 ? "<1" : String(floored);
  return `${window} remaining ${remaining}% < ${verdict.thresholdPercent}%`;
}
