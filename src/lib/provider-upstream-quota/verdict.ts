import "server-only";

import { logger } from "@/lib/logger";
import type { UpstreamQuotaProbeType, UpstreamQuotaVerdict } from "@/types/upstream-quota";
import { detectUpstreamQuotaExhausted } from "./balance-error-detector";
import { UPSTREAM_QUOTA_REACTIVE_PAUSE_INTERVAL_MULTIPLIER } from "./constants";
import { isUpstreamQuotaTrackedProvider, resolveUpstreamQuotaProbeType } from "./detect";
import { evaluateUpstreamQuota, type UpstreamQuotaSettings } from "./evaluate";
import { getUpstreamQuotaSettings } from "./settings";
import { getUpstreamQuotaSnapshotCached, markProviderUpstreamQuotaExhausted } from "./state";

export interface UpstreamQuotaProviderRef {
  id: number;
  name?: string;
  url: string;
  upstreamQuotaProbeType?: UpstreamQuotaProbeType | null;
  upstreamQuotaThresholdPercent?: number | null;
}

/**
 * Hot-path verdict for one provider.
 * Disabled feature and untracked providers short-circuit without touching Redis.
 */
export async function checkProviderUpstreamQuota(
  provider: UpstreamQuotaProviderRef,
  options: { settings?: UpstreamQuotaSettings; now?: number } = {}
): Promise<UpstreamQuotaVerdict> {
  const settings = options.settings ?? (await getUpstreamQuotaSettings());
  if (!settings.enabled) {
    return { status: "ok", reason: "disabled" };
  }
  if (!isUpstreamQuotaTrackedProvider(provider)) {
    return { status: "ok", reason: "not_applicable" };
  }
  try {
    const snapshot = await getUpstreamQuotaSnapshotCached(provider.id);
    return evaluateUpstreamQuota({
      snapshot,
      settings,
      resolvedProbeType: resolveUpstreamQuotaProbeType(provider),
      providerThresholdPercent: provider.upstreamQuotaThresholdPercent,
      now: options.now ?? Date.now(),
    });
  } catch (error) {
    logger.warn("[UpstreamQuota] Verdict lookup failed, allowing provider", {
      providerId: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unknown", reason: "no_snapshot" };
  }
}

/**
 * Reactive detection: pause a provider when the upstream says its balance or quota ran out.
 * Fire-and-forget safe (never throws). Returns true when the provider was marked.
 */
export async function maybeMarkUpstreamQuotaExhausted(
  provider: UpstreamQuotaProviderRef,
  error: { statusCode?: number; upstreamError?: { body?: string; parsed?: unknown } } | unknown
): Promise<boolean> {
  try {
    if (!error || typeof error !== "object") return false;
    const candidate = error as {
      statusCode?: unknown;
      upstreamError?: { body?: unknown; parsed?: unknown };
    };
    if (typeof candidate.statusCode !== "number") return false;
    const body =
      typeof candidate.upstreamError?.body === "string" ? candidate.upstreamError.body : undefined;
    const kind = detectUpstreamQuotaExhausted(
      candidate.statusCode,
      body,
      candidate.upstreamError?.parsed
    );
    if (!kind) return false;

    const settings = await getUpstreamQuotaSettings();
    if (!settings.enabled || !isUpstreamQuotaTrackedProvider(provider)) return false;

    const now = Date.now();
    const untilMs =
      now + settings.intervalMinutes * 60_000 * UPSTREAM_QUOTA_REACTIVE_PAUSE_INTERVAL_MULTIPLIER;
    await markProviderUpstreamQuotaExhausted(provider.id, {
      untilMs,
      reason: kind,
      now,
      message: `${kind}: HTTP ${candidate.statusCode}`,
    });
    logger.info("[UpstreamQuota] Provider marked as out of upstream quota", {
      providerId: provider.id,
      providerName: provider.name,
      reason: kind,
      pausedUntil: new Date(untilMs).toISOString(),
    });
    return true;
  } catch (markError) {
    logger.warn("[UpstreamQuota] Failed to mark provider exhausted", {
      providerId: provider.id,
      error: markError instanceof Error ? markError.message : String(markError),
    });
    return false;
  }
}
