import "server-only";

import { logger } from "@/lib/logger";
import type { ResolvedUpstreamQuotaProbeType, UpstreamQuotaSnapshot } from "@/types/upstream-quota";
import { UPSTREAM_QUOTA_REACTIVE_PAUSE_INTERVAL_MULTIPLIER } from "./constants";
import { resolveUpstreamQuotaProbeType } from "./detect";
import type { UpstreamQuotaSettings } from "./evaluate";
import { UPSTREAM_QUOTA_PROBERS } from "./probers";
import { getUpstreamQuotaSettings } from "./settings";
import { getUpstreamQuotaSnapshotFresh, storeUpstreamQuotaSnapshot } from "./state";
import type { UpstreamQuotaProbeResult, UpstreamQuotaProbeTarget } from "./types";

export interface UpstreamQuotaProbeOutcome {
  resolvedProbeType: ResolvedUpstreamQuotaProbeType;
  result: UpstreamQuotaProbeResult | null;
  snapshot: UpstreamQuotaSnapshot | null;
}

/**
 * Merge a probe result into the previous snapshot.
 *
 * - success: replace windows, mark credential valid, clear reactive pause and errors.
 * - credential_invalid / http / network / parse: keep last known windows, record the error.
 * - insufficient_balance (HTTP 402 from the quota endpoint): pause like a reactive 402.
 */
export function mergeUpstreamQuotaProbeResult(input: {
  providerId: number;
  probeType: UpstreamQuotaSnapshot["probeType"];
  previous: UpstreamQuotaSnapshot | null;
  result: UpstreamQuotaProbeResult;
  settings: Pick<UpstreamQuotaSettings, "intervalMinutes">;
  now: number;
}): UpstreamQuotaSnapshot {
  const { previous, result, now } = input;
  if (result.ok) {
    return {
      providerId: input.providerId,
      probeType: input.probeType,
      windows: result.windows,
      planLevel: result.planLevel,
      credentialValid: true,
      lastError: null,
      lastErrorStatus: null,
      fetchedAt: now,
      probedAt: now,
      reactivePauseUntil: null,
      reactivePauseReason: null,
    };
  }

  const base: UpstreamQuotaSnapshot = {
    providerId: input.providerId,
    probeType: input.probeType,
    windows: previous?.windows ?? [],
    planLevel: previous?.planLevel ?? null,
    credentialValid:
      result.kind === "credential_invalid" ? false : (previous?.credentialValid ?? true),
    lastError: `${result.kind}: ${result.message}`,
    lastErrorStatus: result.statusCode ?? null,
    fetchedAt: previous?.fetchedAt ?? null,
    probedAt: now,
    reactivePauseUntil: previous?.reactivePauseUntil ?? null,
    reactivePauseReason: previous?.reactivePauseReason ?? null,
  };

  if (result.kind === "insufficient_balance") {
    const untilMs =
      now +
      input.settings.intervalMinutes * 60_000 * UPSTREAM_QUOTA_REACTIVE_PAUSE_INTERVAL_MULTIPLIER;
    base.reactivePauseUntil = Math.max(untilMs, base.reactivePauseUntil ?? 0);
    base.reactivePauseReason = "probe_402";
  }
  return base;
}

/** Probe one provider and store the merged snapshot. Never throws. */
export async function probeAndStoreProviderUpstreamQuota(
  target: UpstreamQuotaProbeTarget,
  options: { settings?: UpstreamQuotaSettings; now?: () => number } = {}
): Promise<UpstreamQuotaProbeOutcome> {
  const resolvedProbeType = resolveUpstreamQuotaProbeType(target);
  if (resolvedProbeType === "none") {
    return { resolvedProbeType, result: null, snapshot: null };
  }

  const now = options.now ?? Date.now;
  const settings = options.settings ?? (await getUpstreamQuotaSettings());
  const prober = UPSTREAM_QUOTA_PROBERS[resolvedProbeType];

  let result: UpstreamQuotaProbeResult;
  try {
    result = await prober.probe(target);
  } catch (error) {
    result = {
      ok: false,
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const previous = await getUpstreamQuotaSnapshotFresh(target.id);
    const snapshot = mergeUpstreamQuotaProbeResult({
      providerId: target.id,
      probeType: resolvedProbeType,
      previous,
      result,
      settings,
      now: now(),
    });
    await storeUpstreamQuotaSnapshot(snapshot);

    if (!result.ok) {
      logger.info("[UpstreamQuota] Probe failed", {
        providerId: target.id,
        providerName: target.name,
        probeType: resolvedProbeType,
        kind: result.kind,
        statusCode: result.statusCode,
        message: result.message,
      });
    } else {
      logger.debug("[UpstreamQuota] Probe succeeded", {
        providerId: target.id,
        probeType: resolvedProbeType,
        windows: result.windows,
      });
    }
    return { resolvedProbeType, result, snapshot };
  } catch (error) {
    logger.warn("[UpstreamQuota] Failed to store probe result", {
      providerId: target.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { resolvedProbeType, result, snapshot: null };
  }
}
