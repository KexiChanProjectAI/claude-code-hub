import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { logger } from "@/lib/logger";
import { emitClientProblemAlert } from "@/lib/notification/client-problem-alert";
import type { ProxyMetricEvent } from "./catalog";
import { isMetricsEnabled } from "./config";
import { getCchMetrics } from "./metrics";

export type ProxyMetricsUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type EmitProxyMetricsData = {
  statusCode: number;
  durationMs: number;
  usageMetrics?: ProxyMetricsUsage | null;
  costUsd?: string | number | null;
};

const recordedSessions = new WeakSet<ProxySession>();

function resolveUser(session: ProxySession): { id: number; name: string } | null {
  const user = session.messageContext?.user ?? session.authState?.user;
  if (!user) return null;
  return { id: user.id, name: user.name };
}

export function toProxyMetricEvent(
  session: ProxySession,
  data: EmitProxyMetricsData
): ProxyMetricEvent {
  const user = resolveUser(session);
  const usage = data.usageMetrics;
  return {
    userId: user?.id ?? null,
    userName: user?.name ?? session.userName ?? null,
    providerId: session.provider?.id ?? null,
    providerName: session.provider?.name ?? null,
    model: session.getCurrentModel(),
    statusCode: data.statusCode,
    endpoint: session.getManagedEndpoint(),
    isReplay: false,
    isWarmup: session.isWarmupRequest(),
    blockedBy: null,
    costUsd: data.costUsd,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheCreationTokens: usage?.cache_creation_input_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens,
    durationMs: data.durationMs,
    firstByteMs: session.firstByteMs,
  };
}

/**
 * Record Prometheus traffic metrics for a completed proxy request.
 * First call wins per session object so finalize + Langfuse/error paths do not double-count.
 */
export function emitProxyMetrics(session: ProxySession, data: EmitProxyMetricsData): void {
  emitClientProblemAlert(session, data.statusCode);
  if (!isMetricsEnabled()) return;
  if (recordedSessions.has(session)) return;
  recordedSessions.add(session);

  try {
    getCchMetrics().record(toProxyMetricEvent(session, data));
  } catch (error) {
    logger.warn("[metrics] Failed to record proxy metrics", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
