/**
 * Upstream quota scheduling types.
 *
 * "Upstream quota" is the remaining allowance reported by an upstream Coding Plan
 * (Kimi / Zhipu GLM / MiniMax / OpenCode Go). It is unrelated to the internal
 * spend-limit lease system (quotaLease* settings).
 */

/** Probe types that can actually be executed against an upstream endpoint. */
export const UPSTREAM_QUOTA_CONCRETE_PROBE_TYPES = [
  "kimi-coding",
  "zhipu-coding",
  "minimax-coding",
  "opencode-go",
] as const;

export type UpstreamQuotaConcreteProbeType = (typeof UPSTREAM_QUOTA_CONCRETE_PROBE_TYPES)[number];

/** Probe types that can be configured on a provider. */
export const UPSTREAM_QUOTA_PROBE_TYPES = [
  "auto",
  "none",
  ...UPSTREAM_QUOTA_CONCRETE_PROBE_TYPES,
] as const;

export type UpstreamQuotaProbeType = (typeof UPSTREAM_QUOTA_PROBE_TYPES)[number];

/** Resolved probe type: "auto" collapses to a concrete type or "none". */
export type ResolvedUpstreamQuotaProbeType = UpstreamQuotaConcreteProbeType | "none";

export interface UpstreamQuotaProbeOptions {
  /** Zhipu team plan organization id (sent as bigmodel-organization). */
  zhipuOrganization?: string | null;
  /** Zhipu team plan project id (sent as bigmodel-project). */
  zhipuProject?: string | null;
}

export type UpstreamQuotaWindowName = "5h" | "weekly" | "monthly" | "rolling";

export interface UpstreamQuotaWindow {
  window: UpstreamQuotaWindowName;
  /** Used percentage in [0, 100]. */
  usedPercent: number;
  /** Epoch milliseconds when the window resets, null when unknown. */
  resetAt: number | null;
}

export type UpstreamQuotaPauseReason = "reactive_402" | "reactive_429_balance" | "probe_402";

/** Snapshot of one provider's upstream quota (shared by Redis, DB and UI). */
export interface UpstreamQuotaSnapshot {
  providerId: number;
  probeType: UpstreamQuotaConcreteProbeType | null;
  windows: UpstreamQuotaWindow[];
  planLevel: string | null;
  credentialValid: boolean;
  lastError: string | null;
  lastErrorStatus: number | null;
  /** Epoch ms of the last successful probe, null when never succeeded. */
  fetchedAt: number | null;
  /** Epoch ms of the last probe attempt (success or failure). */
  probedAt: number;
  /** Epoch ms until which the provider is treated as exhausted (reactive detection). */
  reactivePauseUntil: number | null;
  reactivePauseReason: UpstreamQuotaPauseReason | null;
}

export type UpstreamQuotaStatus = "ok" | "low" | "exhausted" | "unknown";

export interface UpstreamQuotaVerdict {
  status: UpstreamQuotaStatus;
  /** Minimum remaining percent across active windows. */
  remainingPercent?: number;
  /** Window that produced the minimum remaining percent. */
  blockingWindow?: UpstreamQuotaWindowName;
  /** Effective threshold (remaining percent) that was applied. */
  thresholdPercent?: number;
  reason:
    | "disabled"
    | "not_applicable"
    | "reactive_pause"
    | "no_snapshot"
    | "stale_snapshot"
    | "no_active_window"
    | "exhausted"
    | "below_threshold"
    | "healthy";
}

/** Per-provider status payload exposed to the dashboard. */
export interface ProviderUpstreamQuotaStatus {
  providerId: number;
  resolvedProbeType: ResolvedUpstreamQuotaProbeType;
  snapshot: UpstreamQuotaSnapshot | null;
  verdict: UpstreamQuotaVerdict;
}

export type ProviderUpstreamQuotaStatusMap = Record<number, ProviderUpstreamQuotaStatus>;
