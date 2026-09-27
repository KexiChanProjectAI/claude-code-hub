import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExecutionStep: vi.fn(async (params: Record<string, unknown>) => ({
    stepId: params.stepId,
    attemptNumber: params.attemptNumber,
    attemptKind: params.attemptKind,
    isStreaming: true,
    provider: { id: (params.provider as { id: number }).id },
    endpoint: params.endpoint,
    applyProviderOverrides: params.applyProviderOverrides,
    hedge: params.hedge,
    bodyOps: [...((params.body as { contentOps: unknown[] }).contentOps ?? [])],
    timeouts: { firstByteMs: 30_000 },
  })),
  recordFailure: vi.fn(async () => {}),
  checkAndTrackProviderSession: vi.fn(async () => ({
    allowed: true,
    referenced: true,
    tracked: true,
  })),
  categorizeErrorAsync: vi.fn(async (error: Error) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 499) return 2; // CLIENT_ABORT
    if (status === 400) return 3; // NON_RETRYABLE_CLIENT_ERROR
    return 0; // PROVIDER_ERROR
  }),
  handle: vi.fn(
    async (_session: unknown, error: Error) =>
      new Response(JSON.stringify({ error: { message: error.message } }), {
        status: (error as { statusCode?: number }).statusCode ?? 500,
      })
  ),
  decrementConcurrentCount: vi.fn(async () => {}),
  decrementObservedConcurrentCount: vi.fn(async () => {}),
  updateSessionBindingSmart: vi.fn(async () => ({
    updated: true,
    reason: "hedge",
    bindingSnapshot: null,
    legacyBindingUpdated: true,
  })),
  updateSessionProvider: vi.fn(async () => {}),
  finalizeHedgeLoserBilling: vi.fn(async () => null),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, getCachedSystemSettings: vi.fn(async () => ({})) };
});
vi.mock("@/lib/circuit-breaker", () => ({
  recordFailure: mocks.recordFailure,
  getCircuitState: vi.fn(() => "closed"),
}));
vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointFailure: vi.fn(async () => {}),
  recordEndpointSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: { checkAndTrackProviderSession: mocks.checkAndTrackProviderSession },
}));
vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    updateSessionBindingSmart: mocks.updateSessionBindingSmart,
    updateSessionProvider: mocks.updateSessionProvider,
    storeSessionSpecialSettings: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    decrementConcurrentCount: mocks.decrementConcurrentCount,
    decrementObservedConcurrentCount: mocks.decrementObservedConcurrentCount,
  },
}));
vi.mock("@/app/v1/_lib/edge/step-builder", () => ({
  buildExecutionStep: mocks.buildExecutionStep,
}));
vi.mock("@/app/v1/_lib/proxy/error-handler", () => ({
  ProxyErrorHandler: { handle: mocks.handle },
}));
vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    categorizeErrorAsync: mocks.categorizeErrorAsync,
    getErrorDetectionResultAsync: vi.fn(async () => ({ matched: false })),
  };
});
vi.mock("@/app/v1/_lib/proxy/response-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/response-handler")>();
  return { ...actual, finalizeHedgeLoserBilling: mocks.finalizeHedgeLoserBilling };
});

import type { EdgeRuntime } from "@/app/v1/_lib/edge/coordinator";
import {
  commitHedgeWinner,
  findHedgeParticipant,
  flushHedgeSessions,
  handleHedgeClientAbort,
  handleHedgeFailure,
  handleHedgeThreshold,
  initHedgeState,
  participantSession,
  startHedge,
} from "@/app/v1/_lib/edge/hedge-coordinator";
import type { EdgeRequestState } from "@/app/v1/_lib/edge/state-store";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { peekDeferredStreamingFinalization } from "@/app/v1/_lib/proxy/stream-finalization";
import type { Provider } from "@/types/provider";

function provider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `p${id}`,
    url: `https://p${id}.example.com`,
    providerType: "claude",
    providerVendorId: 0,
    priority: 0,
    firstByteTimeoutStreamingMs: 5000,
    limitConcurrentSessions: 0,
    ...overrides,
  } as Provider;
}

const PROVIDERS = new Map<number, Provider>([
  [1, provider(1)],
  [2, provider(2)],
  [3, provider(3)],
]);

function makeRuntime(maxInFlight = 2, billLosers = false): EdgeRuntime {
  const session = ProxySession.fromEdgeDigest({
    receivedAtMs: Date.now(),
    method: "POST",
    requestUrl: new URL("http://edge.local/v1/messages"),
    headers: new Headers(),
    syntheticMessage: { model: "m", stream: true, messages: [{}] },
    hints: { messagesHash: null, fingerprint: null, isProbe: false, isWarmup: false },
  });
  session.setRawCrossProviderFallbackEnabled(false);
  session.setSessionId("sess_h");
  session.messageContext = {
    id: 42,
    createdAt: new Date(1_700_000_000_000),
    user: { id: 1, name: "u" },
    key: { id: 2, name: "k" },
    apiKey: "sk",
  } as never;
  session.setProvider(PROVIDERS.get(1) as Provider);
  session.initializeRoutingTrace({
    mode: "legacy_hedge",
    discoveryEnabled: false,
    eligible: false,
    bypassReason: "disabled",
    startedAt: Date.now(),
    config: {} as never,
  });
  const state = {
    requestId: 42,
    createdAtMs: Date.now(),
    heartbeatIntervalMs: 15_000,
    session: session.toEdgeSnapshot(),
    body: { originalTopLevel: {}, hasPrivateParams: false, contentOps: [] },
    attempts: [],
    totalProvidersAttempted: 0,
    failedProviderIds: [],
    providerAttempts: [],
    pendingRectifierAudits: [],
    concurrency: { sessionId: "sess_h", observedIdentity: null },
    phase: "executing",
    mode: "serial",
    hedge: null,
  } as unknown as EdgeRequestState;
  const rt: EdgeRuntime = { state, session, settings: {} as never };
  initHedgeState(state, {
    initialProvider: PROVIDERS.get(1) as Provider,
    maxInFlight,
    billLosers,
  });
  return rt;
}

function chainReasons(rt: EdgeRuntime) {
  return rt.session.getProviderChain().map((item) => `${item.id}:${item.reason}`);
}

function upstreamError(status: number, message = "upstream failed") {
  return new ProxyError(message, status, { body: message, providerId: 1, providerName: "p1" });
}

describe("edge hedge coordinator", () => {
  let alternatives: Provider[];

  beforeEach(() => {
    vi.clearAllMocks();
    alternatives = [PROVIDERS.get(2) as Provider, PROVIDERS.get(3) as Provider];
    vi.spyOn(ProxyForwarder, "selectAlternative").mockImplementation(async (_session, excluded) => {
      return alternatives.find((candidate) => !excluded.includes(candidate.id)) ?? null;
    });
    vi.spyOn(ProxyForwarder, "resolveStreamingHedgeEndpoint").mockImplementation(
      async (_session, target) => ({
        endpointId: null,
        baseUrl: target.url,
        endpointUrl: target.url,
      })
    );
    vi.spyOn(ProxyForwarder, "clearSessionProviderBindings").mockResolvedValue(undefined);
  });

  test("starts the initial provider on the original session with hedge step parameters", async () => {
    const rt = makeRuntime();
    const outcome = await startHedge(rt, PROVIDERS.get(1) as Provider);
    expect(outcome).toMatchObject({
      kind: "step",
      step: {
        stepId: "42:h1:1",
        attemptKind: "normal",
        hedge: { thresholdMs: 5000, maxInFlight: 2, billLosers: false },
        timeouts: { firstByteMs: 0 },
      },
    });
    expect(mocks.checkAndTrackProviderSession).not.toHaveBeenCalled();
    const participant = findHedgeParticipant(rt.state, "42:h1:1");
    expect(participant).toMatchObject({ sequence: 1, useOriginalSession: true, body: null });
    expect(rt.state.attempts).toEqual([
      expect.objectContaining({ stepId: "42:h1:1", status: "inflight", sequence: 1 }),
    ]);
    const events = rt.session.getRoutingTrace()?.events ?? [];
    expect(events.at(-1)).toMatchObject({ type: "attempt_started", activeAttemptCount: 1 });
  });

  test("threshold launches one alternative on a shadow session", async () => {
    const rt = makeRuntime();
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");

    const outcome = await handleHedgeThreshold(rt, first);
    expect(outcome).toMatchObject({
      kind: "launch",
      step: { stepId: "42:h2:1", attemptKind: "hedge" },
    });
    expect(mocks.checkAndTrackProviderSession).toHaveBeenCalledWith(2, "sess_h", 0);
    expect(chainReasons(rt)).toEqual(["1:hedge_triggered", "2:hedge_launched"]);

    const second = findHedgeParticipant(rt.state, "42:h2:1");
    expect(second).toMatchObject({ sequence: 2, useOriginalSession: false });
    expect(second?.body).toEqual(rt.state.body);
    const shadow = second ? participantSession(rt, second) : null;
    expect(shadow?.sessionId).toBeNull();
    expect(shadow?.provider?.id).toBe(2);
    flushHedgeSessions(rt);
    expect(second?.shadow?.provider?.id).toBe(2);

    // 同一参与者的阈值只触发一次
    expect(await handleHedgeThreshold(rt, first)).toEqual({ kind: "none" });
  });

  test("threshold at the in-flight cap records saturation and does not launch", async () => {
    const rt = makeRuntime(1);
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    expect(await handleHedgeThreshold(rt, first)).toEqual({ kind: "none" });
    const events = rt.session.getRoutingTrace()?.events ?? [];
    expect(events.some((event) => event.type === "hedge_slot_saturated")).toBe(true);
    expect(chainReasons(rt)).toEqual(["1:hedge_triggered"]);
    expect(ProxyForwarder.selectAlternative).not.toHaveBeenCalled();
  });

  test("provider failure with a peer in flight launches the next alternative", async () => {
    const rt = makeRuntime(3);
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    await handleHedgeThreshold(rt, first);

    const error = upstreamError(500);
    const outcome = await handleHedgeFailure(rt, first, {
      error,
      errorDescriptor: { kind: "proxy", message: error.message, statusCode: 500 },
    });
    expect(outcome).toMatchObject({ kind: "launch", step: { stepId: "42:h3:1" } });
    expect(mocks.recordFailure).toHaveBeenCalledWith(1, error);
    expect(rt.state.failedProviderIds).toContain(1);
    expect(chainReasons(rt)).toEqual([
      "1:hedge_triggered",
      "2:hedge_launched",
      "1:retry_failed",
      "3:hedge_launched",
    ]);
    expect(first.status).toBe("failed");
  });

  test("failure waits for peers when no alternative remains, then settles 503", async () => {
    alternatives = [PROVIDERS.get(2) as Provider];
    const rt = makeRuntime();
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    await handleHedgeThreshold(rt, first);
    const second = findHedgeParticipant(rt.state, "42:h2:1");
    if (!second) throw new Error("missing participant");

    const error = upstreamError(502);
    expect(
      await handleHedgeFailure(rt, first, {
        error,
        errorDescriptor: { kind: "proxy", message: error.message, statusCode: 502 },
      })
    ).toEqual({ kind: "wait" });

    const outcome = await handleHedgeFailure(rt, second, {
      error: upstreamError(500),
      errorDescriptor: { kind: "proxy", message: "upstream failed", statusCode: 500 },
    });
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") expect(outcome.response.status).toBe(503);
    expect(ProxyForwarder.clearSessionProviderBindings).toHaveBeenCalledWith(
      rt.session,
      new Set([1, 2])
    );
    expect(mocks.decrementConcurrentCount).toHaveBeenCalledWith("sess_h");
    expect(rt.state.phase).toBe("settled");
    expect(rt.session.toEdgeSnapshot().routingTraceSummaryDraft).toMatchObject({
      outcome: "failed",
      statusCode: 503,
      attemptsPerRequest: 2,
    });
  });

  test("non-retryable client errors abort every attempt", async () => {
    const rt = makeRuntime();
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    await handleHedgeThreshold(rt, first);
    const second = findHedgeParticipant(rt.state, "42:h2:1");

    const error = upstreamError(400, "bad request");
    const outcome = await handleHedgeFailure(rt, first, {
      error,
      errorDescriptor: { kind: "proxy", message: error.message, statusCode: 400 },
    });
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") expect(outcome.response.status).toBe(400);
    expect(second?.status).toBe("failed");
    expect(chainReasons(rt)).toContain("1:client_error_non_retryable");
  });

  test("thinking signature errors retry the same participant with a deferred op", async () => {
    const rt = makeRuntime();
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");

    const error = upstreamError(400, "Invalid `signature` in `thinking` block");
    const outcome = await handleHedgeFailure(rt, first, {
      error,
      errorDescriptor: { kind: "proxy", message: error.message, statusCode: 400 },
    });
    expect(outcome).toMatchObject({ kind: "retry", step: { stepId: "42:h1:2" } });
    expect(rt.state.body.contentOps).toEqual([{ op: "apply_thinking_signature_rectifier" }]);
    expect(rt.state.pendingRectifierAudits).toEqual([
      expect.objectContaining({ stepId: "42:h1:2", attemptNumber: 1, retryAttemptNumber: 2 }),
    ]);
    expect(first).toMatchObject({ status: "inflight", requestAttemptCount: 2 });
    expect(rt.state.attempts.find((a) => a.stepId === "42:h1:1")?.status).toBe("failed");

    // 同一供应商已整流过：再次命中即按不可重试终止
    const again = await handleHedgeFailure(rt, first, {
      error,
      errorDescriptor: { kind: "proxy", message: error.message, statusCode: 400 },
    });
    expect(again.kind).toBe("fail");
  });

  test("client abort attributes slow dispatched attempts and ends with 499", async () => {
    const rt = makeRuntime();
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    await handleHedgeThreshold(rt, first);

    const outcome = await handleHedgeClientAbort(
      rt,
      {
        type: "failure",
        failure: { kind: "client_abort" },
        dispatched: true,
        firstByteSeen: false,
        timing: { dispatchedAtMs: 1, firstByteAtMs: null, endedAtMs: 2, healthElapsedMs: 6000 },
        peers: [
          { stepId: "42:h2:1", dispatched: true, firstByteSeen: false, healthElapsedMs: 100 },
        ],
      },
      "42:h1:1"
    );
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") expect(outcome.response.status).toBe(499);
    expect(mocks.recordFailure).toHaveBeenCalledTimes(1);
    expect(mocks.recordFailure.mock.calls[0][0]).toBe(1);
    expect(chainReasons(rt)).toEqual([
      "1:hedge_triggered",
      "2:hedge_launched",
      "2:client_abort",
      "1:client_abort_no_first_byte",
    ]);
  });

  test("winner commit syncs the shadow session, bills losers and forces the binding", async () => {
    const rt = makeRuntime(2, true);
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    await handleHedgeThreshold(rt, first);
    const second = findHedgeParticipant(rt.state, "42:h2:1");
    if (!second) throw new Error("missing participant");

    const { runLoserBilling } = commitHedgeWinner(
      rt,
      second,
      {
        stepId: "42:h2:1",
        upstreamStatus: 200,
        gateCommit: null,
      } as never,
      [
        {
          stepId: "42:h1:1",
          upstreamStatus: 200,
          drainComplete: true,
          meteringText: "event: message_delta\ndata: {}\n\n",
          endedAtMs: Date.now(),
        },
      ]
    );
    expect(rt.session.provider?.id).toBe(2);
    expect(chainReasons(rt)).toEqual([
      "1:hedge_triggered",
      "2:hedge_launched",
      "2:hedge_winner",
      "1:hedge_loser_billed",
    ]);
    const meta = peekDeferredStreamingFinalization(rt.session);
    expect(meta).toMatchObject({
      providerId: 2,
      attemptNumber: 2,
      totalProvidersAttempted: 2,
      isHedgeWinner: true,
      billHedgeLosers: true,
      isFailoverSuccess: true,
    });
    await meta?.hedgeBindingAuthorityPromise;
    expect(mocks.updateSessionBindingSmart).toHaveBeenCalledWith(
      "sess_h",
      2,
      0,
      false,
      true,
      null,
      true
    );

    await runLoserBilling();
    expect(mocks.finalizeHedgeLoserBilling).toHaveBeenCalledWith(
      expect.objectContaining({
        messageRequestId: 42,
        attemptNumber: 1,
        upstreamStatusCode: 200,
        drainComplete: true,
        billingContext: expect.objectContaining({ originalModel: "m" }),
      })
    );
    expect(rt.session.toEdgeSnapshot().routingTraceSummaryDraft).toMatchObject({
      outcome: "success",
      winnerProviderId: 2,
      attemptsPerRequest: 2,
    });
  });

  test("a single-provider win is a plain request_success without forced binding", async () => {
    const rt = makeRuntime();
    await startHedge(rt, PROVIDERS.get(1) as Provider);
    const first = findHedgeParticipant(rt.state, "42:h1:1");
    if (!first) throw new Error("missing participant");
    commitHedgeWinner(rt, first, { stepId: "42:h1:1", upstreamStatus: 200 } as never, []);
    expect(chainReasons(rt)).toEqual(["1:request_success"]);
    expect(peekDeferredStreamingFinalization(rt.session)).toMatchObject({
      isHedgeWinner: false,
      isFirstAttempt: true,
      hedgeBindingAuthorityPromise: undefined,
    });
  });
});
