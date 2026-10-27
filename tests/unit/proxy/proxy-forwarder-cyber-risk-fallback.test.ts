import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";

const mocks = vi.hoisted(() => {
  return {
    pickRandomProviderWithExclusion: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(async () => {}),
    getCircuitState: vi.fn(() => "closed"),
    getProviderHealthInfo: vi.fn(async () => ({
      health: { failureCount: 0 },
      config: { failureThreshold: 3 },
    })),
    updateMessageRequestDetails: vi.fn(async () => {}),
    isHttp2Enabled: vi.fn(async () => false),
    getPreferredProviderEndpoints: vi.fn(async () => []),
    getEndpointFilterStats: vi.fn(async () => null),
    recordEndpointSuccess: vi.fn(async () => {}),
    recordEndpointFailure: vi.fn(async () => {}),
    isVendorTypeCircuitOpen: vi.fn(async () => false),
    recordVendorTypeAllEndpointsTimeout: vi.fn(async () => {}),
    // ErrorCategory.PROVIDER_ERROR
    categorizeErrorAsync: vi.fn(async () => 0),
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
  return {
    ...actual,
    isHttp2Enabled: mocks.isHttp2Enabled,
  };
});

vi.mock("@/lib/provider-endpoints/endpoint-selector", () => ({
  getPreferredProviderEndpoints: mocks.getPreferredProviderEndpoints,
  getEndpointFilterStats: mocks.getEndpointFilterStats,
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointSuccess: mocks.recordEndpointSuccess,
  recordEndpointFailure: mocks.recordEndpointFailure,
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

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateMessageRequestDetails,
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: {
    pickRandomProviderWithExclusion: mocks.pickRandomProviderWithExclusion,
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    categorizeErrorAsync: mocks.categorizeErrorAsync,
  };
});

import { ErrorCategory } from "@/app/v1/_lib/proxy/errors";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ModelRedirector } from "@/app/v1/_lib/proxy/model-redirector";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "p1",
    url: "https://provider.example.com",
    key: "k",
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
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
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 10_000,
    requestTimeoutNonStreamingMs: 1_000,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createSession(): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://example.com/v1/messages"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "claude-test",
      log: "(test)",
      message: {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      },
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
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
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    endpointPolicy: resolveEndpointPolicy("/v1/messages"),
    isHeaderModified: () => false,
  });

  return session as ProxySession;
}

const CYBER_MESSAGE =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
    },
  });
}

describe("ProxyForwarder.send - cyber risk fallback (fake 200)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.NON_RETRYABLE_CLIENT_ERROR);
  });

  test("retries the same provider with the fallback model and succeeds", async () => {
    const provider = createProvider({
      id: 1,
      name: "daily-luna",
      key: "k1",
      maxRetryAttempts: 1,
      cyberRiskFallbackRules: [
        { matchType: "exact", source: "claude-test", target: "claude-fallback" },
      ],
    });
    const session = createSession();
    session.setProvider(provider);

    const modelsSent: string[] = [];
    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");
    const responses = [
      jsonResponse(JSON.stringify({ error: { code: "cyber_policy", message: CYBER_MESSAGE } })),
      jsonResponse(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] })),
    ];
    doForward.mockImplementation(async (...args: unknown[]) => {
      const [attemptSession, attemptProvider] = args as [ProxySession, Provider];
      // mirror the real doForward: model redirect runs at the start of every attempt
      ModelRedirector.apply(attemptSession, attemptProvider);
      modelsSent.push(attemptSession.request.model as string);
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra attempt");
      return next;
    });

    const response = await ProxyForwarder.send(session);

    expect(await response.text()).toContain("ok");
    expect(doForward).toHaveBeenCalledTimes(2);
    expect(doForward.mock.calls.map((call) => (call[1] as Provider).id)).toEqual([1, 1]);
    expect(modelsSent).toEqual(["claude-test", "claude-fallback"]);
    expect(session.getOriginalModel()).toBe("claude-test");
    expect(mocks.pickRandomProviderWithExclusion).not.toHaveBeenCalled();
    expect(mocks.recordFailure).not.toHaveBeenCalled();
    expect(session.getSpecialSettings()).toContainEqual(
      expect.objectContaining({
        type: "cyber_risk_fallback",
        fromModel: "claude-test",
        toModel: "claude-fallback",
      })
    );
    expect(session.getProviderChain().some((item) => item.reason === "retry_failed")).toBe(true);
  });

  test("without rules the cyber refusal is returned after a single attempt", async () => {
    const provider = createProvider({ id: 1, name: "daily-luna", key: "k1", maxRetryAttempts: 3 });
    const session = createSession();
    session.setProvider(provider);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");
    doForward.mockResolvedValueOnce(
      jsonResponse(JSON.stringify({ error: { code: "cyber_policy", message: CYBER_MESSAGE } }))
    );

    await expect(ProxyForwarder.send(session)).rejects.toMatchObject({
      message: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
    });
    expect(doForward).toHaveBeenCalledTimes(1);
    expect(mocks.pickRandomProviderWithExclusion).not.toHaveBeenCalled();
  });

  test("a second cyber refusal on the fallback model is returned without further retries", async () => {
    const provider = createProvider({
      id: 1,
      name: "daily-luna",
      key: "k1",
      maxRetryAttempts: 1,
      cyberRiskFallbackRules: [
        { matchType: "prefix", source: "claude", target: "claude-fallback" },
      ],
    });
    const session = createSession();
    session.setProvider(provider);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");
    doForward.mockImplementation(async (...args: unknown[]) => {
      const [attemptSession, attemptProvider] = args as [ProxySession, Provider];
      ModelRedirector.apply(attemptSession, attemptProvider);
      return jsonResponse(
        JSON.stringify({ error: { code: "cyber_policy", message: CYBER_MESSAGE } })
      );
    });

    await expect(ProxyForwarder.send(session)).rejects.toBeInstanceOf(Error);
    expect(doForward).toHaveBeenCalledTimes(2);
  });
});
