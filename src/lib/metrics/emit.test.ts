import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { emitProxyMetrics, toProxyMetricEvent } from "./emit";
import { CchMetrics, resetCchMetricsForTests } from "./metrics";

const { recordSpy, emitClientProblemAlert } = vi.hoisted(() => ({
  recordSpy: vi.fn(),
  emitClientProblemAlert: vi.fn(),
}));

vi.mock("./metrics", async () => {
  const actual = await vi.importActual<typeof import("./metrics")>("./metrics");
  return {
    ...actual,
    getCchMetrics: () => ({ record: recordSpy }),
  };
});

vi.mock("@/lib/notification/client-problem-alert", () => ({
  emitClientProblemAlert,
}));

function createSession(overrides: Partial<ProxySession> = {}): ProxySession {
  return {
    userName: "alice",
    firstByteMs: 120,
    provider: { id: 5, name: "opus-pool" },
    messageContext: { user: { id: 12, name: "alice" } },
    authState: { user: { id: 12, name: "alice" } },
    getCurrentModel: () => "claude-sonnet-4",
    getManagedEndpoint: () => "/v1/messages",
    isWarmupRequest: () => false,
    ...overrides,
  } as unknown as ProxySession;
}

describe("toProxyMetricEvent", () => {
  it("maps session fields into a catalog event", () => {
    const event = toProxyMetricEvent(createSession(), {
      statusCode: 200,
      durationMs: 800,
      usageMetrics: { input_tokens: 3, output_tokens: 4 },
      costUsd: "0.02",
    });
    expect(event).toMatchObject({
      userId: 12,
      userName: "alice",
      providerId: 5,
      providerName: "opus-pool",
      model: "claude-sonnet-4",
      statusCode: 200,
      endpoint: "/v1/messages",
      isReplay: false,
      isWarmup: false,
      costUsd: "0.02",
      inputTokens: 3,
      outputTokens: 4,
      durationMs: 800,
      firstByteMs: 120,
    });
  });
});

describe("emitProxyMetrics", () => {
  const originalEnabled = process.env.METRICS_ENABLED;

  afterEach(() => {
    recordSpy.mockClear();
    emitClientProblemAlert.mockClear();
    resetCchMetricsForTests();
    if (originalEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = originalEnabled;
  });

  it("records once per session object", () => {
    const session = createSession();
    emitProxyMetrics(session, { statusCode: 200, durationMs: 10 });
    emitProxyMetrics(session, { statusCode: 500, durationMs: 20 });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0].statusCode).toBe(200);
    expect(emitClientProblemAlert).toHaveBeenCalledTimes(2);
  });

  it("no-ops when metrics are disabled", () => {
    process.env.METRICS_ENABLED = "false";
    emitProxyMetrics(createSession(), { statusCode: 200, durationMs: 10 });
    expect(recordSpy).not.toHaveBeenCalled();
    expect(emitClientProblemAlert).toHaveBeenCalledTimes(1);
  });
});

describe("CchMetrics singleton reset", () => {
  it("constructs a usable registry", () => {
    expect(new CchMetrics().registry).toBeDefined();
  });
});
