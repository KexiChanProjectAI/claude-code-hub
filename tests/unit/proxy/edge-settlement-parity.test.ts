/**
 * edge 完成上报的结算必须与本地响应处理器对同一上游响应的结算一致：
 * 终态写库字段、计费写入与限流计数参数逐项比较。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelPriceData } from "@/types/model-price";

const asyncTasks: Promise<void>[] = [];

vi.mock("@/lib/async-task-manager", () => ({
  AsyncTaskManager: {
    register: (_taskId: string, factory: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController();
      asyncTasks.push(Promise.resolve().then(() => factory(controller.signal)));
      return controller;
    },
    touch: vi.fn(() => true),
    cleanup: () => {},
    cancel: () => {},
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
}));

vi.mock("@/lib/price-sync/cloud-price-updater", () => ({ requestCloudPriceTableSync: () => {} }));
vi.mock("@/repository/model-price", () => ({ findLatestPriceByModel: vi.fn() }));
vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(async () => ({
    billingModelSource: "original",
    enableResponseFixer: false,
    enableHighConcurrencyMode: false,
  })),
}));
vi.mock("@/repository/message", () => ({
  updateMessageRequestCost: vi.fn(),
  updateMessageRequestCostWithBreakdown: vi.fn(),
  updateMessageRequestWinnerCost: vi.fn(),
  updateMessageRequestDetails: vi.fn(),
  updateMessageRequestDetailsDurably: vi.fn(async () => true),
  updateMessageRequestDetailsIfUnfinalized: vi.fn(),
  updateMessageRequestDuration: vi.fn(),
}));
vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    updateSessionUsage: vi.fn(async () => undefined),
    storeSessionResponse: vi.fn(),
    storeSessionResponseBodySet: vi.fn(async () => undefined),
    storeSessionResponsePhaseSnapshot: vi.fn(async () => undefined),
    storeSessionSpecialSettings: vi.fn(async () => undefined),
    extractCodexPromptCacheKey: vi.fn(),
    updateSessionWithCodexCacheKey: vi.fn(),
    updateSessionBindingSmart: vi.fn(async () => ({ updated: false })),
    updateSessionProvider: vi.fn(async () => undefined),
    clearSessionProvider: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: {
    trackCost: vi.fn(),
    settleLeaseBudgets: vi.fn(),
    trackTotalCostCache: vi.fn(),
    releaseProviderSession: vi.fn(),
  },
}));
vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: { refreshObservedSession: vi.fn(), refreshSession: vi.fn() },
}));
vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: { getInstance: () => ({ endRequest: () => {}, startRequest: () => {} }) },
}));
vi.mock("@/lib/circuit-breaker", () => ({
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(async () => {}),
  getCircuitState: vi.fn(() => "closed"),
}));
vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointSuccess: vi.fn(async () => {}),
  recordEndpointFailure: vi.fn(async () => {}),
}));

import {
  ProxyResponseHandler,
  settleEdgeNonStreamCompletion,
  settleEdgeStreamCompletion,
} from "@/app/v1/_lib/proxy/response-handler";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { setDeferredStreamingFinalization } from "@/app/v1/_lib/proxy/stream-finalization";
import { RateLimitService } from "@/lib/rate-limit";
import {
  updateMessageRequestCostWithBreakdown,
  updateMessageRequestDetailsDurably,
} from "@/repository/message";

const PRICE: ModelPriceData = {
  input_cost_per_token: 0.000003,
  output_cost_per_token: 0.000015,
  cache_creation_input_token_cost: 0.00000375,
  cache_read_input_token_cost: 0.0000003,
};

const PROVIDER = {
  id: 9,
  name: "p9",
  providerType: "claude",
  priority: 0,
  costMultiplier: 1.5,
  streamingIdleTimeoutMs: 0,
  firstByteTimeoutStreamingMs: 0,
  dailyResetTime: "00:00",
  dailyResetMode: "fixed",
  swapCacheTtlBilling: false,
};

function makeSession(stream: boolean): ProxySession {
  const session = ProxySession.fromEdgeDigest({
    receivedAtMs: Date.now() - 2000,
    method: "POST",
    requestUrl: new URL("http://edge.local/v1/messages"),
    headers: new Headers({ "user-agent": "claude-cli/2.1.90" }),
    syntheticMessage: { model: "claude-sonnet-4-5", stream, messages: [{}] },
    hints: { messagesHash: null, fingerprint: null, isProbe: false, isWarmup: false },
  });
  const user = { id: 1, name: "u", dailyResetTime: "00:00", dailyResetMode: "fixed" };
  const key = { id: 2, name: "k", dailyResetTime: "00:00", dailyResetMode: "fixed" };
  session.setAuthState({ user, key, apiKey: "sk", success: true } as never);
  session.setMessageContext({
    id: 700,
    createdAt: new Date(1_700_000_000_000),
    user,
    key,
    apiKey: "sk",
  } as never);
  session.setSessionId("sess_p");
  session.setProvider(PROVIDER as never);
  Object.assign(session, {
    getResolvedPricingByBillingSource: async () => ({
      resolvedModelName: "claude-sonnet-4-5",
      resolvedPricingProviderKey: "anthropic",
      source: "cloud_exact" as const,
      priceData: PRICE,
    }),
  });
  session.recordTtft(Date.now() - 1000);
  return session;
}

function deferredMeta() {
  return {
    providerId: 9,
    providerName: "p9",
    providerPriority: 0,
    attemptNumber: 1,
    totalProvidersAttempted: 1,
    isFirstAttempt: true,
    isFailoverSuccess: false,
    endpointId: null,
    endpointUrl: "https://up.example.com",
    upstreamStatusCode: 200,
    healthAttemptId: "legacy-serial-1-1",
    healthAttemptStartedAtMonotonic: performance.now() - 1500,
    healthAttributionThresholdMs: 30_000,
    healthFirstByteSeen: true,
    healthPausedDurationMs: 0,
    healthOutcomeSettled: false,
  };
}

const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "msg_1",
    model: "claude-sonnet-4-5-20250929",
    usage: {
      input_tokens: 120,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 800,
      cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
      output_tokens: 1,
    },
  },
};
const MESSAGE_DELTA = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 57 },
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const FULL_SSE =
  frame("message_start", MESSAGE_START) +
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello world" },
  }) +
  frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
  frame("message_delta", MESSAGE_DELTA) +
  frame("message_stop", { type: "message_stop" });

const COMPACT_SSE =
  frame("message_start", MESSAGE_START) +
  frame("message_delta", MESSAGE_DELTA) +
  frame("message_stop", { type: "message_stop" });

async function drain(): Promise<void> {
  while (asyncTasks.length > 0) {
    await Promise.allSettled(asyncTasks.splice(0, asyncTasks.length));
  }
}

function comparableTerminalDetails(call: unknown[] | undefined) {
  const details = { ...((call?.[1] ?? {}) as Record<string, unknown>) };
  delete details.durationMs;
  delete details.routingTrace;
  delete details.ttftMs;
  delete details.firstByteMs;
  if (Array.isArray(details.providerChain)) {
    details.providerChain = details.providerChain.map((item: Record<string, unknown>) => ({
      ...item,
      timestamp: 0,
    }));
  }
  return details;
}

describe("edge settlement parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asyncTasks.splice(0, asyncTasks.length);
  });

  test("streaming completion matches the local stream finalization", async () => {
    const localSession = makeSession(true);
    setDeferredStreamingFinalization(localSession, deferredMeta());
    const response = await ProxyResponseHandler.dispatch(
      localSession,
      new Response(FULL_SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    await response.text();
    await drain();
    const localDetails = vi.mocked(updateMessageRequestDetailsDurably).mock.calls.at(-1);
    const localCost = vi.mocked(updateMessageRequestCostWithBreakdown).mock.calls.at(-1);
    const localTrack = vi.mocked(RateLimitService.trackCost).mock.calls.at(-1);
    expect(localDetails).toBeDefined();
    vi.clearAllMocks();

    const edgeSession = makeSession(true);
    setDeferredStreamingFinalization(edgeSession, deferredMeta());
    const result = await settleEdgeStreamCompletion(edgeSession, {
      allContent: COMPACT_SSE,
      upstreamStatusCode: 200,
      streamEndedNormally: true,
      clientAborted: false,
      protocolObservation: {
        sawContent: true,
        sawTerminal: true,
        sawIncomplete: false,
        observationIncomplete: false,
        failure: null,
      },
      firstByteSeen: true,
      responseHeaders: new Headers({ "content-type": "text/event-stream" }),
      sseEventCount: 6,
    });
    await drain();
    expect(result).toEqual({ effectiveStatusCode: 200, isSuccessfulCompletion: true });

    const edgeDetails = vi.mocked(updateMessageRequestDetailsDurably).mock.calls.at(-1);
    expect(comparableTerminalDetails(edgeDetails)).toEqual(comparableTerminalDetails(localDetails));
    expect(comparableTerminalDetails(edgeDetails)).toMatchObject({
      statusCode: 200,
      inputTokens: 120,
      outputTokens: 57,
      cacheReadInputTokens: 800,
      actualResponseModel: "claude-sonnet-4-5-20250929",
      providerId: 9,
    });
    expect(vi.mocked(updateMessageRequestCostWithBreakdown).mock.calls.at(-1)).toEqual(localCost);
    expect(vi.mocked(RateLimitService.trackCost).mock.calls.at(-1)).toEqual(localTrack);
  });

  test("fake-200 stream error is settled as a failure", async () => {
    const edgeSession = makeSession(true);
    setDeferredStreamingFinalization(edgeSession, deferredMeta());
    const result = await settleEdgeStreamCompletion(edgeSession, {
      allContent: frame("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
      upstreamStatusCode: 200,
      streamEndedNormally: true,
      clientAborted: false,
      protocolObservation: null,
      firstByteSeen: true,
      responseHeaders: new Headers(),
      sseEventCount: 1,
    });
    expect(result.isSuccessfulCompletion).toBe(false);
    expect(result.effectiveStatusCode).toBeGreaterThanOrEqual(400);
    const details = vi.mocked(updateMessageRequestDetailsDurably).mock.calls.at(-1)?.[1] as {
      errorMessage?: string;
    };
    expect(details.errorMessage).toBeTruthy();
  });

  test("client abort after commit is recorded as 499", async () => {
    const edgeSession = makeSession(true);
    setDeferredStreamingFinalization(edgeSession, deferredMeta());
    const result = await settleEdgeStreamCompletion(edgeSession, {
      allContent: frame("message_start", MESSAGE_START),
      upstreamStatusCode: 200,
      streamEndedNormally: false,
      clientAborted: true,
      abortReason: "CLIENT_ABORTED",
      protocolObservation: null,
      firstByteSeen: true,
      responseHeaders: new Headers(),
      sseEventCount: 1,
    });
    expect(result.effectiveStatusCode).toBe(499);
  });

  test("non-stream completion matches the local non-stream path", async () => {
    const body = JSON.stringify({
      id: "msg_2",
      type: "message",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 33, output_tokens: 11, cache_read_input_tokens: 5 },
    });
    const localSession = makeSession(false);
    const response = await ProxyResponseHandler.dispatch(
      localSession,
      new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    );
    await response.text();
    await drain();
    const localDetails = vi.mocked(updateMessageRequestDetailsDurably).mock.calls.at(-1);
    const localTrack = vi.mocked(RateLimitService.trackCost).mock.calls.at(-1);
    expect(localDetails).toBeDefined();
    vi.clearAllMocks();

    const edgeSession = makeSession(false);
    await settleEdgeNonStreamCompletion(edgeSession, {
      responseText: body,
      statusCode: 200,
      responseHeaders: new Headers({ "content-type": "application/json" }),
    });
    await drain();
    const edgeDetails = vi.mocked(updateMessageRequestDetailsDurably).mock.calls.at(-1);
    expect(comparableTerminalDetails(edgeDetails)).toEqual(comparableTerminalDetails(localDetails));
    expect(vi.mocked(RateLimitService.trackCost).mock.calls.at(-1)).toEqual(localTrack);
  });
});
