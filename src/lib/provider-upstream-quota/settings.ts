import "server-only";

import { getCachedSystemSettings } from "@/lib/config/system-settings-cache";
import {
  UPSTREAM_QUOTA_DEFAULT_PROBE_INTERVAL_MINUTES,
  UPSTREAM_QUOTA_DEFAULT_THRESHOLD_PERCENT,
  UPSTREAM_QUOTA_PROBE_INTERVAL_MINUTES_RANGE,
  UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE,
} from "./constants";
import type { UpstreamQuotaSettings } from "./evaluate";

function clampInt(value: unknown, fallback: number, range: readonly [number, number]): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(range[1], Math.max(range[0], num));
}

/** Read upstream quota settings from the in-process system settings cache. */
export async function getUpstreamQuotaSettings(): Promise<UpstreamQuotaSettings> {
  try {
    const settings = await getCachedSystemSettings();
    return {
      enabled: settings.upstreamQuotaSchedulingEnabled === true,
      thresholdPercent: clampInt(
        settings.upstreamQuotaThresholdPercent,
        UPSTREAM_QUOTA_DEFAULT_THRESHOLD_PERCENT,
        UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE
      ),
      intervalMinutes: clampInt(
        settings.upstreamQuotaProbeIntervalMinutes,
        UPSTREAM_QUOTA_DEFAULT_PROBE_INTERVAL_MINUTES,
        UPSTREAM_QUOTA_PROBE_INTERVAL_MINUTES_RANGE
      ),
    };
  } catch {
    return {
      enabled: false,
      thresholdPercent: UPSTREAM_QUOTA_DEFAULT_THRESHOLD_PERCENT,
      intervalMinutes: UPSTREAM_QUOTA_DEFAULT_PROBE_INTERVAL_MINUTES,
    };
  }
}
