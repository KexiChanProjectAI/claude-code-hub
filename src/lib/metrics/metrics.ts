import { Counter, Gauge, Histogram, Registry } from "prom-client";
import {
  costUsdToMicros,
  GENERATION_TPS_BUCKETS,
  generationTps,
  hasUsableProviderId,
  type ProxyMetricEvent,
  sanitizeLabel,
  shouldRecordProxyMetric,
  statusBucket,
  tokenIncrements,
} from "./catalog";
import type { GaugeSnapshot } from "./gauges";

export class CchMetrics {
  readonly registry: Registry;

  private readonly requestsTotal: Counter;
  private readonly tokensTotal: Counter;
  private readonly costMicrosTotal: Counter;
  private readonly userRequestsTotal: Counter;
  private readonly userTokensTotal: Counter;
  private readonly userCostMicrosTotal: Counter;
  private readonly userModelRequestsTotal: Counter;
  private readonly userModelTokensTotal: Counter;
  private readonly userModelCostMicrosTotal: Counter;
  private readonly userProviderRequestsTotal: Counter;
  private readonly userProviderTokensTotal: Counter;
  private readonly userProviderCostMicrosTotal: Counter;
  private readonly generationTps: Histogram;
  private readonly userInfo: Gauge;
  private readonly providerInfo: Gauge;
  private readonly concurrentSessions: Gauge;
  private readonly concurrentSessionsByUser: Gauge;
  private readonly concurrentSessionsByProvider: Gauge;
  private readonly inFlight: Gauge;

  constructor(registry = new Registry()) {
    this.registry = registry;

    this.requestsTotal = new Counter({
      name: "cch_requests_total",
      help: "Completed billable proxy requests.",
      labelNames: ["model", "provider_id", "status"],
      registers: [registry],
    });
    this.tokensTotal = new Counter({
      name: "cch_tokens_total",
      help: "Tokens from completed billable proxy requests.",
      labelNames: ["model", "provider_id", "token_type"],
      registers: [registry],
    });
    this.costMicrosTotal = new Counter({
      name: "cch_cost_usd_micros_total",
      help: "Billable cost in micro-USD from completed proxy requests.",
      labelNames: ["model", "provider_id"],
      registers: [registry],
    });

    this.userRequestsTotal = new Counter({
      name: "cch_user_requests_total",
      help: "Completed billable proxy requests by user.",
      labelNames: ["user_id", "status"],
      registers: [registry],
    });
    this.userTokensTotal = new Counter({
      name: "cch_user_tokens_total",
      help: "Tokens from completed billable proxy requests by user.",
      labelNames: ["user_id", "token_type"],
      registers: [registry],
    });
    this.userCostMicrosTotal = new Counter({
      name: "cch_user_cost_usd_micros_total",
      help: "Billable cost in micro-USD by user.",
      labelNames: ["user_id"],
      registers: [registry],
    });

    this.userModelRequestsTotal = new Counter({
      name: "cch_user_model_requests_total",
      help: "Completed billable proxy requests by user and model.",
      labelNames: ["user_id", "model", "status"],
      registers: [registry],
    });
    this.userModelTokensTotal = new Counter({
      name: "cch_user_model_tokens_total",
      help: "Tokens from completed billable proxy requests by user and model.",
      labelNames: ["user_id", "model", "token_type"],
      registers: [registry],
    });
    this.userModelCostMicrosTotal = new Counter({
      name: "cch_user_model_cost_usd_micros_total",
      help: "Billable cost in micro-USD by user and model.",
      labelNames: ["user_id", "model"],
      registers: [registry],
    });

    this.userProviderRequestsTotal = new Counter({
      name: "cch_user_provider_requests_total",
      help: "Completed billable proxy requests by user and provider.",
      labelNames: ["user_id", "provider_id", "status"],
      registers: [registry],
    });
    this.userProviderTokensTotal = new Counter({
      name: "cch_user_provider_tokens_total",
      help: "Tokens from completed billable proxy requests by user and provider.",
      labelNames: ["user_id", "provider_id", "token_type"],
      registers: [registry],
    });
    this.userProviderCostMicrosTotal = new Counter({
      name: "cch_user_provider_cost_usd_micros_total",
      help: "Billable cost in micro-USD by user and provider.",
      labelNames: ["user_id", "provider_id"],
      registers: [registry],
    });

    this.generationTps = new Histogram({
      name: "cch_generation_tps",
      help: "Per-request generation tokens per second (output / (duration - TTFB)).",
      labelNames: ["model"],
      buckets: GENERATION_TPS_BUCKETS,
      registers: [registry],
    });

    this.userInfo = new Gauge({
      name: "cch_user_info",
      help: "User id to name mapping for Grafana joins.",
      labelNames: ["user_id", "user"],
      registers: [registry],
    });
    this.providerInfo = new Gauge({
      name: "cch_provider_info",
      help: "Provider id to name mapping for Grafana joins.",
      labelNames: ["provider_id", "provider"],
      registers: [registry],
    });

    this.concurrentSessions = new Gauge({
      name: "cch_concurrent_sessions",
      help: "Observed active sessions (SESSION_TTL idle window).",
      registers: [registry],
    });
    this.concurrentSessionsByUser = new Gauge({
      name: "cch_concurrent_sessions_by_user",
      help: "Observed active sessions by user (SESSION_TTL idle window).",
      labelNames: ["user_id"],
      registers: [registry],
    });
    this.concurrentSessionsByProvider = new Gauge({
      name: "cch_concurrent_sessions_by_provider",
      help: "Provider active sessions (SESSION_TTL idle window).",
      labelNames: ["provider_id"],
      registers: [registry],
    });
    this.inFlight = new Gauge({
      name: "cch_in_flight",
      help: "In-flight HTTP proxy requests (status_code IS NULL).",
      labelNames: ["user_id", "model", "provider_id"],
      registers: [registry],
    });
  }

  record(event: ProxyMetricEvent): void {
    if (!shouldRecordProxyMetric(event)) return;

    const userId = String(event.userId);
    const model = sanitizeLabel(event.model);
    const status = statusBucket(event.statusCode);
    const providerId = hasUsableProviderId(event.providerId) ? String(event.providerId) : null;

    this.userInfo.labels({ user_id: userId, user: sanitizeLabel(event.userName) }).set(1);
    if (providerId) {
      this.providerInfo
        .labels({ provider_id: providerId, provider: sanitizeLabel(event.providerName) })
        .set(1);
    }

    this.userRequestsTotal.inc({ user_id: userId, status });
    this.userModelRequestsTotal.inc({ user_id: userId, model, status });
    if (providerId) {
      this.requestsTotal.inc({ model, provider_id: providerId, status });
      this.userProviderRequestsTotal.inc({ user_id: userId, provider_id: providerId, status });
    }

    for (const token of tokenIncrements(event)) {
      this.userTokensTotal.inc({ user_id: userId, token_type: token.type }, token.value);
      this.userModelTokensTotal.inc(
        { user_id: userId, model, token_type: token.type },
        token.value
      );
      if (providerId) {
        this.tokensTotal.inc(
          { model, provider_id: providerId, token_type: token.type },
          token.value
        );
        this.userProviderTokensTotal.inc(
          { user_id: userId, provider_id: providerId, token_type: token.type },
          token.value
        );
      }
    }

    const costMicros = costUsdToMicros(event.costUsd);
    if (costMicros > 0) {
      this.userCostMicrosTotal.inc({ user_id: userId }, costMicros);
      this.userModelCostMicrosTotal.inc({ user_id: userId, model }, costMicros);
      if (providerId) {
        this.costMicrosTotal.inc({ model, provider_id: providerId }, costMicros);
        this.userProviderCostMicrosTotal.inc(
          { user_id: userId, provider_id: providerId },
          costMicros
        );
      }
    }

    const tps = generationTps(event);
    if (tps != null) {
      this.generationTps.observe({ model }, tps);
    }
  }

  applyGaugeSnapshot(snapshot: GaugeSnapshot): void {
    this.concurrentSessionsByUser.reset();
    this.concurrentSessionsByProvider.reset();
    this.inFlight.reset();

    this.concurrentSessions.set(snapshot.concurrentSessions);

    for (const row of snapshot.sessionsByUser) {
      if (row.count <= 0) continue;
      this.concurrentSessionsByUser.labels({ user_id: String(row.userId) }).set(row.count);
    }

    for (const row of snapshot.sessionsByProvider) {
      this.providerInfo
        .labels({
          provider_id: String(row.providerId),
          provider: sanitizeLabel(row.providerName),
        })
        .set(1);
      this.concurrentSessionsByProvider
        .labels({ provider_id: String(row.providerId) })
        .set(row.count);
    }

    for (const row of snapshot.inFlight) {
      if (row.count <= 0) continue;
      this.inFlight
        .labels({
          user_id: String(row.userId),
          model: sanitizeLabel(row.model),
          provider_id: String(row.providerId),
        })
        .set(row.count);
    }
  }
}

let singleton: CchMetrics | null = null;

export function getCchMetrics(): CchMetrics {
  if (!singleton) singleton = new CchMetrics();
  return singleton;
}

export function resetCchMetricsForTests(): void {
  singleton = null;
}
