import { describe, expect, it } from "vitest";
import type { ProxyMetricEvent } from "./catalog";
import { CchMetrics } from "./metrics";

function event(overrides: Partial<ProxyMetricEvent> = {}): ProxyMetricEvent {
  return {
    userId: 12,
    userName: "alice",
    providerId: 5,
    providerName: "opus-pool",
    model: "claude-sonnet-4",
    statusCode: 200,
    endpoint: "/v1/messages",
    isReplay: false,
    isWarmup: false,
    blockedBy: null,
    costUsd: "0.01",
    inputTokens: 20,
    outputTokens: 10,
    cacheCreationTokens: 4,
    cacheReadTokens: 2,
    durationMs: 1100,
    firstByteMs: 100,
    ...overrides,
  };
}

describe("CchMetrics.record", () => {
  it("increments the 2D counter families and generation histogram", async () => {
    const metrics = new CchMetrics();
    metrics.record(event());
    const body = await metrics.registry.metrics();

    expect(body).toContain(
      'cch_requests_total{model="claude-sonnet-4",provider_id="5",status="2xx"} 1'
    );
    expect(body).toContain('cch_user_requests_total{user_id="12",status="2xx"} 1');
    expect(body).toContain(
      'cch_user_model_requests_total{user_id="12",model="claude-sonnet-4",status="2xx"} 1'
    );
    expect(body).toContain(
      'cch_user_provider_requests_total{user_id="12",provider_id="5",status="2xx"} 1'
    );
    expect(body).toContain(
      'cch_tokens_total{model="claude-sonnet-4",provider_id="5",token_type="output"} 10'
    );
    expect(body).toContain('cch_user_tokens_total{user_id="12",token_type="input"} 20');
    expect(body).toContain(
      'cch_cost_usd_micros_total{model="claude-sonnet-4",provider_id="5"} 10000'
    );
    expect(body).toContain('cch_user_cost_usd_micros_total{user_id="12"} 10000');
    expect(body).toContain('cch_user_info{user_id="12",user="alice"} 1');
    expect(body).toContain('cch_provider_info{provider_id="5",provider="opus-pool"} 1');
    expect(body).toContain('cch_generation_tps_bucket{le="120",model="claude-sonnet-4"} 1');
  });

  it("skips provider families without a provider and ignores filtered events", async () => {
    const metrics = new CchMetrics();
    metrics.record(event({ providerId: null, costUsd: "0", outputTokens: 0, firstByteMs: null }));
    metrics.record(event({ isWarmup: true }));
    const body = await metrics.registry.metrics();

    expect(body).toContain('cch_user_requests_total{user_id="12",status="2xx"} 1');
    expect(body).not.toContain("cch_requests_total{");
    expect(body).not.toContain("cch_user_provider_requests_total{");
    expect(body).not.toContain("cch_generation_tps_count");
  });
});

describe("CchMetrics.applyGaugeSnapshot", () => {
  it("exports concurrent and sparse in-flight gauges", async () => {
    const metrics = new CchMetrics();
    metrics.applyGaugeSnapshot({
      concurrentSessions: 4,
      sessionsByUser: [{ userId: 12, count: 2 }],
      sessionsByProvider: [{ providerId: 5, providerName: "opus-pool", count: 3 }],
      inFlight: [{ userId: 12, model: "claude-sonnet-4", providerId: 5, count: 1 }],
    });
    const body = await metrics.registry.metrics();
    expect(body).toContain("cch_concurrent_sessions 4");
    expect(body).toContain('cch_concurrent_sessions_by_user{user_id="12"} 2');
    expect(body).toContain('cch_concurrent_sessions_by_provider{provider_id="5"} 3');
    expect(body).toContain('cch_in_flight{user_id="12",model="claude-sonnet-4",provider_id="5"} 1');

    metrics.applyGaugeSnapshot({
      concurrentSessions: 0,
      sessionsByUser: [],
      sessionsByProvider: [],
      inFlight: [],
    });
    const cleared = await metrics.registry.metrics();
    expect(cleared).toContain("cch_concurrent_sessions 0");
    expect(cleared).not.toContain("cch_in_flight{");
    expect(cleared).not.toContain("cch_concurrent_sessions_by_user{");
  });
});
