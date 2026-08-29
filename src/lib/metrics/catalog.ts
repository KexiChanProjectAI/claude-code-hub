import { isNonBillingEndpoint } from "@/lib/utils/performance-formatter";

export const UNKNOWN_LABEL = "unknown";

export const TOKEN_TYPES = ["input", "output", "cache_read", "cache_creation"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export const STATUS_BUCKETS = ["2xx", "4xx", "5xx", "other"] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** Histogram buckets for generation tok/s (leaderboard formula). */
export const GENERATION_TPS_BUCKETS = [5, 10, 20, 30, 50, 80, 120, 200, 400, 800, 2000, 5000];

const LABEL_MAX_LENGTH = 128;
const MIN_GENERATION_WINDOW_MS = 100;

export type ProxyMetricEvent = {
  userId: number | null;
  userName?: string | null;
  providerId: number | null;
  providerName?: string | null;
  model: string | null;
  statusCode: number;
  endpoint: string | null;
  isReplay: boolean;
  isWarmup: boolean;
  blockedBy: string | null;
  costUsd?: string | number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  durationMs?: number | null;
  firstByteMs?: number | null;
};

export function sanitizeLabel(value: string | null | undefined, fallback = UNKNOWN_LABEL): string {
  if (value == null) return fallback;
  const trimmed = value.replace(/[\n\r]/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.length > LABEL_MAX_LENGTH ? trimmed.slice(0, LABEL_MAX_LENGTH) : trimmed;
}

export function statusBucket(statusCode: number): StatusBucket {
  if (!Number.isFinite(statusCode)) return "other";
  if (statusCode >= 200 && statusCode < 400) return "2xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

export function costUsdToMicros(costUsd: string | number | null | undefined): number {
  if (costUsd == null || costUsd === "") return 0;
  const value = typeof costUsd === "number" ? costUsd : Number(costUsd);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000);
}

export function nonNegativeInt(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Generation tok/s using the leaderboard formula:
 * output / ((durationMs - firstByteMs) / 1000) when the generation window is >= 100ms.
 */
export function generationTps(
  event: Pick<ProxyMetricEvent, "outputTokens" | "durationMs" | "firstByteMs">
): number | null {
  const outputTokens = nonNegativeInt(event.outputTokens);
  const durationMs = event.durationMs;
  const firstByteMs = event.firstByteMs;
  if (outputTokens <= 0 || durationMs == null || firstByteMs == null) return null;
  if (!Number.isFinite(durationMs) || !Number.isFinite(firstByteMs)) return null;
  if (firstByteMs >= durationMs) return null;
  const generationTimeMs = durationMs - firstByteMs;
  if (generationTimeMs < MIN_GENERATION_WINDOW_MS) return null;
  const tps = outputTokens / (generationTimeMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : null;
}

export function shouldRecordProxyMetric(event: ProxyMetricEvent): boolean {
  if (event.userId == null || !Number.isFinite(event.userId) || event.userId <= 0) return false;
  if (event.isReplay || event.isWarmup) return false;
  if (event.blockedBy != null && event.blockedBy.trim() !== "") return false;
  if (isNonBillingEndpoint(event.endpoint)) return false;
  return true;
}

export function tokenIncrements(
  event: ProxyMetricEvent
): Array<{ type: TokenType; value: number }> {
  const increments: Array<{ type: TokenType; value: number }> = [
    { type: "input", value: nonNegativeInt(event.inputTokens) },
    { type: "output", value: nonNegativeInt(event.outputTokens) },
    { type: "cache_read", value: nonNegativeInt(event.cacheReadTokens) },
    { type: "cache_creation", value: nonNegativeInt(event.cacheCreationTokens) },
  ];
  return increments.filter((item) => item.value > 0);
}

export function hasUsableProviderId(providerId: number | null): providerId is number {
  return providerId != null && Number.isFinite(providerId) && providerId > 0;
}
