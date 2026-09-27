import { beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "./fake-redis";

const mocks = vi.hoisted(() => ({
  redis: null as unknown,
  secret: "s".repeat(40) as string | undefined,
  handle: vi.fn(async () => new Response("{}", { status: 502 })),
  releaseEdgeConcurrency: vi.fn(async (state: { concurrency: unknown }) => {
    state.concurrency = { sessionId: null, observedIdentity: null };
  }),
  handleEdgeDecide: vi.fn(async () => ({ action: "delegate", reason: "edge_disabled" })),
  handleEdgeNext: vi.fn(),
  handleEdgeComplete: vi.fn(async () => ({ ok: true, alreadySettled: false })),
  handleEdgeHeartbeat: vi.fn(async () => ({ ok: true, deadlineMs: 1 })),
}));

vi.mock("@/lib/redis/client", () => ({ getRedisClient: () => mocks.redis }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  return {
    ...actual,
    getEnvConfig: () => ({ ...actual.getEnvConfig(), CCH_EDGE_SHARED_SECRET: mocks.secret }),
  };
});
vi.mock("@/app/v1/_lib/proxy/error-handler", () => ({
  ProxyErrorHandler: { handle: mocks.handle },
}));
vi.mock("@/app/v1/_lib/edge/coordinator", () => ({
  releaseEdgeConcurrency: mocks.releaseEdgeConcurrency,
}));
vi.mock("@/app/v1/_lib/edge/decide", () => ({ handleEdgeDecide: mocks.handleEdgeDecide }));
vi.mock("@/app/v1/_lib/edge/handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/edge/handlers")>();
  return {
    EdgeHandlerError: actual.EdgeHandlerError,
    handleEdgeNext: mocks.handleEdgeNext,
    handleEdgeComplete: mocks.handleEdgeComplete,
    handleEdgeHeartbeat: mocks.handleEdgeHeartbeat,
  };
});

import { buildRequestDigest } from "@/app/v1/_lib/edge/digest";
import { EdgeHandlerError } from "@/app/v1/_lib/edge/handlers";
import { edgeApp } from "@/app/v1/_lib/edge/router";
import {
  EDGE_DEADLINES_KEY,
  EdgeStateUnavailableError,
  type EdgeRequestState,
  loadEdgeState,
  saveEdgeState,
  scheduleEdgeDeadline,
} from "@/app/v1/_lib/edge/state-store";
import { EDGE_REPORT_TIMEOUT_MESSAGE, runEdgeWatchdogTick } from "@/app/v1/_lib/edge/watchdog";
import { ProxySession } from "@/app/v1/_lib/proxy/session";

async function seed(requestId: number, phase: EdgeRequestState["phase"], updatedAgoMs = 0) {
  const session = ProxySession.fromEdgeDigest({
    receivedAtMs: Date.now(),
    method: "POST",
    requestUrl: new URL("http://edge.local/v1/messages"),
    headers: new Headers(),
    syntheticMessage: { model: "m", messages: [] },
    hints: { messagesHash: null, fingerprint: null, isProbe: false, isWarmup: false },
  });
  const state = {
    v: 1,
    requestId,
    edgeToken: "t".repeat(32),
    edgeId: "e",
    phase,
    mode: "serial",
    createdAtMs: Date.now(),
    updatedAtMs: 0,
    heartbeatIntervalMs: 1000,
    session: session.toEdgeSnapshot(),
    body: { originalTopLevel: {}, hasPrivateParams: false, contentOps: [] },
    attempts: [],
    totalProvidersAttempted: 1,
    failedProviderIds: [],
    providerAttempts: [],
    hedge: null,
    pendingRectifierAudits: [],
    billingHeaderAudited: false,
    lastFailure: null,
    concurrency: { sessionId: "s", observedIdentity: null },
  } as EdgeRequestState;
  await saveEdgeState(state, 600);
  if (updatedAgoMs > 0) {
    const redis = mocks.redis as FakeRedis;
    const raw = JSON.parse((await redis.get(`cch:edge:req:${requestId}`))!);
    raw.updatedAtMs = Date.now() - updatedAgoMs;
    await redis.set(`cch:edge:req:${requestId}`, JSON.stringify(raw));
  }
  await scheduleEdgeDeadline(requestId, 1);
}

describe("edge watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis = new FakeRedis();
  });

  test("settles overdue executing requests exactly once", async () => {
    await seed(1, "executing");
    expect(await runEdgeWatchdogTick()).toBe(1);
    const error = mocks.handle.mock.calls[0][1] as Error & { statusCode: number };
    expect(error.message).toContain(EDGE_REPORT_TIMEOUT_MESSAGE);
    expect(error.statusCode).toBe(502);
    expect(mocks.releaseEdgeConcurrency).toHaveBeenCalledTimes(1);
    expect((await loadEdgeState(1))?.phase).toBe("settled");
    expect((mocks.redis as FakeRedis).score(EDGE_DEADLINES_KEY, "1")).toBeUndefined();
    expect(await runEdgeWatchdogTick()).toBe(0);
  });

  test("skips settled and missing states and reschedules fresh completions", async () => {
    await seed(2, "settled");
    await scheduleEdgeDeadline(3, 1);
    await seed(4, "completing");
    expect(await runEdgeWatchdogTick()).toBe(0);
    const redis = mocks.redis as FakeRedis;
    expect(redis.score(EDGE_DEADLINES_KEY, "2")).toBeUndefined();
    expect(redis.score(EDGE_DEADLINES_KEY, "3")).toBeUndefined();
    expect(redis.score(EDGE_DEADLINES_KEY, "4")).toBeGreaterThan(Date.now());
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  test("stuck completions are settled after the grace period", async () => {
    await seed(5, "completing", 120_000);
    expect(await runEdgeWatchdogTick()).toBe(1);
  });

  test("per-request failures do not abort the tick", async () => {
    await seed(6, "executing");
    await seed(7, "executing");
    mocks.handle.mockRejectedValueOnce(new Error("db down"));
    expect(await runEdgeWatchdogTick()).toBe(1);
    expect((await loadEdgeState(6))?.phase).toBe("settled");
  });
});

describe("edge router", () => {
  const secretHeader = { "x-cch-edge-secret": "s".repeat(40) };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.secret = "s".repeat(40);
  });

  function post(path: string, body: unknown, headers: Record<string, string> = secretHeader) {
    return edgeApp.request(`/api/internal/edge${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("rejects requests without the shared secret", async () => {
    expect((await post("/decide", {}, {})).status).toBe(401);
    expect((await post("/decide", {}, { "x-cch-edge-secret": "wrong" })).status).toBe(401);
    mocks.secret = undefined;
    const response = await post("/decide", {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "edge_not_configured", message: "edge_not_configured" },
    });
  });

  test("validates payloads", async () => {
    expect((await post("/decide", "{not json")).status).toBe(400);
    const invalid = await post("/decide", { schemaVersion: 1 });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("invalid_payload");
    const huge = await post("/next", "x".repeat(2 * 1024 * 1024 + 10));
    expect(huge.status).toBe(413);
  });

  test("dispatches decide with the edge id header", async () => {
    const digest = buildRequestDigest({
      edgeId: "from-body",
      edgeRequestId: "r",
      receivedAtMs: Date.now(),
      method: "POST",
      path: "/v1/messages",
      headers: [],
      clientIp: null,
      body: { model: "m", messages: [] },
      bodyBytes: 2,
    });
    const response = await post("/decide", digest, { ...secretHeader, "x-cch-edge-id": "hdr" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "delegate", reason: "edge_disabled" });
    expect(mocks.handleEdgeDecide).toHaveBeenCalledWith(expect.anything(), "hdr");
  });

  test("maps handler errors to status codes", async () => {
    const next = {
      requestId: 1,
      edgeToken: "t".repeat(32),
      stepId: "1:1:1",
      event: { type: "hedge_threshold" },
    };
    mocks.handleEdgeNext.mockRejectedValueOnce(new EdgeHandlerError(409, "stale_step"));
    const stale = await post("/next", next);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("stale_step");

    mocks.handleEdgeNext.mockRejectedValueOnce(new EdgeStateUnavailableError());
    expect((await post("/next", next)).status).toBe(503);

    mocks.handleEdgeNext.mockRejectedValueOnce(new Error("boom"));
    expect((await post("/next", next)).status).toBe(500);

    mocks.handleEdgeNext.mockResolvedValueOnce({ action: "none" });
    expect(await (await post("/next", next)).json()).toEqual({ action: "none" });
  });

  test("complete and heartbeat endpoints", async () => {
    const heartbeat = await post("/heartbeat", {
      requestId: 1,
      edgeToken: "t".repeat(32),
      bytesForwarded: 10,
    });
    expect(await heartbeat.json()).toEqual({ ok: true, deadlineMs: 1 });
    const health = await edgeApp.request("/api/internal/edge/health", { headers: secretHeader });
    expect(await health.json()).toEqual({ ok: true });
  });
});
