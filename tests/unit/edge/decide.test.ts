import { beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "./fake-redis";

const mocks = vi.hoisted(() => ({
  redis: null as unknown,
  settings: {} as Record<string, unknown>,
  sensitiveEmpty: true,
  bodyFilters: { global: false, provider: false, final: false } as Record<string, boolean>,
  auth: vi.fn(async (_session: unknown): Promise<Response | null> => null),
  client: vi.fn(async (): Promise<Response | null> => null),
  model: vi.fn(async (): Promise<Response | null> => null),
  version: vi.fn(async (): Promise<Response | null> => null),
  sessionGuard: vi.fn(async (session: { setSessionId: (id: string) => void }) => {
    session.setSessionId("sess_d");
  }),
  requestFilter: vi.fn(async () => {}),
  rateLimit: vi.fn(async () => {}),
  providerResolver: vi.fn(async (_session: unknown): Promise<Response | null> => null),
  providerRequestFilter: vi.fn(async () => {}),
  ensureContext: vi.fn(async (session: Record<string, unknown>) => {
    session.messageContext = {
      id: 555,
      createdAt: new Date(),
      user: { id: 1, name: "u" },
      key: { id: 2, name: "k" },
      apiKey: "sk",
    };
  }),
  handle: vi.fn(async () => new Response('{"error":{"message":"limited"}}', { status: 429 })),
  trackObserved: vi.fn(async () => "obs-1"),
  incrementConcurrentCount: vi.fn(async () => {}),
  incrementObservedConcurrentCount: vi.fn(async () => {}),
  enterProvider: vi.fn(async () => ({})),
  planNextSerialStep: vi.fn(async () => ({
    kind: "step",
    step: { stepId: "555:1:1", provider: { id: 9 } },
  })),
  releaseEdgeConcurrency: vi.fn(async () => {}),
  releaseProviderSessionRef: vi.fn(),
  startHedge: vi.fn(async () => ({
    kind: "step",
    step: { stepId: "555:h1:1", provider: { id: 9 } },
  })),
}));

const PROVIDER = {
  id: 9,
  name: "p9",
  providerType: "claude",
  groupTag: null,
  firstByteTimeoutStreamingMs: 0,
};

vi.mock("@/lib/redis/client", () => ({ getRedisClient: () => mocks.redis }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, getCachedSystemSettings: vi.fn(async () => mocks.settings) };
});
vi.mock("@/lib/sensitive-word-detector", () => ({
  sensitiveWordDetector: { isEmpty: () => mocks.sensitiveEmpty },
}));
vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    hasBodyFiltersForEdge: vi.fn(
      async (_session: unknown, phase: string) => mocks.bodyFilters[phase]
    ),
  },
}));
vi.mock("@/app/v1/_lib/proxy/auth-guard", () => ({ ProxyAuthenticator: { ensure: mocks.auth } }));
vi.mock("@/app/v1/_lib/proxy/client-guard", () => ({ ProxyClientGuard: { ensure: mocks.client } }));
vi.mock("@/app/v1/_lib/proxy/model-guard", () => ({ ProxyModelGuard: { ensure: mocks.model } }));
vi.mock("@/app/v1/_lib/proxy/version-guard", () => ({
  ProxyVersionGuard: { ensure: mocks.version },
}));
vi.mock("@/app/v1/_lib/proxy/session-guard", () => ({
  ProxySessionGuard: { ensure: mocks.sessionGuard },
}));
vi.mock("@/app/v1/_lib/proxy/request-filter", () => ({
  ProxyRequestFilter: { ensure: mocks.requestFilter },
}));
vi.mock("@/app/v1/_lib/proxy/rate-limit-guard", () => ({
  ProxyRateLimitGuard: { ensure: mocks.rateLimit },
}));
vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: { ensure: mocks.providerResolver },
}));
vi.mock("@/app/v1/_lib/proxy/provider-request-filter", () => ({
  ProxyProviderRequestFilter: { ensure: mocks.providerRequestFilter },
}));
vi.mock("@/app/v1/_lib/proxy/message-service", () => ({
  ProxyMessageService: { ensureContext: mocks.ensureContext },
}));
vi.mock("@/app/v1/_lib/proxy/error-handler", () => ({
  ProxyErrorHandler: { handle: mocks.handle },
}));
vi.mock("@/app/v1/_lib/proxy-handler", () => ({
  trackObservedSessionForRequest: mocks.trackObserved,
}));
vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    incrementConcurrentCount: mocks.incrementConcurrentCount,
    incrementObservedConcurrentCount: mocks.incrementObservedConcurrentCount,
  },
}));
vi.mock("@/app/v1/_lib/edge/coordinator", () => ({
  enterProvider: mocks.enterProvider,
  planNextSerialStep: mocks.planNextSerialStep,
  releaseEdgeConcurrency: mocks.releaseEdgeConcurrency,
}));
vi.mock("@/app/v1/_lib/edge/hedge-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/edge/hedge-coordinator")>();
  return { ...actual, startHedge: mocks.startHedge };
});
vi.mock("@/app/v1/_lib/proxy/forwarder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/forwarder")>();
  return {
    ...actual,
    ProxyForwarder: { releaseProviderSessionRef: mocks.releaseProviderSessionRef },
  };
});

import type { RequestDigest } from "@/app/v1/_lib/edge/contract";
import { handleEdgeDecide } from "@/app/v1/_lib/edge/decide";
import { buildRequestDigest } from "@/app/v1/_lib/edge/digest";
import { EDGE_DEADLINES_KEY, loadEdgeState } from "@/app/v1/_lib/edge/state-store";

function digest(overrides: Partial<RequestDigest> = {}, body?: Record<string, unknown>) {
  return {
    ...buildRequestDigest({
      edgeId: "edge-1",
      edgeRequestId: `r-${Math.random()}`,
      receivedAtMs: Date.now(),
      method: "POST",
      path: "/v1/messages",
      headers: [["user-agent", "claude-cli/2.1.90"]],
      clientIp: null,
      body: body ?? { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
      bodyBytes: 10,
    }),
    ...overrides,
  };
}

function selectProvider(overrides: Record<string, unknown> = {}) {
  mocks.providerResolver.mockImplementation(async (session) => {
    (session as { setProvider: (p: unknown) => void }).setProvider({ ...PROVIDER, ...overrides });
    return null;
  });
}

describe("edge decide", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = new FakeRedis();
    mocks.redis = redis;
    mocks.settings = { edgeExecutionEnabled: true, discoveryEnabled: false };
    mocks.sensitiveEmpty = true;
    mocks.bodyFilters = { global: false, provider: false, final: false };
    selectProvider();
  });

  test("runs the guard chain, counts concurrency and returns the first step", async () => {
    const request = digest();
    const response = await handleEdgeDecide(request, "edge-1");
    expect(response).toMatchObject({
      action: "execute",
      requestId: 555,
      step: { stepId: "555:1:1" },
    });
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.incrementConcurrentCount).toHaveBeenCalledWith("sess_d");
    expect(mocks.incrementObservedConcurrentCount).toHaveBeenCalledWith("obs-1");

    const state = await loadEdgeState(555);
    expect(state).toMatchObject({
      phase: "executing",
      mode: "serial",
      edgeId: "edge-1",
      concurrency: { sessionId: "sess_d", observedIdentity: "obs-1" },
    });
    expect(state?.session.routingTrace?.mode).toBe("legacy_serial");
    expect(redis.score(EDGE_DEADLINES_KEY, "555")).toBeGreaterThan(Date.now());

    const replay = await handleEdgeDecide(request, "edge-1");
    expect(replay).toEqual(response);
    expect(mocks.ensureContext).toHaveBeenCalledTimes(1);
  });

  test("request-level ineligibility delegates before any side effect", async () => {
    mocks.settings = { edgeExecutionEnabled: false };
    expect(await handleEdgeDecide(digest(), "edge-1")).toEqual({
      action: "delegate",
      reason: "edge_disabled",
    });
    mocks.settings = { edgeExecutionEnabled: true };
    mocks.sensitiveEmpty = false;
    expect(await handleEdgeDecide(digest(), "edge-1")).toMatchObject({
      reason: "sensitive_words_configured",
    });
    mocks.sensitiveEmpty = true;
    mocks.bodyFilters.global = true;
    expect(await handleEdgeDecide(digest(), "edge-1")).toMatchObject({
      reason: "request_filter_body_ops",
    });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  test("provider-level ineligibility releases the provider session reference", async () => {
    selectProvider({ providerType: "codex" });
    expect(await handleEdgeDecide(digest(), "edge-1")).toEqual({
      action: "delegate",
      reason: "provider_type",
    });
    expect(mocks.releaseProviderSessionRef).toHaveBeenCalledWith(expect.anything(), 9);
    expect(mocks.ensureContext).not.toHaveBeenCalled();

    selectProvider();
    mocks.bodyFilters.final = true;
    expect(await handleEdgeDecide(digest(), "edge-1")).toMatchObject({
      reason: "provider_request_filter_body_ops",
    });
  });

  test("streaming requests with a first-byte threshold run in hedge mode", async () => {
    selectProvider({ firstByteTimeoutStreamingMs: 5000 });
    mocks.settings = { ...mocks.settings, legacyHedgeMaxInFlight: 3, billHedgeLosers: true };
    expect(await handleEdgeDecide(digest(), "edge-1")).toMatchObject({
      action: "execute",
      step: { stepId: "555:h1:1" },
    });
    expect(mocks.startHedge).toHaveBeenCalledTimes(1);
    expect(mocks.enterProvider).not.toHaveBeenCalled();
    const state = await loadEdgeState(555);
    expect(state?.mode).toBe("hedge");
    expect(state?.hedge).toMatchObject({
      maxInFlight: 3,
      billLosers: true,
      initialProviderId: 9,
      noMoreProviders: false,
    });
    expect(state?.session.routingTrace?.mode).toBe("legacy_hedge");

    const nonStream = digest(
      {},
      { model: "m", stream: false, messages: [{ role: "user", content: "x" }] }
    );
    expect(await handleEdgeDecide(nonStream, "edge-1")).toMatchObject({ action: "execute" });
    expect(mocks.planNextSerialStep).toHaveBeenCalledTimes(1);
  });

  test("responses requests record input normalization and replay it as the first op", async () => {
    selectProvider({ providerType: "codex" });
    const request = {
      ...buildRequestDigest({
        edgeId: "edge-1",
        edgeRequestId: "r-responses",
        receivedAtMs: Date.now(),
        method: "POST",
        path: "/v1/responses",
        headers: [["user-agent", "codex_cli_rs/0.50.0"]],
        clientIp: null,
        body: { model: "gpt-5-codex", stream: false, input: "hello" },
        bodyBytes: 10,
      }),
    };
    expect(await handleEdgeDecide(request, "edge-1")).toMatchObject({ action: "execute" });
    const state = await loadEdgeState(555);
    expect(state?.body.contentOps).toEqual([{ op: "normalize_response_input" }]);
    expect(state?.session.originalFormat).toBe("response");
    expect(state?.session.specialSettings).toContainEqual({
      type: "response_input_rectifier",
      scope: "request",
      hit: true,
      action: "string_to_array",
      originalType: "string",
    });
  });

  test("guard early responses become fail payloads with the session id suffix", async () => {
    mocks.model.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "model not allowed", type: "x" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    const response = await handleEdgeDecide(digest(), "edge-1");
    expect(response.action).toBe("fail");
    if (response.action === "fail") {
      expect(response.response.status).toBe(400);
      expect(response.response.bodyText).toContain("model not allowed");
    }
  });

  test("thrown guard errors go through the proxy error handler", async () => {
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limited"));
    const response = await handleEdgeDecide(digest(), "edge-1");
    expect(response).toMatchObject({ action: "fail", response: { status: 429 } });
    expect(mocks.handle).toHaveBeenCalledTimes(1);
  });

  test("planning failures release concurrency", async () => {
    mocks.planNextSerialStep.mockRejectedValueOnce(new Error("boom"));
    const response = await handleEdgeDecide(digest(), "edge-1");
    expect(response.action).toBe("fail");
    expect(mocks.releaseEdgeConcurrency).toHaveBeenCalledTimes(1);
  });

  test("delegates when the state store is unavailable", async () => {
    mocks.redis = null;
    expect(await handleEdgeDecide(digest(), "edge-1")).toEqual({
      action: "delegate",
      reason: "state_store_unavailable",
    });
  });
});
