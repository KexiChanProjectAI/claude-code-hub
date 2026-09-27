import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";

const mocks = vi.hoisted(() => {
  return {
    getCachedSystemSettings: vi.fn(async () => ({
      enableThinkingSignatureRectifier: true,
      enableThinkingBudgetRectifier: true,
      enableThinkingEffortConflictRectifier: true,
    })),
    getPreferredProviderEndpoints: vi.fn(),
    getEndpointFilterStats: vi.fn(async () => ({ total: 0, enabled: 0, circuitOpen: 0 })),
    recordEndpointFailure: vi.fn(async () => {}),
    recordEndpointSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    recordSuccess: vi.fn(),
    getCircuitState: vi.fn(() => "closed"),
    getProviderHealthInfo: vi.fn(async () => ({
      health: { failureCount: 0 },
      config: { failureThreshold: 3 },
    })),
    isVendorTypeCircuitOpen: vi.fn(async () => false),
    recordVendorTypeAllEndpointsTimeout: vi.fn(async () => {}),
    tombstoneAffinityOnFailure: vi.fn(async () => {}),
    recordAffinityWinner: vi.fn(async () => {}),
    clearSessionProvider: vi.fn(async () => {}),
    categorizeErrorAsync: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, getCachedSystemSettings: mocks.getCachedSystemSettings };
});

vi.mock("@/lib/provider-endpoints/endpoint-selector", () => ({
  getPreferredProviderEndpoints: mocks.getPreferredProviderEndpoints,
  getEndpointFilterStats: mocks.getEndpointFilterStats,
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointFailure: mocks.recordEndpointFailure,
  recordEndpointSuccess: mocks.recordEndpointSuccess,
}));

vi.mock("@/lib/circuit-breaker", () => ({
  getCircuitState: mocks.getCircuitState,
  getProviderHealthInfo: mocks.getProviderHealthInfo,
  recordFailure: mocks.recordFailure,
  recordSuccess: mocks.recordSuccess,
}));

vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: mocks.isVendorTypeCircuitOpen,
  recordVendorTypeAllEndpointsTimeout: mocks.recordVendorTypeAllEndpointsTimeout,
}));

vi.mock("@/app/v1/_lib/proxy/affinity/affinity-recorder", () => ({
  tombstoneAffinityOnFailure: mocks.tombstoneAffinityOnFailure,
  recordAffinityWinner: mocks.recordAffinityWinner,
}));

vi.mock("@/lib/session-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session-manager")>();
  return {
    ...actual,
    SessionManager: Object.assign(Object.create(actual.SessionManager), {
      clearSessionProvider: mocks.clearSessionProvider,
    }),
  };
});

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    categorizeErrorAsync: mocks.categorizeErrorAsync,
    getErrorDetectionResultAsync: vi.fn(async () => ({ matched: false })),
  };
});

import {
  createTransportError,
  EmptyResponseError,
  ErrorCategory,
  isTransportError,
  ProxyError,
} from "@/app/v1/_lib/proxy/errors";
import {
  buildFirstValidContentTimeoutError,
  buildProviderResponseTimeoutError,
  buildStreamingIdleTimeoutError,
  ProxyForwarder,
  type ReactiveRectifierParams,
  type SerialAttemptFailureContext,
} from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 7,
    name: "p7",
    url: "https://provider.example.com",
    key: "k",
    providerVendorId: 0,
    isEnabled: true,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: null,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 10_000,
    requestTimeoutNonStreamingMs: 600_000,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as Provider;
}

function createSession(pathname = "/v1/messages"): ProxySession {
  const requestUrl = new URL(`https://example.com${pathname}`);
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);
  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl,
    headers,
    originalHeaders: new Headers(headers),
    headerLog: "{}",
    request: {
      model: "claude-sonnet-4",
      log: "(test)",
      message: { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "u",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    endpointPolicy: resolveEndpointPolicy(requestUrl.pathname),
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    providersSnapshot: [],
    getEndpointPolicy() {
      return this.endpointPolicy;
    },
    isHeaderModified: () => false,
  });
  session.setRawCrossProviderFallbackEnabled(false);
  return session as ProxySession;
}

function buildContext(
  overrides: Partial<SerialAttemptFailureContext> & { error: Error }
): SerialAttemptFailureContext {
  const session = overrides.session ?? createSession();
  const provider = overrides.provider ?? createProvider();
  return {
    session,
    provider,
    activeEndpoint: { endpointId: 11, baseUrl: "https://ep1.example.com" },
    endpointAudit: { endpointId: 11, endpointUrl: "https://ep1.example.com" },
    endpointPolicy: session.getEndpointPolicy(),
    attemptCount: 1,
    maxAttemptsPerProvider: 2,
    totalProvidersAttempted: 1,
    rawCrossProviderFallbackEnabled: false,
    shouldSkipRawRetryAndProviderSwitch: false,
    shouldAccountCircuitBreaker: true,
    isMcpRequest: false,
    endpointCandidateKeys: new Set(["11:https://ep1.example.com"]),
    timedOutEndpointKeys: new Set(),
    failedProviderIds: [],
    reactiveRectifierRetryState: {
      thinkingSignatureRetried: false,
      thinkingBudgetRetried: false,
      thinkingEffortConflictRetried: false,
      geminiFunctionIdRetried: false,
    },
    currentEndpointIndex: 0,
    endpointCandidateCount: 1,
    attemptDispatched: true,
    attemptFirstByteSeen: false,
    getAttemptElapsedMs: () => 0,
    applyReactiveRectifier: async () => ({ matched: false }),
    ...overrides,
  };
}

function upstreamError(status: number, body = '{"error":{"message":"boom"}}'): ProxyError {
  return ProxyError.fromUpstreamSnapshot(
    {
      status,
      statusText: "",
      headers: new Headers({ "content-type": "application/json" }),
      bodyText: body,
    },
    { id: 7, name: "p7" }
  );
}

describe("ProxyForwarder.handleSerialAttemptFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);
  });

  test("provider error with attempts left retries the same endpoint after 100ms", async () => {
    const ctx = buildContext({ error: upstreamError(500) });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toEqual({
      action: "retry",
      delayMs: 100,
      advanceEndpoint: false,
      maxAttemptsPerProvider: 2,
    });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(mocks.tombstoneAffinityOnFailure).toHaveBeenCalledWith(ctx.session, 7);
    const chain = ctx.session.getProviderChain();
    expect(chain.at(-1)).toMatchObject({ reason: "retry_failed", statusCode: 500 });
  });

  test("524 timeout advances the endpoint and records endpoint failure", async () => {
    const ctx = buildContext({
      error: buildProviderResponseTimeoutError(createProvider(), "streaming_first_byte", 1000),
    });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toMatchObject({ action: "retry", advanceEndpoint: true, delayMs: 100 });
    expect(ctx.timedOutEndpointKeys.size).toBe(1);
    expect(mocks.recordEndpointFailure).toHaveBeenCalledWith(11, ctx.error);
  });

  test("provider error on the last attempt records circuit failure and switches", async () => {
    const ctx = buildContext({ error: upstreamError(502), attemptCount: 2 });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toEqual({ action: "switch_provider" });
    expect(mocks.recordFailure).toHaveBeenCalledWith(7, ctx.error);
    expect(ctx.failedProviderIds).toEqual([7]);
  });

  test("all endpoints timed out on vendor-bound provider trips the vendor-type breaker", async () => {
    const provider = createProvider({ providerVendorId: 9 });
    const timeout = buildProviderResponseTimeoutError(provider, "non_streaming_total", 5000);
    const ctx = buildContext({ error: timeout, provider, attemptCount: 2 });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toEqual({ action: "switch_provider" });
    expect(mocks.recordVendorTypeAllEndpointsTimeout).toHaveBeenCalledWith(9, "claude");
    expect(ctx.session.getProviderChain().at(-1)).toMatchObject({
      reason: "vendor_type_all_timeout",
    });
  });

  test("system error advances endpoint and does not count circuit by default", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.SYSTEM_ERROR);
    const error = createTransportError("ECONNREFUSED", "connect ECONNREFUSED");

    const retry = await ProxyForwarder.handleSerialAttemptFailure(buildContext({ error }));
    expect(retry).toMatchObject({ action: "retry", advanceEndpoint: true, delayMs: 100 });
    expect(mocks.recordEndpointFailure).toHaveBeenCalled();

    const ctx = buildContext({ error, attemptCount: 2 });
    const switched = await ProxyForwarder.handleSerialAttemptFailure(ctx);
    expect(switched).toEqual({ action: "switch_provider" });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(ctx.failedProviderIds).toEqual([7]);
  });

  test("404 retries then switches without circuit accounting", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.RESOURCE_NOT_FOUND);
    const error = upstreamError(404);

    const retry = await ProxyForwarder.handleSerialAttemptFailure(buildContext({ error }));
    expect(retry).toMatchObject({ action: "retry", advanceEndpoint: false });

    const switched = await ProxyForwarder.handleSerialAttemptFailure(
      buildContext({ error, attemptCount: 2 })
    );
    expect(switched).toEqual({ action: "switch_provider" });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
  });

  test("empty response retries then records failure and switches", async () => {
    const error = new EmptyResponseError(7, "p7", "empty_body");

    const retry = await ProxyForwarder.handleSerialAttemptFailure(buildContext({ error }));
    expect(retry).toMatchObject({ action: "retry", delayMs: 100 });

    const switched = await ProxyForwarder.handleSerialAttemptFailure(
      buildContext({ error, attemptCount: 2 })
    );
    expect(switched).toEqual({ action: "switch_provider" });
    expect(mocks.recordFailure).toHaveBeenCalledWith(7, error);
  });

  test("non-retryable client error throws without circuit accounting", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.NON_RETRYABLE_CLIENT_ERROR);
    const error = upstreamError(400);
    const ctx = buildContext({ error });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toEqual({ action: "throw", error });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(ctx.session.getProviderChain().at(-1)).toMatchObject({
      reason: "client_error_non_retryable",
    });
  });

  test("raw passthrough policy throws instead of retrying", async () => {
    const error = upstreamError(500);
    const session = createSession("/v1/messages/count_tokens");
    const decision = await ProxyForwarder.handleSerialAttemptFailure(
      buildContext({
        error,
        session,
        endpointPolicy: session.getEndpointPolicy(),
        shouldSkipRawRetryAndProviderSwitch: true,
      })
    );
    expect(decision).toEqual({ action: "throw", error });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
  });

  test("client abort after first-byte threshold without first byte accounts provider health", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.CLIENT_ABORT);
    const error = new ProxyError("aborted", 499, undefined, true);
    const ctx = buildContext({ error, getAttemptElapsedMs: () => 31_000 });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toEqual({ action: "throw", error });
    expect(mocks.recordFailure).toHaveBeenCalledTimes(1);
    expect(ctx.session.getProviderChain().at(-1)).toMatchObject({
      reason: "client_abort_no_first_byte",
    });
  });

  test("client abort before the threshold is not attributed to the provider", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.CLIENT_ABORT);
    const error = new ProxyError("aborted", 499, undefined, true);
    const ctx = buildContext({ error, getAttemptElapsedMs: () => 10 });
    await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(ctx.session.getProviderChain().at(-1)).toMatchObject({ reason: "client_abort" });
  });

  test("applied reactive rectifier retries immediately and extends the attempt budget", async () => {
    const error = upstreamError(400, '{"error":{"message":"invalid signature in thinking block"}}');
    const applyReactiveRectifier = vi.fn(async (_params: ReactiveRectifierParams) => ({
      matched: true as const,
      applied: true as const,
      rectifierType: "thinking_signature_rectifier" as const,
      trigger: "invalid_signature_in_thinking_block",
      requestDetailsBeforeRectify: {} as never,
    }));
    const decision = await ProxyForwarder.handleSerialAttemptFailure(
      buildContext({ error, attemptCount: 1, maxAttemptsPerProvider: 1, applyReactiveRectifier })
    );

    expect(decision).toEqual({
      action: "retry",
      delayMs: 0,
      advanceEndpoint: false,
      maxAttemptsPerProvider: 2,
      rectifierType: "thinking_signature_rectifier",
    });
    expect(applyReactiveRectifier.mock.calls[0][0]).toMatchObject({
      attemptNumber: 1,
      retryAttemptNumber: 2,
    });
  });

  test("matched but not applicable rectifier becomes a non-retryable client error", async () => {
    const error = upstreamError(400);
    const decision = await ProxyForwarder.handleSerialAttemptFailure(
      buildContext({
        error,
        applyReactiveRectifier: async () => ({
          matched: true,
          applied: false,
          reason: "not_applicable",
          rectifierType: "thinking_budget_rectifier",
          trigger: "budget_tokens_too_low",
        }),
      })
    );
    expect(decision).toEqual({ action: "throw", error });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
  });

  test("non-database local overload is rethrown untouched", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.LOCAL_OVERLOAD);
    const error = new Error("local capacity");
    const ctx = buildContext({ error });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);
    expect(decision).toEqual({ action: "throw", error });
    expect(ctx.session.getProviderChain()).toHaveLength(0);
  });
});

describe("ProxyForwarder.resolveSerialEndpointCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("falls back to provider.url when the provider has no vendor", async () => {
    const session = createSession();
    const result = await ProxyForwarder.resolveSerialEndpointCandidates({
      session,
      provider: createProvider(),
      maxAttemptsPerProvider: 2,
      shouldSkipRawRetryAndProviderSwitch: false,
      failedProviderIds: [],
    });
    expect(result.endpointCandidates).toEqual([
      { endpointId: null, baseUrl: "https://provider.example.com" },
    ]);
    expect(result.blocked).toBe(false);
    expect(result.isMcpRequest).toBe(false);
    expect(result.shouldAccountCircuitBreaker).toBe(true);
  });

  test("truncates vendor endpoints to the attempt budget", async () => {
    mocks.getPreferredProviderEndpoints.mockResolvedValue([
      { id: 1, url: "https://a" },
      { id: 2, url: "https://b" },
      { id: 3, url: "https://c" },
    ]);
    const result = await ProxyForwarder.resolveSerialEndpointCandidates({
      session: createSession(),
      provider: createProvider({ providerVendorId: 5 }),
      maxAttemptsPerProvider: 2,
      shouldSkipRawRetryAndProviderSwitch: false,
      failedProviderIds: [],
    });
    expect(result.endpointCandidates.map((e) => e.endpointId)).toEqual([1, 2]);
  });

  test("strict pool with no candidates marks the provider failed", async () => {
    mocks.getPreferredProviderEndpoints.mockResolvedValue([]);
    const session = createSession();
    const failedProviderIds: number[] = [];
    const result = await ProxyForwarder.resolveSerialEndpointCandidates({
      session,
      provider: createProvider({ providerVendorId: 5 }),
      maxAttemptsPerProvider: 2,
      shouldSkipRawRetryAndProviderSwitch: false,
      failedProviderIds,
    });
    expect(result.blocked).toBe(true);
    expect(failedProviderIds).toEqual([7]);
    expect(session.getProviderChain().at(-1)).toMatchObject({
      reason: "endpoint_pool_exhausted",
      strictBlockCause: "no_endpoint_candidates",
    });
  });
});

describe("edge error reconstruction helpers", () => {
  test("fromUpstreamSnapshot matches fromUpstreamResponse", async () => {
    const body =
      '{"error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}';
    const headers = { "content-type": "application/json", "request-id": "req_hdr" };
    const fromResponse = await ProxyError.fromUpstreamResponse(
      new Response(body, { status: 529, statusText: "Overloaded", headers }),
      { id: 7, name: "p7" }
    );
    const fromSnapshot = ProxyError.fromUpstreamSnapshot(
      { status: 529, statusText: "Overloaded", headers: new Headers(headers), bodyText: body },
      { id: 7, name: "p7" }
    );
    expect(fromSnapshot.message).toBe(fromResponse.message);
    expect(fromSnapshot.statusCode).toBe(529);
    expect(fromSnapshot.upstreamError).toEqual(fromResponse.upstreamError);
  });

  test("createTransportError is classified as a transport error", () => {
    expect(isTransportError(createTransportError("ECONNRESET", "socket hang up"))).toBe(true);
    expect(isTransportError(createTransportError("UND_ERR_SOCKET", ""))).toBe(true);
    expect(createTransportError("EPROTO", "tls").message).toBe("tls");
  });

  test("timeout builders produce 524 errors with typed bodies", () => {
    const provider = createProvider({ streamingIdleTimeoutMs: 60_000 });
    const firstByte = buildProviderResponseTimeoutError(provider, "streaming_first_byte", 2000);
    expect(firstByte.statusCode).toBe(524);
    expect(firstByte.message).toContain("首字节");
    expect(firstByte.upstreamError?.parsed).toMatchObject({
      error: { timeout_type: "streaming_first_byte", timeout_ms: 2000 },
    });
    expect(
      buildProviderResponseTimeoutError(provider, "non_streaming_total", 5).message
    ).not.toContain("首字节");
    expect(buildFirstValidContentTimeoutError(provider).upstreamError?.body).toContain(
      "streaming_first_valid_content"
    );
    expect(buildStreamingIdleTimeoutError(provider).upstreamError?.parsed).toMatchObject({
      error: { type: "streaming_idle_timeout", timeout_ms: 60_000 },
    });
  });
});
