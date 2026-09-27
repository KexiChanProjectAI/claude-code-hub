import { beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "./fake-redis";

const mocks = vi.hoisted(() => ({
  redis: null as unknown,
  handleSerialFailure: vi.fn(),
  releaseEdgeConcurrency: vi.fn(async (state: { concurrency: unknown }) => {
    state.concurrency = { sessionId: null, observedIdentity: null };
  }),
  settleEdgeStreamCompletion: vi.fn(async () => ({
    effectiveStatusCode: 200,
    isSuccessfulCompletion: true,
  })),
  settleEdgeNonStreamCompletion: vi.fn(async () => {}),
  commitNonStreamSuccess: vi.fn(async () => {}),
  persistSpecialSettings: vi.fn(async () => {}),
  setDeferredStreamingFinalization: vi.fn(),
  handleHedgeThreshold: vi.fn(async () => ({ kind: "launch", step: { stepId: "77:h2:1" } })),
  handleHedgeFailure: vi.fn(async () => ({ kind: "wait" })),
  handleHedgeClientAbort: vi.fn(async () => ({
    kind: "fail",
    response: { status: 499, headers: [], bodyText: "{}" },
  })),
  runLoserBilling: vi.fn(async () => {}),
  commitHedgeWinner: vi.fn(),
}));

vi.mock("@/lib/redis/client", () => ({ getRedisClient: () => mocks.redis }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, getCachedSystemSettings: vi.fn(async () => ({})) };
});
vi.mock("@/app/v1/_lib/edge/coordinator", () => ({
  handleSerialFailure: mocks.handleSerialFailure,
  releaseEdgeConcurrency: mocks.releaseEdgeConcurrency,
}));
vi.mock("@/app/v1/_lib/edge/hedge-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/edge/hedge-coordinator")>();
  return {
    ...actual,
    handleHedgeThreshold: mocks.handleHedgeThreshold,
    handleHedgeFailure: mocks.handleHedgeFailure,
    handleHedgeClientAbort: mocks.handleHedgeClientAbort,
    commitHedgeWinner: mocks.commitHedgeWinner,
  };
});
vi.mock("@/app/v1/_lib/proxy/response-handler", () => ({
  settleEdgeStreamCompletion: mocks.settleEdgeStreamCompletion,
  settleEdgeNonStreamCompletion: mocks.settleEdgeNonStreamCompletion,
}));
vi.mock("@/app/v1/_lib/proxy/stream-finalization", () => ({
  setDeferredStreamingFinalization: mocks.setDeferredStreamingFinalization,
}));
vi.mock("@/app/v1/_lib/proxy/forwarder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/forwarder")>();
  return {
    ...actual,
    persistSpecialSettings: mocks.persistSpecialSettings,
    ProxyForwarder: { commitNonStreamSuccess: mocks.commitNonStreamSuccess },
  };
});

import type { NextRequest, WinnerResult } from "@/app/v1/_lib/edge/contract";
import {
  EdgeHandlerError,
  handleEdgeComplete,
  handleEdgeHeartbeat,
  handleEdgeNext,
} from "@/app/v1/_lib/edge/handlers";
import {
  EDGE_DEADLINES_KEY,
  type EdgeRequestState,
  loadEdgeState,
  saveEdgeState,
} from "@/app/v1/_lib/edge/state-store";
import { ProxySession } from "@/app/v1/_lib/proxy/session";

const TOKEN = "t".repeat(32);
const PROVIDER = {
  id: 9,
  name: "p9",
  priority: 1,
  providerType: "claude",
  firstByteTimeoutStreamingMs: 0,
} as never;

async function seedState(overrides: Partial<EdgeRequestState> = {}): Promise<EdgeRequestState> {
  const session = ProxySession.fromEdgeDigest({
    receivedAtMs: Date.now() - 1000,
    method: "POST",
    requestUrl: new URL("http://edge.local/v1/messages"),
    headers: new Headers(),
    syntheticMessage: { model: "m", stream: true, thinking: { type: "enabled" }, messages: [{}] },
    hints: { messagesHash: null, fingerprint: null, isProbe: false, isWarmup: false },
  });
  session.setProvider(PROVIDER);
  const state: EdgeRequestState = {
    v: 1,
    requestId: 77,
    edgeToken: TOKEN,
    edgeId: "e",
    phase: "executing",
    mode: "serial",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    heartbeatIntervalMs: 10_000,
    session: session.toEdgeSnapshot(),
    body: { originalTopLevel: {}, hasPrivateParams: false, contentOps: [] },
    attempts: [
      {
        stepId: "77:1:1",
        kind: "normal",
        providerId: 9,
        endpointId: 4,
        baseUrl: "https://up.example.com/v1?key=secret",
        attemptNumber: 1,
        totalProvidersAttempted: 1,
        sequence: 1,
        status: "inflight",
        isStreaming: true,
      },
    ],
    totalProvidersAttempted: 1,
    failedProviderIds: [],
    providerAttempts: [],
    hedge: null,
    pendingRectifierAudits: [],
    billingHeaderAudited: false,
    lastFailure: null,
    concurrency: { sessionId: "s", observedIdentity: null },
    ...overrides,
  };
  await saveEdgeState(state, 600);
  return state;
}

function nextRequest(event: NextRequest["event"], stepId = "77:1:1"): NextRequest {
  return { requestId: 77, edgeToken: TOKEN, stepId, event };
}

function winner(overrides: Partial<WinnerResult> = {}): WinnerResult {
  return {
    stepId: "77:1:1",
    upstreamStatus: 200,
    responseHeaders: [["content-type", "text/event-stream"]],
    isStreaming: true,
    streamEndedNormally: true,
    clientAborted: false,
    abortReason: null,
    firstByteSeen: true,
    sseEventCount: 5,
    compactSse: "event: message_start\ndata: {}\n\n",
    compactTruncated: false,
    nonStreamBody: null,
    protocol: {
      sawContent: true,
      sawTerminal: true,
      sawIncomplete: false,
      observationIncomplete: false,
      failure: null,
    },
    gateCommit: null,
    fixer: null,
    timing: {
      dispatchedAtMs: Date.now() - 900,
      firstByteAtMs: Date.now() - 500,
      firstTokenAtMs: Date.now() - 400,
      endedAtMs: Date.now(),
      healthElapsedMs: 900,
    },
    bytesToClient: 100,
    ...overrides,
  };
}

describe("edge next handler", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = new FakeRedis();
    mocks.redis = redis;
  });

  test("failure events rebuild the error and return the next step", async () => {
    await seedState();
    mocks.handleSerialFailure.mockImplementationOnce(async (rt) => {
      rt.state.attempts[0].status = "failed";
      return { kind: "step", step: { stepId: "77:1:2" } };
    });
    const response = await handleEdgeNext(
      nextRequest({
        type: "failure",
        failure: { kind: "transport", code: "ECONNRESET", message: "reset" },
        dispatched: true,
        firstByteSeen: false,
        timing: { dispatchedAtMs: 1, firstByteAtMs: null, endedAtMs: 2, healthElapsedMs: 7 },
        opResults: { billingHeader: { removedCount: 1, extractedValues: ["h"] } },
      })
    );
    expect(response).toEqual({ action: "retry", step: { stepId: "77:1:2" } });
    const params = mocks.handleSerialFailure.mock.calls[0][1];
    expect((params.error as Error & { code?: string }).code).toBe("ECONNRESET");
    expect(params.healthElapsedMs).toBe(7);
    expect(mocks.persistSpecialSettings).toHaveBeenCalledTimes(1);

    const state = await loadEdgeState(77);
    expect(state?.lastFailure?.failure.kind).toBe("transport");
    expect(state?.billingHeaderAudited).toBe(true);
    expect(redis.score(EDGE_DEADLINES_KEY, "77")).toBeGreaterThan(Date.now());
  });

  test("replayed events return the cached response without re-running the decision", async () => {
    await seedState();
    mocks.handleSerialFailure.mockResolvedValueOnce({ kind: "step", step: { stepId: "77:1:2" } });
    const request = nextRequest({
      type: "failure",
      failure: { kind: "client_abort" },
      dispatched: false,
      firstByteSeen: false,
      timing: { dispatchedAtMs: null, firstByteAtMs: null, endedAtMs: 1, healthElapsedMs: 0 },
    });
    const first = await handleEdgeNext(request);
    const second = await handleEdgeNext(request);
    expect(second).toEqual(first);
    expect(mocks.handleSerialFailure).toHaveBeenCalledTimes(1);
  });

  test("terminal failures settle the request", async () => {
    await seedState();
    mocks.handleSerialFailure.mockResolvedValueOnce({
      kind: "fail",
      response: { status: 503, headers: [], bodyText: "{}" },
    });
    const response = await handleEdgeNext(
      nextRequest({
        type: "failure",
        failure: { kind: "empty_response", reason: "empty_body" },
        dispatched: true,
        firstByteSeen: false,
        timing: { dispatchedAtMs: 1, firstByteAtMs: null, endedAtMs: 2, healthElapsedMs: 1 },
      })
    );
    expect(response.action).toBe("fail");
    expect((await loadEdgeState(77))?.phase).toBe("settled");
    expect(redis.score(EDGE_DEADLINES_KEY, "77")).toBeUndefined();
  });

  test("suspect bodies are committed or failed over", async () => {
    await seedState();
    const committed = await handleEdgeNext(
      nextRequest({
        type: "suspect_2xx",
        status: 200,
        headers: [["content-type", "application/json"]],
        bodyText: '{"type":"message","content":[{"type":"text","text":"ok"}]}',
        bodyTruncated: false,
      })
    );
    expect(committed).toEqual({ action: "commit" });

    // 独立请求：同一 step 的 suspect 事件按幂等键只处理一次
    mocks.redis = new FakeRedis();
    await seedState();
    mocks.handleSerialFailure.mockResolvedValueOnce({ kind: "step", step: { stepId: "77:1:2" } });
    await handleEdgeNext(
      nextRequest({
        type: "suspect_2xx",
        status: 200,
        headers: [],
        bodyText: "<!doctype html><html><body>oops</body></html>",
        bodyTruncated: false,
      })
    );
    const error = mocks.handleSerialFailure.mock.calls[0][1].error as Error;
    expect(error.message).toBe("FAKE_200_HTML_BODY");
  });

  test("rectifier_not_applicable reuses the recorded trigger failure", async () => {
    await seedState({
      lastFailure: {
        providerId: 9,
        failure: {
          kind: "upstream_status",
          status: 400,
          statusText: "",
          headers: [],
          bodyText: "invalid signature",
          bodyTruncated: false,
        },
      },
      pendingRectifierAudits: [
        {
          stepId: "77:1:1",
          trigger: "invalid_signature_in_thinking_block",
          providerId: 9,
          attemptNumber: 1,
          retryAttemptNumber: 2,
        },
      ],
    });
    mocks.handleSerialFailure.mockResolvedValueOnce({
      kind: "fail",
      response: { status: 400, headers: [], bodyText: "{}" },
    });
    await handleEdgeNext(
      nextRequest({
        type: "rectifier_not_applicable",
        opResults: {
          thinkingSignature: {
            applied: false,
            removedThinkingBlocks: 0,
            removedRedactedThinkingBlocks: 0,
            removedSignatureFields: 0,
            removedTopLevelThinking: false,
          },
        },
      })
    );
    expect(
      (mocks.handleSerialFailure.mock.calls[0][1].error as { statusCode: number }).statusCode
    ).toBe(400);
    const state = await loadEdgeState(77);
    const restored = ProxySession.fromEdgeSnapshot(state!.session);
    expect(restored.getSpecialSettings()).toContainEqual(
      expect.objectContaining({ type: "thinking_signature_rectifier", hit: false })
    );
    expect(state?.pendingRectifierAudits).toHaveLength(0);
  });

  test("hedge thresholds are ignored in serial mode", async () => {
    await seedState();
    expect(await handleEdgeNext(nextRequest({ type: "hedge_threshold" }))).toEqual({
      action: "none",
    });
  });

  test("rejects unknown requests, wrong tokens and stale steps", async () => {
    await expect(handleEdgeNext(nextRequest({ type: "hedge_threshold" }))).rejects.toMatchObject({
      status: 404,
      code: "unknown_request",
    });
    await seedState();
    await expect(
      handleEdgeNext({ ...nextRequest({ type: "hedge_threshold" }), edgeToken: "x".repeat(32) })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      handleEdgeNext(nextRequest({ type: "hedge_threshold" }, "77:9:9"))
    ).rejects.toBeInstanceOf(EdgeHandlerError);
  });
});

describe("edge complete handler", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = new FakeRedis();
    mocks.redis = redis;
  });

  test("streaming completion rebuilds deferred meta and settles once", async () => {
    await seedState();
    const result = await handleEdgeComplete({
      requestId: 77,
      edgeToken: TOKEN,
      winner: winner({
        gateCommit: {
          frameIndex: 2,
          chunkIndex: 1,
          eventName: "content_block_delta",
          bufferedBytes: 10,
          echoExcludedBytes: 0,
          gateWaitMs: 5,
        },
        fixer: {
          hit: true,
          fixersApplied: [{ fixer: "sse", applied: true }],
          totalBytesProcessed: 10,
          processingTimeMs: 1,
        },
      }),
      losers: [],
    });
    expect(result).toEqual({ ok: true, alreadySettled: false });

    const meta = mocks.setDeferredStreamingFinalization.mock.calls[0][1];
    expect(meta).toMatchObject({
      providerId: 9,
      attemptNumber: 1,
      isFirstAttempt: true,
      endpointId: 4,
      endpointUrl: "https://up.example.com/v1?key=[REDACTED]",
      upstreamStatusCode: 200,
      healthFirstByteSeen: true,
      healthAttributionThresholdMs: 30_000,
      streamGate: { eventName: "content_block_delta" },
    });
    const settleInput = mocks.settleEdgeStreamCompletion.mock.calls[0][1];
    expect(settleInput).toMatchObject({
      allContent: "event: message_start\ndata: {}\n\n",
      streamEndedNormally: true,
      sseEventCount: 5,
    });
    const session = mocks.settleEdgeStreamCompletion.mock.calls[0][0] as ProxySession;
    expect(session.ttftMs).not.toBeNull();
    expect(session.firstByteMs).toBeLessThanOrEqual(session.ttftMs!);
    expect(session.getSpecialSettings()).toContainEqual(
      expect.objectContaining({ type: "response_fixer", hit: true })
    );
    expect(mocks.releaseEdgeConcurrency).toHaveBeenCalledTimes(1);

    const again = await handleEdgeComplete({
      requestId: 77,
      edgeToken: TOKEN,
      winner: winner(),
      losers: [],
    });
    expect(again).toEqual({ ok: true, alreadySettled: true });
    expect(mocks.settleEdgeStreamCompletion).toHaveBeenCalledTimes(1);
  });

  test("non-stream completion commits success bookkeeping before billing", async () => {
    await seedState();
    await handleEdgeComplete({
      requestId: 77,
      edgeToken: TOKEN,
      winner: winner({
        isStreaming: false,
        responseHeaders: [["content-type", "application/json"]],
        nonStreamBody: { text: '{"usage":{"input_tokens":1}}', truncated: false },
      }),
      losers: [],
    });
    expect(mocks.commitNonStreamSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ attemptNumber: 1, response: { status: 200 } })
    );
    expect(mocks.settleEdgeNonStreamCompletion.mock.calls[0][1]).toMatchObject({
      responseText: '{"usage":{"input_tokens":1}}',
      statusCode: 200,
    });
    expect((await loadEdgeState(77))?.phase).toBe("settled");
  });

  test("settlement failures still release concurrency and settle", async () => {
    await seedState();
    mocks.settleEdgeStreamCompletion.mockRejectedValueOnce(new Error("db down"));
    await expect(
      handleEdgeComplete({ requestId: 77, edgeToken: TOKEN, winner: winner(), losers: [] })
    ).rejects.toThrow("db down");
    expect(mocks.releaseEdgeConcurrency).toHaveBeenCalledTimes(1);
    expect((await loadEdgeState(77))?.phase).toBe("settled");
  });
});

describe("edge heartbeat handler", () => {
  beforeEach(() => {
    mocks.redis = new FakeRedis();
  });

  test("extends the watchdog deadline for executing requests", async () => {
    const redis = mocks.redis as FakeRedis;
    await seedState();
    const result = await handleEdgeHeartbeat({
      requestId: 77,
      edgeToken: TOKEN,
      bytesForwarded: 1,
    });
    expect(result.deadlineMs).toBeGreaterThan(Date.now() + 20_000);
    expect(redis.score(EDGE_DEADLINES_KEY, "77")).toBe(result.deadlineMs);
  });

  test("rejects settled and unknown requests", async () => {
    await expect(
      handleEdgeHeartbeat({ requestId: 1, edgeToken: TOKEN, bytesForwarded: 0 })
    ).rejects.toMatchObject({ status: 404 });
    await seedState({ phase: "settled" });
    await expect(
      handleEdgeHeartbeat({ requestId: 77, edgeToken: TOKEN, bytesForwarded: 0 })
    ).rejects.toMatchObject({ status: 409 });
  });

  describe("hedge mode", () => {
    async function seedHedge(): Promise<EdgeRequestState> {
      const state = await seedState({
        mode: "hedge",
        attempts: [
          {
            stepId: "77:h1:1",
            kind: "normal",
            providerId: 9,
            endpointId: null,
            baseUrl: "https://up.example.com",
            attemptNumber: 1,
            totalProvidersAttempted: 1,
            sequence: 1,
            status: "inflight",
            isStreaming: true,
          },
        ],
      });
      state.hedge = {
        launchedProviderIds: [9],
        launchedProviderCount: 1,
        noMoreProviders: false,
        maxInFlight: 2,
        billLosers: false,
        initialProviderId: 9,
        participants: [
          {
            sequence: 1,
            providerId: 9,
            provider: PROVIDER,
            endpointId: null,
            baseUrl: "https://up.example.com",
            endpointUrl: "https://up.example.com",
            attemptId: "legacy-hedge-1-1",
            stepId: "77:h1:1",
            requestAttemptCount: 1,
            applyProviderOverrides: false,
            reactiveRectifierRetryState: {
              thinkingSignatureRetried: false,
              thinkingBudgetRetried: false,
              thinkingEffortConflictRetried: false,
              geminiFunctionIdRetried: false,
            },
            status: "inflight",
            thresholdTriggered: false,
            saturationRecorded: false,
            useOriginalSession: true,
            shadow: null,
            body: null,
            billAsLoser: false,
            startedAtMs: Date.now(),
          },
        ],
        lastError: null,
        lastErrorCategory: null,
        metrics: { attempts: 1, active: 1, maxActive: 1, providerMs: 0 },
      };
      await saveEdgeState(state, 600);
      return state;
    }

    test("threshold events are answered by the hedge coordinator", async () => {
      await seedHedge();
      const response = await handleEdgeNext(nextRequest({ type: "hedge_threshold" }, "77:h1:1"));
      expect(response).toEqual({ action: "launch", step: { stepId: "77:h2:1" } });
      expect(mocks.handleSerialFailure).not.toHaveBeenCalled();
      const replay = await handleEdgeNext(nextRequest({ type: "hedge_threshold" }, "77:h1:1"));
      expect(replay).toEqual(response);
      expect(mocks.handleHedgeThreshold).toHaveBeenCalledTimes(1);
    });

    test("failures keep the participant failure for a later rectifier retry", async () => {
      await seedHedge();
      const failure = {
        kind: "upstream_status" as const,
        status: 400,
        statusText: "Bad Request",
        headers: [],
        bodyText: "invalid signature in thinking block",
        bodyTruncated: false,
      };
      const response = await handleEdgeNext(
        nextRequest(
          {
            type: "failure",
            failure,
            dispatched: true,
            firstByteSeen: true,
            timing: { dispatchedAtMs: 1, firstByteAtMs: 2, endedAtMs: 3, healthElapsedMs: 2 },
          },
          "77:h1:1"
        )
      );
      expect(response).toEqual({ action: "wait" });
      const [, participant, params] = mocks.handleHedgeFailure.mock.calls[0] as unknown as [
        unknown,
        { sequence: number },
        { errorDescriptor: unknown },
      ];
      expect(participant.sequence).toBe(1);
      expect(params.errorDescriptor).toEqual({ kind: "failure", providerId: 9, failure });
      const state = await loadEdgeState(77);
      expect(state?.hedge?.participants[0].lastFailure).toEqual(failure);
    });

    test("pre-commit client aborts settle through the request-level abort handler", async () => {
      await seedHedge();
      const response = await handleEdgeNext(
        nextRequest(
          {
            type: "failure",
            failure: { kind: "client_abort" },
            dispatched: true,
            firstByteSeen: false,
            timing: { dispatchedAtMs: 1, firstByteAtMs: null, endedAtMs: 3, healthElapsedMs: 2 },
            peers: [],
          },
          "77:h1:1"
        )
      );
      expect(response).toMatchObject({ action: "fail", response: { status: 499 } });
      expect(mocks.handleHedgeClientAbort).toHaveBeenCalledTimes(1);
      expect((await loadEdgeState(77))?.phase).toBe("settled");
    });

    test("complete commits the hedge winner, settles it and then bills losers", async () => {
      await seedHedge();
      const order: string[] = [];
      mocks.commitHedgeWinner.mockImplementation(() => {
        order.push("commit");
        return {
          runLoserBilling: async () => {
            order.push("losers");
          },
        };
      });
      mocks.settleEdgeStreamCompletion.mockImplementationOnce(async () => {
        order.push("settle");
        return { effectiveStatusCode: 200, isSuccessfulCompletion: true };
      });
      const losers = [
        {
          stepId: "77:h2:1",
          upstreamStatus: 200,
          drainComplete: true,
          meteringText: "x",
          endedAtMs: 1,
        },
      ];
      await handleEdgeComplete({
        requestId: 77,
        edgeToken: TOKEN,
        winner: winner({ stepId: "77:h1:1" }),
        losers,
      });
      expect(order).toEqual(["commit", "settle", "losers"]);
      expect(mocks.commitHedgeWinner.mock.calls[0][3]).toEqual(losers);
      expect(mocks.setDeferredStreamingFinalization).not.toHaveBeenCalled();
      expect(mocks.releaseEdgeConcurrency).toHaveBeenCalledTimes(1);
      expect((await loadEdgeState(77))?.phase).toBe("settled");
    });
  });
});
