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
      cyberRiskFallbackRetried: false,
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
const CYBER_MESSAGE =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";

function cyberFake200Error(): ProxyError {
  return new ProxyError("FAKE_200_OPENAI_RESPONSE_FAILED", 400, {
    body: CYBER_MESSAGE,
    providerId: 7,
    providerName: "p7",
    rawBody: JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { code: "cyber_policy", message: CYBER_MESSAGE } },
    }),
    isSyntheticFake200: true,
    statusCodeInferred: true,
  });
}

function realContext(overrides: Partial<SerialAttemptFailureContext> & { error: Error }) {
  // applyReactiveRectifier: undefined -> use the forwarder's real reactive rectifier pipeline
  return buildContext({ applyReactiveRectifier: undefined, ...overrides });
}

describe("cyber risk fallback in handleSerialAttemptFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.NON_RETRYABLE_CLIENT_ERROR);
  });

  test("matching rule switches the model and retries the same provider once", async () => {
    const provider = createProvider({
      cyberRiskFallbackRules: [
        { matchType: "exact", source: "claude-sonnet-4", target: "claude-haiku-4" },
      ],
    });
    const ctx = realContext({ error: cyberFake200Error(), provider, maxAttemptsPerProvider: 1 });

    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toMatchObject({
      action: "retry",
      delayMs: 0,
      advanceEndpoint: false,
      maxAttemptsPerProvider: 2,
      rectifierType: "cyber_risk_fallback",
      rectifierTrigger: "flagged for possible cybersecurity risk",
    });
    expect(ctx.reactiveRectifierRetryState.cyberRiskFallbackRetried).toBe(true);
    expect(ctx.session.request.model).toBe("claude-haiku-4");
    expect(ctx.session.request.message.model).toBe("claude-haiku-4");
    expect(ctx.session.getOriginalModel()).toBe("claude-sonnet-4");
    expect(ctx.session.getCyberRiskFallbackModel(7)).toEqual({
      providerId: 7,
      fromModel: "claude-sonnet-4",
      model: "claude-haiku-4",
    });
    expect(ctx.session.getSpecialSettings()).toContainEqual(
      expect.objectContaining({
        type: "cyber_risk_fallback",
        hit: true,
        providerId: 7,
        fromModel: "claude-sonnet-4",
        toModel: "claude-haiku-4",
        attemptNumber: 1,
        retryAttemptNumber: 2,
      })
    );
    expect(ctx.session.getProviderChain().at(-1)).toMatchObject({ reason: "retry_failed" });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(ctx.failedProviderIds).toEqual([]);
  });

  test("works for non-Anthropic provider types", async () => {
    const provider = createProvider({
      providerType: "codex",
      cyberRiskFallbackRules: [{ matchType: "prefix", source: "claude", target: "gpt-5.4" }],
    });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(
      realContext({ error: cyberFake200Error(), provider })
    );
    expect(decision).toMatchObject({ action: "retry", rectifierType: "cyber_risk_fallback" });
  });

  test("second cyber refusal after fallback stops as a non-retryable client error", async () => {
    const provider = createProvider({
      cyberRiskFallbackRules: [
        { matchType: "exact", source: "claude-sonnet-4", target: "claude-haiku-4" },
      ],
    });
    const ctx = realContext({ error: cyberFake200Error(), provider });
    ctx.reactiveRectifierRetryState.cyberRiskFallbackRetried = true;

    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toMatchObject({ action: "throw" });
    expect(ctx.session.request.model).toBe("claude-sonnet-4");
  });

  test("without rules the cyber refusal keeps the existing immediate stop", async () => {
    const ctx = realContext({ error: cyberFake200Error() });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(ctx);

    expect(decision).toMatchObject({ action: "throw" });
    expect(ctx.reactiveRectifierRetryState.cyberRiskFallbackRetried).toBe(false);
    expect(ctx.session.getSpecialSettings() ?? []).toEqual([]);
  });

  test("rules that do not match the model keep the existing immediate stop", async () => {
    const provider = createProvider({
      cyberRiskFallbackRules: [{ matchType: "exact", source: "gpt-5.5", target: "gpt-5.4" }],
    });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(
      realContext({ error: cyberFake200Error(), provider })
    );
    expect(decision).toMatchObject({ action: "throw" });
  });

  test("non-cyber errors are not affected by fallback rules", async () => {
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);
    const provider = createProvider({
      cyberRiskFallbackRules: [
        { matchType: "exact", source: "claude-sonnet-4", target: "claude-haiku-4" },
      ],
    });
    const decision = await ProxyForwarder.handleSerialAttemptFailure(
      realContext({ error: upstreamError(500), provider })
    );
    expect(decision).toMatchObject({ action: "retry", delayMs: 100 });
    expect(decision).not.toHaveProperty("rectifierType");
  });
});

describe("cyber risk fallback across hedge shadow sessions", () => {
  test("syncWinningAttemptSession copies the winner's fallback override", () => {
    const internals = ProxyForwarder as unknown as {
      syncWinningAttemptSession: (target: ProxySession, source: ProxySession) => void;
    };
    const target = createSession();
    const source = createSession();
    source.setCyberRiskFallbackModel(7, "claude-sonnet-4", "claude-haiku-4");

    internals.syncWinningAttemptSession(target, source);

    expect(target.getCyberRiskFallbackModel(7)).toEqual({
      providerId: 7,
      fromModel: "claude-sonnet-4",
      model: "claude-haiku-4",
    });

    const cleared = createSession();
    internals.syncWinningAttemptSession(target, cleared);
    expect(target.getCyberRiskFallbackModel(7)).toBeNull();
  });
});
