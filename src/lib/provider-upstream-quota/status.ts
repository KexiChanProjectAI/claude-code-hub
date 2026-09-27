import "server-only";

import {
  findProviderUpstreamQuotaSnapshots,
  findUpstreamQuotaProbeTargetById,
} from "@/repository/provider-upstream-quota";
import type {
  ProviderUpstreamQuotaStatus,
  ProviderUpstreamQuotaStatusMap,
  UpstreamQuotaProbeType,
  UpstreamQuotaSnapshot,
} from "@/types/upstream-quota";
import { isUpstreamQuotaTrackedProvider, resolveUpstreamQuotaProbeType } from "./detect";
import { evaluateUpstreamQuota, type UpstreamQuotaSettings } from "./evaluate";
import { probeAndStoreProviderUpstreamQuota } from "./probe-service";
import { getUpstreamQuotaSettings } from "./settings";

interface StatusProviderRef {
  id: number;
  url: string;
  upstreamQuotaProbeType?: UpstreamQuotaProbeType | null;
  upstreamQuotaThresholdPercent?: number | null;
}

export function buildProviderUpstreamQuotaStatus(
  provider: StatusProviderRef,
  snapshot: UpstreamQuotaSnapshot | null,
  settings: UpstreamQuotaSettings,
  now: number
): ProviderUpstreamQuotaStatus {
  const resolvedProbeType = resolveUpstreamQuotaProbeType(provider);
  return {
    providerId: provider.id,
    resolvedProbeType,
    snapshot,
    // Evaluate as if enabled so the dashboard can preview what the scheduler would do.
    verdict: evaluateUpstreamQuota({
      snapshot,
      settings: { ...settings, enabled: true },
      resolvedProbeType,
      providerThresholdPercent: provider.upstreamQuotaThresholdPercent,
      now,
    }),
  };
}

/** Dashboard status for every tracked provider (auto-detected, explicit, or with a stored snapshot). */
export async function buildProviderUpstreamQuotaStatusMap(
  providers: StatusProviderRef[],
  options: { now?: number; settings?: UpstreamQuotaSettings } = {}
): Promise<ProviderUpstreamQuotaStatusMap> {
  const settings = options.settings ?? (await getUpstreamQuotaSettings());
  const now = options.now ?? Date.now();
  const tracked = providers.filter((provider) => isUpstreamQuotaTrackedProvider(provider));
  if (tracked.length === 0) return {};

  const snapshots = await findProviderUpstreamQuotaSnapshots(tracked.map((p) => p.id));
  const byId = new Map(snapshots.map((snapshot) => [snapshot.providerId, snapshot]));

  const result: ProviderUpstreamQuotaStatusMap = {};
  for (const provider of tracked) {
    result[provider.id] = buildProviderUpstreamQuotaStatus(
      provider,
      byId.get(provider.id) ?? null,
      settings,
      now
    );
  }
  return result;
}

export type RefreshUpstreamQuotaResult =
  | { ok: true; status: ProviderUpstreamQuotaStatus }
  | {
      ok: false;
      error: string;
      errorCode: "PROVIDER_NOT_FOUND" | "UPSTREAM_QUOTA_NOT_SUPPORTED";
    };

/** Probe one provider immediately, regardless of interval or the global toggle. */
export async function refreshProviderUpstreamQuotaNow(
  providerId: number
): Promise<RefreshUpstreamQuotaResult> {
  const target = await findUpstreamQuotaProbeTargetById(providerId);
  if (!target) {
    return { ok: false, error: "Provider not found", errorCode: "PROVIDER_NOT_FOUND" };
  }
  if (resolveUpstreamQuotaProbeType(target) === "none") {
    return {
      ok: false,
      error: "Upstream quota probing is not available for this provider",
      errorCode: "UPSTREAM_QUOTA_NOT_SUPPORTED",
    };
  }
  const settings = await getUpstreamQuotaSettings();
  const outcome = await probeAndStoreProviderUpstreamQuota(target, { settings });
  const [snapshot] = await findProviderUpstreamQuotaSnapshots([providerId]);
  return {
    ok: true,
    status: buildProviderUpstreamQuotaStatus(
      target,
      snapshot ?? outcome.snapshot,
      settings,
      Date.now()
    ),
  };
}
