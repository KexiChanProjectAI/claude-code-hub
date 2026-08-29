import { describe, expect, it } from "vitest";
import {
  costUsdToMicros,
  generationTps,
  hasUsableProviderId,
  sanitizeLabel,
  shouldRecordProxyMetric,
  statusBucket,
  tokenIncrements,
  UNKNOWN_LABEL,
  type ProxyMetricEvent,
} from "./catalog";

function baseEvent(overrides: Partial<ProxyMetricEvent> = {}): ProxyMetricEvent {
  return {
    userId: 12,
    userName: "alice",
    providerId: 5,
    providerName: "pool",
    model: "claude-sonnet-4",
    statusCode: 200,
    endpoint: "/v1/messages",
    isReplay: false,
    isWarmup: false,
    blockedBy: null,
    ...overrides,
  };
}

describe("statusBucket", () => {
  it("maps 2xx/3xx to 2xx, 4xx including 499, 5xx, and other", () => {
    expect(statusBucket(200)).toBe("2xx");
    expect(statusBucket(301)).toBe("2xx");
    expect(statusBucket(404)).toBe("4xx");
    expect(statusBucket(499)).toBe("4xx");
    expect(statusBucket(500)).toBe("5xx");
    expect(statusBucket(199)).toBe("other");
    expect(statusBucket(Number.NaN)).toBe("other");
  });
});

describe("costUsdToMicros", () => {
  it("converts decimal dollars to integer micro-USD", () => {
    expect(costUsdToMicros("0.001234")).toBe(1234);
    expect(costUsdToMicros(0.05)).toBe(50_000);
    expect(costUsdToMicros("0")).toBe(0);
    expect(costUsdToMicros(null)).toBe(0);
    expect(costUsdToMicros("nope")).toBe(0);
    expect(costUsdToMicros(-1)).toBe(0);
  });
});

describe("sanitizeLabel", () => {
  it("strips newlines, trims, and falls back", () => {
    expect(sanitizeLabel("  opus\n ")).toBe("opus");
    expect(sanitizeLabel("")).toBe(UNKNOWN_LABEL);
    expect(sanitizeLabel(null)).toBe(UNKNOWN_LABEL);
    expect(sanitizeLabel("a".repeat(200)).length).toBe(128);
  });
});

describe("generationTps", () => {
  it("uses duration minus TTFB and requires a 100ms window", () => {
    expect(generationTps({ outputTokens: 100, durationMs: 1100, firstByteMs: 100 })).toBe(100);
    expect(generationTps({ outputTokens: 50, durationMs: 150, firstByteMs: 51 })).toBeNull();
    expect(generationTps({ outputTokens: 50, durationMs: 1000, firstByteMs: null })).toBeNull();
    expect(generationTps({ outputTokens: 0, durationMs: 1000, firstByteMs: 100 })).toBeNull();
  });
});

describe("shouldRecordProxyMetric", () => {
  it("records billable completed requests", () => {
    expect(shouldRecordProxyMetric(baseEvent())).toBe(true);
  });

  it("skips replay, warmup, blocked, non-billing, and missing user", () => {
    expect(shouldRecordProxyMetric(baseEvent({ isReplay: true }))).toBe(false);
    expect(shouldRecordProxyMetric(baseEvent({ isWarmup: true }))).toBe(false);
    expect(shouldRecordProxyMetric(baseEvent({ blockedBy: "sensitive_word" }))).toBe(false);
    expect(shouldRecordProxyMetric(baseEvent({ endpoint: "/v1/messages/count_tokens" }))).toBe(
      false
    );
    expect(shouldRecordProxyMetric(baseEvent({ endpoint: "/v1/responses/compact" }))).toBe(false);
    expect(shouldRecordProxyMetric(baseEvent({ userId: null }))).toBe(false);
    expect(shouldRecordProxyMetric(baseEvent({ userId: 0 }))).toBe(false);
  });
});

describe("tokenIncrements", () => {
  it("emits only positive token types", () => {
    expect(
      tokenIncrements(
        baseEvent({
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
        })
      )
    ).toEqual([
      { type: "input", value: 10 },
      { type: "cache_read", value: 3 },
      { type: "cache_creation", value: 2 },
    ]);
  });
});

describe("hasUsableProviderId", () => {
  it("rejects missing and non-positive ids", () => {
    expect(hasUsableProviderId(5)).toBe(true);
    expect(hasUsableProviderId(null)).toBe(false);
    expect(hasUsableProviderId(0)).toBe(false);
  });
});
