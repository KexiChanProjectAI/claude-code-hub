import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSerialEndpointCandidates: vi.fn(),
  handleSerialAttemptFailure: vi.fn(),
  selectAlternative: vi.fn(),
  markProviderFailed: vi.fn((_session: unknown, failed: number[], id: number) => {
    if (!failed.includes(id)) failed.push(id);
  }),
  clearSessionProviderBindings: vi.fn(async () => {}),
  isVendorTypeCircuitOpen: vi.fn(async () => false),
  buildExecutionStep: vi.fn(async (params: Record<string, unknown>) => ({
    stepId: params.stepId,
    attemptNumber: params.attemptNumber,
    delayMs: params.delayMs,
    isStreaming: true,
    provider: { id: (params.provider as { id: number }).id },
    endpoint: params.endpoint,
    applyProviderOverrides: params.applyProviderOverrides,
  })),
  handle: vi.fn(async () => new Response('{"error":{"message":"x"}}', { status: 503 })),
  decrementConcurrentCount: vi.fn(async () => {}),
  decrementObservedConcurrentCount: vi.fn(async () => {}),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

vi.mock("@/app/v1/_lib/proxy/forwarder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/forwarder")>();
  return {
    ...actual,
    ProxyForwarder: {
      resolveSerialEndpointCandidates: mocks.resolveSerialEndpointCandidates,
      handleSerialAttemptFailure: mocks.handleSerialAttemptFailure,
      selectAlternative: mocks.selectAlternative,
      markProviderFailed: mocks.markProviderFailed,
      clearSessionProviderBindings: mocks.clearSessionProviderBindings,
      buildAllProvidersUnavailableError: actual.ProxyForwarder.buildAllProvidersUnavailableError,
    },
  };
});

vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: mocks.isVendorTypeCircuitOpen,
}));

vi.mock("@/app/v1/_lib/edge/step-builder", () => ({
  buildExecutionStep: mocks.buildExecutionStep,
}));

vi.mock("@/app/v1/_lib/proxy/error-handler", () => ({
  ProxyErrorHandler: { handle: mocks.handle },
}));

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    decrementConcurrentCount: mocks.decrementConcurrentCount,
    decrementObservedConcurrentCount: mocks.decrementObservedConcurrentCount,
  },
}));

import {
  type EdgeRuntime,
  enterProvider,
  handleSerialFailure,
  planNextSerialStep,
} from "@/app/v1/_lib/edge/coordinator";
import type { EdgeRequestState } from "@/app/v1/_lib/edge/state-store";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function provider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `p${id}`,
    url: `https://p${id}.example.com`,
    providerType: "claude",
    providerVendorId: 0,
    maxRetryAttempts: 2,
    priority: 0,
    ...overrides,
  } as Provider;
}

function makeRuntime(): EdgeRuntime {
  const session = ProxySession.fromEdgeDigest({
    receivedAtMs: Date.now(),
    method: "POST",
    requestUrl: new URL("http://edge.local/v1/messages"),
    headers: new Headers(),
    syntheticMessage: { model: "m", stream: true, messages: [{}] },
    hints: { messagesHash: null, fingerprint: null, isProbe: false, isWarmup: false },
  });
  session.setRawCrossProviderFallbackEnabled(false);
  const state = {
    requestId: 42,
    heartbeatIntervalMs: 15_000,
    body: { originalTopLevel: {}, hasPrivateParams: false, contentOps: [] },
    attempts: [],
    totalProvidersAttempted: 0,
    failedProviderIds: [],
    providerAttempts: [],
    pendingRectifierAudits: [],
    concurrency: { sessionId: "sess", observedIdentity: "obs" },
    phase: "executing",
  } as unknown as EdgeRequestState;
  return { state, session, settings: {} as never };
}

function endpoints(...urls: string[]) {
  return {
    endpointCandidates: urls.map((url, index) => ({ endpointId: index + 1, baseUrl: url })),
    isMcpRequest: false,
    endpointPolicy: {},
    shouldAccountCircuitBreaker: true,
    blocked: false,
  };
}

describe("edge serial coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSerialEndpointCandidates.mockResolvedValue(endpoints("https://a", "https://b"));
  });

  test("first step uses the first endpoint and applies provider overrides once", async () => {
    const rt = makeRuntime();
    await enterProvider(rt, provider(1));
    const first = await planNextSerialStep(rt);
    expect(first.kind).toBe("step");
    expect(mocks.buildExecutionStep.mock.calls[0][0]).toMatchObject({
      stepId: "42:1:1",
      attemptNumber: 1,
      applyProviderOverrides: true,
      endpoint: { endpointId: 1, baseUrl: "https://a" },
    });
    expect(rt.state.attempts).toHaveLength(1);
    expect(rt.state.attempts[0]).toMatchObject({ providerId: 1, status: "inflight" });

    await planNextSerialStep(rt, 100);
    expect(mocks.buildExecutionStep.mock.calls[1][0]).toMatchObject({
      stepId: "42:1:2",
      applyProviderOverrides: false,
      delayMs: 100,
    });
  });

  test("retry decisions advance endpoints and record deferred signature rectifier", async () => {
    const rt = makeRuntime();
    await enterProvider(rt, provider(1));
    await planNextSerialStep(rt);
    mocks.handleSerialAttemptFailure.mockResolvedValueOnce({
      action: "retry",
      delayMs: 0,
      advanceEndpoint: true,
      maxAttemptsPerProvider: 3,
      rectifierType: "thinking_signature_rectifier",
      rectifierTrigger: "invalid_signature_in_thinking_block",
    });
    const outcome = await handleSerialFailure(rt, {
      stepId: "42:1:1",
      error: new Error("x"),
      dispatched: true,
      firstByteSeen: false,
      healthElapsedMs: 12,
    });
    expect(outcome.kind).toBe("step");
    expect(rt.state.attempts[0].status).toBe("failed");
    expect(rt.state.providerAttempts[0]).toMatchObject({
      currentEndpointIndex: 1,
      maxAttemptsPerProvider: 3,
    });
    expect(rt.state.body.contentOps).toEqual([{ op: "apply_thinking_signature_rectifier" }]);
    expect(rt.state.pendingRectifierAudits[0]).toMatchObject({
      stepId: "42:1:2",
      trigger: "invalid_signature_in_thinking_block",
      attemptNumber: 1,
      retryAttemptNumber: 2,
    });
    const failureContext = mocks.handleSerialAttemptFailure.mock.calls[0][0];
    expect(failureContext.getAttemptElapsedMs()).toBe(12);
    expect(failureContext.attemptDispatched).toBe(true);
  });

  test("switching providers enters the alternative and resets per-provider state", async () => {
    const rt = makeRuntime();
    await enterProvider(rt, provider(1));
    await planNextSerialStep(rt);
    mocks.handleSerialAttemptFailure.mockImplementationOnce(async (context) => {
      context.failedProviderIds.push(1);
      return { action: "switch_provider" };
    });
    mocks.selectAlternative.mockResolvedValueOnce(provider(2));
    const outcome = await handleSerialFailure(rt, {
      stepId: "42:1:1",
      error: new Error("x"),
      dispatched: true,
      firstByteSeen: false,
      healthElapsedMs: 0,
    });
    expect(outcome.kind).toBe("step");
    expect(rt.session.provider?.id).toBe(2);
    expect(rt.state.totalProvidersAttempted).toBe(2);
    expect(mocks.selectAlternative).toHaveBeenCalledWith(rt.session, [1]);
    expect(mocks.buildExecutionStep.mock.calls.at(-1)?.[0]).toMatchObject({
      stepId: "42:2:1",
      applyProviderOverrides: true,
    });
  });

  test("exhausting providers settles with the all-unavailable error and releases concurrency", async () => {
    const rt = makeRuntime();
    await enterProvider(rt, provider(1));
    await planNextSerialStep(rt);
    const upstream = new ProxyError("upstream down", 502);
    mocks.handleSerialAttemptFailure.mockResolvedValueOnce({ action: "switch_provider" });
    mocks.selectAlternative.mockResolvedValueOnce(null);
    const outcome = await handleSerialFailure(rt, {
      stepId: "42:1:1",
      error: upstream,
      dispatched: true,
      firstByteSeen: false,
      healthElapsedMs: 0,
    });
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.response.status).toBe(503);
      expect(outcome.response.bodyText).toBe('{"error":{"message":"x"}}');
    }
    expect(mocks.clearSessionProviderBindings).toHaveBeenCalled();
    const handled = mocks.handle.mock.calls[0][1] as ProxyError;
    expect(handled.statusCode).toBe(503);
    expect(mocks.decrementConcurrentCount).toHaveBeenCalledWith("sess");
    expect(mocks.decrementObservedConcurrentCount).toHaveBeenCalledWith("obs");
    expect(rt.state.phase).toBe("settled");
  });

  test("throw decisions settle the request with the original error", async () => {
    const rt = makeRuntime();
    await enterProvider(rt, provider(1));
    await planNextSerialStep(rt);
    const clientError = new ProxyError("bad request", 400);
    mocks.handleSerialAttemptFailure.mockResolvedValueOnce({ action: "throw", error: clientError });
    const outcome = await handleSerialFailure(rt, {
      stepId: "42:1:1",
      error: clientError,
      dispatched: true,
      firstByteSeen: false,
      healthElapsedMs: 0,
    });
    expect(outcome.kind).toBe("fail");
    expect(mocks.handle).toHaveBeenCalledWith(rt.session, clientError);
  });

  test("blocked providers and open vendor circuits are skipped", async () => {
    const rt = makeRuntime();
    mocks.resolveSerialEndpointCandidates.mockResolvedValueOnce({
      ...endpoints(),
      blocked: true,
    });
    expect(await enterProvider(rt, provider(1))).toBeNull();

    mocks.isVendorTypeCircuitOpen.mockResolvedValueOnce(true);
    expect(await enterProvider(rt, provider(2, { providerVendorId: 7 }))).toBeNull();
    expect(rt.state.failedProviderIds).toEqual([2]);
    expect(rt.state.totalProvidersAttempted).toBe(2);
  });

  test("unknown step ids are rejected", async () => {
    const rt = makeRuntime();
    await enterProvider(rt, provider(1));
    await expect(
      handleSerialFailure(rt, {
        stepId: "nope",
        error: new Error("x"),
        dispatched: false,
        firstByteSeen: false,
        healthElapsedMs: 0,
      })
    ).rejects.toThrow("does not match");
  });
});
