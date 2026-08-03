import type { Context } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

type ReasoningEffortOverrideContext = {
  readonly originalModel: string | null;
  readonly executionModel: string | null;
  readonly originalReasoningEffort: string | null;
  readonly reasoningEffortOverrideRules: readonly unknown[] | null;
};

type OverrideProvider = {
  readonly id?: number;
  readonly name?: string;
  readonly providerType?: string;
};

type ProviderWithReasoningEffortOverrideRules = Provider & {
  readonly reasoningEffortOverrideRules: readonly ReasoningEffortOverrideRule[] | null;
};

type ForwarderInternals = {
  doForward: (
    session: ProxySession,
    provider: Provider,
    baseUrl: string,
    endpointAudit?: { endpointId: number | null; endpointUrl: string },
    attemptNumber?: number,
    deferDetailSnapshotPersistence?: boolean
  ) => Promise<Response>;
  fetchWithoutAutoDecode: (...args: unknown[]) => Promise<Response>;
  selectAlternative: (...args: unknown[]) => Promise<Provider | null>;
};

const mocks = vi.hoisted(() => ({
  applyCodexProviderOverridesWithAudit: vi.fn(),
  applyAnthropicProviderOverridesWithAudit: vi.fn(),
  getCachedSystemSettings: vi.fn(),
  isHttp2Enabled: vi.fn(),
  getCircuitState: vi.fn(),
  getProviderHealthInfo: vi.fn(),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  storeSessionSpecialSettings: vi.fn(),
  storeSessionRequestHeaders: vi.fn(),
  storeSessionRequestPhaseSnapshot: vi.fn(),
  storeSessionUpstreamRequestMeta: vi.fn(),
  updateSessionBindingSmart: vi.fn(),
  updateSessionProvider: vi.fn(),
  updateMessageRequestDetails: vi.fn(),
}));

vi.mock("@/lib/codex/provider-overrides", () => ({
  applyCodexProviderOverridesWithAudit: mocks.applyCodexProviderOverridesWithAudit,
}));

vi.mock("@/lib/anthropic/provider-overrides", () => ({
  applyAnthropicProviderOverridesWithAudit: mocks.applyAnthropicProviderOverridesWithAudit,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getCachedSystemSettings: mocks.getCachedSystemSettings,
    isHttp2Enabled: mocks.isHttp2Enabled,
  };
});

vi.mock("@/lib/circuit-breaker", () => ({
  getCircuitState: mocks.getCircuitState,
  getProviderHealthInfo: mocks.getProviderHealthInfo,
  recordSuccess: mocks.recordSuccess,
  recordFailure: mocks.recordFailure,
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    storeSessionSpecialSettings: mocks.storeSessionSpecialSettings,
    storeSessionRequestHeaders: mocks.storeSessionRequestHeaders,
    storeSessionRequestPhaseSnapshot: mocks.storeSessionRequestPhaseSnapshot,
    storeSessionUpstreamRequestMeta: mocks.storeSessionUpstreamRequestMeta,
    updateSessionBindingSmart: mocks.updateSessionBindingSmart,
    updateSessionProvider: mocks.updateSessionProvider,
    clearSessionProvider: vi.fn(),
    clearSessionProviders: vi.fn(),
  },
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateMessageRequestDetails,
}));

vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => ({
    releaseAgent: vi.fn(),
    markUnhealthy: vi.fn(),
  })),
}));

vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    applyFinal: vi.fn(async () => {}),
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    categorizeErrorAsync: vi.fn(async () => actual.ErrorCategory.PROVIDER_ERROR),
    getErrorDetectionResultAsync: vi.fn(async () => ({ matched: false })),
  };
});

import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ErrorCategory, categorizeErrorAsync } from "@/app/v1/_lib/proxy/errors";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider, ReasoningEffortOverrideRule } from "@/types/provider";

function makeContext(url: string, body: Record<string, unknown>): Context {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    req: {
      method: "POST",
      url,
      raw: request,
      header: (name?: string) => {
        if (name === undefined) {
          return Object.fromEntries(request.headers.entries());
        }
        return request.headers.get(name) ?? undefined;
      },
    },
  } as unknown as Context;
}

function createSession(
  pathname: "/v1/messages" | "/v1/responses" | "/v1/chat/completions",
  message: Record<string, unknown>
): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);
  const originalModel = typeof message.model === "string" ? message.model : null;
  const responseReasoning = message.reasoning;
  const messageOutputConfig = message.output_config;

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(`https://hub.test${pathname}`),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: "{}",
    request: {
      model: originalModel,
      log: "",
      message,
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: { id: 123, createdAt: new Date(), user: { id: 1 }, key: {}, apiKey: "k" },
    sessionId: "session-1",
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    endpointPolicy: resolveEndpointPolicy(pathname),
    rawIntakeModel: originalModel,
    rawResponsesReasoningEffort:
      responseReasoning &&
      typeof responseReasoning === "object" &&
      !Array.isArray(responseReasoning)
        ? typeof (responseReasoning as Record<string, unknown>).effort === "string"
          ? (responseReasoning as Record<string, unknown>).effort
          : null
        : null,
    rawMessagesReasoningEffort:
      messageOutputConfig &&
      typeof messageOutputConfig === "object" &&
      !Array.isArray(messageOutputConfig)
        ? typeof (messageOutputConfig as Record<string, unknown>).effort === "string"
          ? (messageOutputConfig as Record<string, unknown>).effort
          : null
        : null,
    originalModelName: null,
    originalUrlPathname: null,
    currentModelRedirect: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    groupCostMultiplier: 1,
    specialSettings: [],
    highConcurrencyModeEnabled: false,
    rawCrossProviderFallbackEnabled: false,
    providersSnapshot: [],
    providerSessionRefs: new Map<number, Array<{ retainOnSuccess: boolean }>>(),
  });

  return session as ProxySession;
}

function createProvider(
  overrides: Partial<ProviderWithReasoningEffortOverrideRules> = {}
): ProviderWithReasoningEffortOverrideRules {
  return {
    id: 1,
    name: "provider-1",
    url: "https://provider.example.com/v1/messages",
    key: "provider-key",
    providerVendorId: null,
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
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 0,
    streamingIdleTimeoutMs: 0,
    requestTimeoutNonStreamingMs: 0,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    codexServiceTierPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    reasoningEffortOverrideRules: null,
    geminiGoogleSearchPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as ProviderWithReasoningEffortOverrideRules;
}

function okResponse(): Response {
  const body = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  });
}

function okStreamingResponse(): Response {
  const body =
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n';
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "content-length": String(body.length) },
  });
}

function errorResponse(status: number, message: string): Response {
  const body = JSON.stringify({ error: { message } });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerOverrideAudit(
  provider: OverrideProvider,
  context: ReasoningEffortOverrideContext
) {
  return {
    type: "provider_parameter_override" as const,
    scope: "provider" as const,
    providerId: provider.id ?? null,
    providerName: provider.name ?? null,
    providerType: provider.providerType ?? null,
    hit: true,
    changed: true,
    changes: [],
    ruleEvaluation: {
      shouldOverride: true,
      overriddenEffort: "high",
      matchedIndex: 0,
      matchedRule: null,
      input: {
        originalModel: context.originalModel,
        executionModel: context.executionModel,
        originalReasoningEffort: context.originalReasoningEffort,
      },
    },
  };
}

describe("ProxySession reasoning effort rule snapshots", () => {
  test("captures immutable Responses-format raw inputs before later mutation", async () => {
    const session = await ProxySession.fromContext(
      makeContext("https://hub.test/v1/responses", {
        model: "gpt-5-raw",
        reasoning: { effort: "medium", summary: "detailed" },
      })
    );

    session.request.model = "gpt-5-redirected";
    session.request.message.reasoning = { effort: "high" };

    expect(session.getRawIntakeModel()).toBe("gpt-5-raw");
    expect(session.getRawResponsesReasoningEffort()).toBe("medium");
    expect(session.getRawMessagesReasoningEffort()).toBeNull();
  });

  test("captures immutable Messages-format raw effort before later mutation", async () => {
    const session = await ProxySession.fromContext(
      makeContext("https://hub.test/v1/messages", {
        model: "claude-raw",
        output_config: { effort: "medium", keep: true },
      })
    );

    session.request.model = "claude-redirected";
    session.request.message.output_config = { effort: "high" };

    expect(session.getRawIntakeModel()).toBe("claude-raw");
    expect(session.getRawResponsesReasoningEffort()).toBeNull();
    expect(session.getRawMessagesReasoningEffort()).toBe("medium");
  });

  test("normalizes malformed format-specific effort inputs to null", async () => {
    const session = await ProxySession.fromContext(
      makeContext("https://hub.test/v1/messages", {
        model: "claude-raw",
        reasoning: "medium",
        output_config: { effort: 3 },
      })
    );

    expect(session.getRawIntakeModel()).toBe("claude-raw");
    expect(session.getRawResponsesReasoningEffort()).toBeNull();
    expect(session.getRawMessagesReasoningEffort()).toBeNull();
  });
});

describe("ProxyForwarder reasoning effort rule forwarding", () => {
  const forwarder = ProxyForwarder as unknown as ForwarderInternals;
  const codexContexts: ReasoningEffortOverrideContext[] = [];
  const anthropicContexts: ReasoningEffortOverrideContext[] = [];
  const sentBodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    codexContexts.length = 0;
    anthropicContexts.length = 0;
    sentBodies.length = 0;
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableBillingHeaderRectifier: false,
      enableClaudeMetadataUserIdInjection: false,
      enableThinkingEffortConflictRectifier: true,
      enableHighConcurrencyMode: false,
    });
    mocks.isHttp2Enabled.mockResolvedValue(false);
    mocks.getCircuitState.mockReturnValue("closed");
    mocks.getProviderHealthInfo.mockResolvedValue({
      health: { failureCount: 0 },
      config: { failureThreshold: 3 },
    });
    mocks.updateSessionBindingSmart.mockResolvedValue({
      updated: true,
      reason: "first_success",
      details: "test",
    });
    mocks.updateSessionProvider.mockResolvedValue(undefined);
    mocks.storeSessionSpecialSettings.mockResolvedValue(undefined);
    mocks.storeSessionRequestHeaders.mockResolvedValue(undefined);
    mocks.storeSessionRequestPhaseSnapshot.mockResolvedValue(undefined);
    mocks.storeSessionUpstreamRequestMeta.mockResolvedValue(undefined);
    mocks.updateMessageRequestDetails.mockResolvedValue(undefined);
    mocks.applyCodexProviderOverridesWithAudit.mockImplementation(
      (
        provider: OverrideProvider,
        request: Record<string, unknown>,
        context: ReasoningEffortOverrideContext
      ) => {
        codexContexts.push(context);
        return {
          request: {
            ...request,
            reasoning: {
              ...(isRecord(request.reasoning) ? request.reasoning : {}),
              effort: "high",
            },
          },
          audit: providerOverrideAudit(provider, context),
        };
      }
    );
    mocks.applyAnthropicProviderOverridesWithAudit.mockImplementation(
      (
        provider: OverrideProvider,
        request: Record<string, unknown>,
        context: ReasoningEffortOverrideContext
      ) => {
        anthropicContexts.push(context);
        return {
          request: {
            ...request,
            output_config: {
              ...(isRecord(request.output_config) ? request.output_config : {}),
              effort: "high",
            },
            ...(Object.hasOwn(request, "thinking")
              ? { thinking: request.thinking }
              : { thinking: { type: "adaptive" } }),
          },
          audit: providerOverrideAudit(provider, context),
        };
      }
    );
    vi.mocked(categorizeErrorAsync).mockResolvedValue(ErrorCategory.PROVIDER_ERROR);
  });

  test("forwards immutable Responses snapshots only through the Codex branch", async () => {
    const session = createSession("/v1/responses", {
      model: "gpt-5-raw",
      reasoning: { effort: "medium", summary: "brief" },
    });
    const provider = createProvider({
      providerType: "codex",
      url: "https://provider.example.com/v1/responses",
      modelRedirects: [{ matchType: "exact", source: "gpt-5-raw", target: "gpt-5-execution" }],
      reasoningEffortOverrideRules: [{ when: {}, overrideEffort: "high" }],
    });
    vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementation(async () => {
      sentBodies.push(JSON.parse(session.forwardedRequestBody ?? "{}"));
      return okResponse();
    });

    await forwarder.doForward(session, provider, provider.url);

    expect(codexContexts).toEqual([
      {
        originalModel: "gpt-5-raw",
        executionModel: "gpt-5-execution",
        originalReasoningEffort: "medium",
        reasoningEffortOverrideRules: provider.reasoningEffortOverrideRules,
      },
    ]);
    expect(anthropicContexts).toEqual([]);
    expect(sentBodies[0]?.reasoning).toEqual({ effort: "high", summary: "brief" });
    expect(mocks.updateMessageRequestDetails).toHaveBeenCalledWith(123, {
      specialSettings: expect.arrayContaining([
        expect.objectContaining({
          type: "provider_parameter_override",
          ruleEvaluation: expect.objectContaining({ shouldOverride: true }),
        }),
      ]),
    });
  });

  test.each(["claude", "claude-auth"] as const)(
    "forwards immutable Messages snapshots only through the %s branch",
    async (providerType) => {
      const session = createSession("/v1/messages", {
        model: "claude-raw",
        output_config: { effort: "medium", keep: true },
        messages: [{ role: "user", content: "hello" }],
      });
      const provider = createProvider({
        providerType,
        modelRedirects: [{ matchType: "exact", source: "claude-raw", target: "claude-execution" }],
        reasoningEffortOverrideRules: [{ when: {}, overrideEffort: "high" }],
      });
      vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementation(async () => {
        sentBodies.push(JSON.parse(session.forwardedRequestBody ?? "{}"));
        return okResponse();
      });

      await forwarder.doForward(session, provider, provider.url);

      expect(anthropicContexts).toEqual([
        {
          originalModel: "claude-raw",
          executionModel: "claude-execution",
          originalReasoningEffort: "medium",
          reasoningEffortOverrideRules: provider.reasoningEffortOverrideRules,
        },
      ]);
      expect(codexContexts).toEqual([]);
      expect(sentBodies[0]?.output_config).toEqual({ effort: "high", keep: true });
    }
  );

  test("never invokes conditional adapters for the Chat Completions provider branch", async () => {
    const session = createSession("/v1/chat/completions", {
      model: "gpt-5-raw",
      reasoning: { effort: "medium" },
      messages: [{ role: "user", content: "hello" }],
    });
    const provider = createProvider({
      providerType: "openai-compatible",
      url: "https://provider.example.com/v1/chat/completions",
    });
    vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockResolvedValue(okResponse());

    await forwarder.doForward(session, provider, provider.url);

    expect(codexContexts).toEqual([]);
    expect(anthropicContexts).toEqual([]);
  });

  test("bypasses the same-provider rectifier retry and reevaluates after provider failover", async () => {
    const session = createSession("/v1/messages", {
      model: "claude-raw",
      thinking: { type: "disabled" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hello" }],
    });
    const firstProvider = createProvider({
      id: 1,
      name: "first",
      providerType: "claude",
      modelRedirects: [{ matchType: "exact", source: "claude-raw", target: "claude-first" }],
      reasoningEffortOverrideRules: [{ when: {}, overrideEffort: "high" }],
    });
    const secondProvider = createProvider({
      id: 2,
      name: "second",
      providerType: "claude",
      modelRedirects: [{ matchType: "exact", source: "claude-raw", target: "claude-second" }],
      reasoningEffortOverrideRules: [{ when: {}, overrideEffort: "max" }],
    });
    session.setProvider(firstProvider);
    const responses = [
      errorResponse(400, "thinking options type cannot be disabled when reasoning_effort is set"),
      errorResponse(500, "first provider failed after rectification"),
      okResponse(),
    ];
    vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementation(async () => {
      sentBodies.push(JSON.parse(session.forwardedRequestBody ?? "{}"));
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected extra forward attempt");
      }
      return response;
    });
    vi.spyOn(forwarder, "selectAlternative").mockResolvedValueOnce(secondProvider);

    await expect(ProxyForwarder.send(session)).resolves.toMatchObject({ status: 200 });

    expect(anthropicContexts).toEqual([
      expect.objectContaining({ originalModel: "claude-raw", executionModel: "claude-first" }),
      expect.objectContaining({
        originalModel: "claude-raw",
        executionModel: "claude-second",
        reasoningEffortOverrideRules: secondProvider.reasoningEffortOverrideRules,
      }),
    ]);
    expect(sentBodies).toHaveLength(3);
    expect(sentBodies[1]?.output_config).toBeUndefined();
    expect(sentBodies[1]?.thinking).toEqual({ type: "disabled" });
    expect(sentBodies[2]?.output_config).toEqual({ effort: "high" });
    expect(JSON.stringify(session.getSpecialSettings())).toContain(
      "thinking_effort_conflict_rectifier"
    );
  });

  test("bypasses conditional evaluation on a streaming hedge rectifier retry", async () => {
    const session = createSession("/v1/messages", {
      model: "claude-raw",
      stream: true,
      thinking: { type: "disabled" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hello" }],
    });
    const provider = createProvider({
      providerType: "claude",
      firstByteTimeoutStreamingMs: 100,
      reasoningEffortOverrideRules: [{ when: {}, overrideEffort: "high" }],
    });
    session.setProvider(provider);
    const responses = [
      errorResponse(400, "thinking options type cannot be disabled when reasoning_effort is set"),
      okStreamingResponse(),
    ];
    vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementation(async () => {
      sentBodies.push(JSON.parse(session.forwardedRequestBody ?? "{}"));
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected extra hedge forward attempt");
      }
      return response;
    });

    await expect(ProxyForwarder.send(session)).resolves.toMatchObject({ status: 200 });

    expect(anthropicContexts).toHaveLength(1);
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]?.output_config).toBeUndefined();
    expect(sentBodies[1]?.thinking).toEqual({ type: "disabled" });
  });
});
