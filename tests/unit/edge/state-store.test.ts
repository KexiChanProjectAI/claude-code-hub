import { beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "./fake-redis";

const redisControl = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => redisControl.client,
}));

import {
  clearEdgeDeadline,
  decodeEdgeJson,
  EDGE_DEADLINES_KEY,
  EdgeStateLockTimeoutError,
  EdgeStateUnavailableError,
  encodeEdgeJson,
  generateEdgeToken,
  getIdempotentResponse,
  isEdgeStateStoreAvailable,
  listDueEdgeDeadlines,
  loadEdgeState,
  saveEdgeState,
  scheduleEdgeDeadline,
  setIdempotentResponse,
  touchEdgeState,
  withEdgeRequestLock,
  type EdgeRequestState,
} from "@/app/v1/_lib/edge/state-store";
import { ProxySession } from "@/app/v1/_lib/proxy/session";

function makeSession(): ProxySession {
  const session = ProxySession.fromEdgeDigest({
    receivedAtMs: 1_700_000_000_000,
    method: "POST",
    requestUrl: new URL("http://edge.local/v1/messages?beta=true"),
    headers: new Headers({ "user-agent": "claude-cli/2.1.90", "anthropic-beta": "a,b" }),
    syntheticMessage: { model: "claude-sonnet-4-5", stream: true, messages: [{}, {}] },
    hints: { messagesHash: "0123456789abcdef", fingerprint: null, isProbe: false, isWarmup: false },
  });
  session.setAuthState({
    user: { id: 1, name: "u", createdAt: new Date("2025-01-02T03:04:05.000Z") } as never,
    key: { id: 2, name: "k", costResetAt: new Date("2025-02-01T00:00:00.000Z") } as never,
    apiKey: "sk-client",
    success: true,
  });
  session.setSessionId("sess_1");
  session.addSpecialSetting({
    type: "billing_header_rectifier",
    scope: "request",
    hit: true,
    removedCount: 1,
    extractedValues: ["x"],
  });
  session.addProviderToChain(
    { id: 5, name: "p", priority: 0, weight: 1, costMultiplier: 1 } as never,
    { reason: "initial_selection" }
  );
  return session;
}

function makeState(session: ProxySession, requestId = 101): EdgeRequestState {
  return {
    v: 1,
    requestId,
    edgeToken: generateEdgeToken(),
    edgeId: "edge-a",
    phase: "executing",
    mode: "serial",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    heartbeatIntervalMs: 15_000,
    session: session.toEdgeSnapshot(),
    body: {
      originalTopLevel: { model: "claude-sonnet-4-5" },
      hasPrivateParams: false,
      contentOps: [],
    },
    attempts: [],
    totalProvidersAttempted: 0,
    failedProviderIds: [],
    providerAttempts: [],
    hedge: null,
    pendingRectifierAudits: [],
    billingHeaderAudited: false,
    lastFailure: null,
    concurrency: { sessionId: "sess_1", observedIdentity: null },
  };
}

describe("edge state store", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    redisControl.client = redis;
  });

  test("Date values survive the JSON round trip", () => {
    const value = { at: new Date("2025-01-01T00:00:00.000Z"), nested: [{ d: new Date(0) }] };
    const decoded = decodeEdgeJson<typeof value>(encodeEdgeJson(value));
    expect(decoded.at).toBeInstanceOf(Date);
    expect(decoded.at.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(decoded.nested[0].d.getTime()).toBe(0);
    const invalid = decodeEdgeJson<{ d: Date }>(encodeEdgeJson({ d: new Date(Number.NaN) }));
    expect(Number.isNaN(invalid.d.getTime())).toBe(true);
  });

  test("save and load restore a session that behaves like the original", async () => {
    const session = makeSession();
    const state = makeState(session);
    await saveEdgeState(state, 60);

    const loaded = await loadEdgeState(state.requestId);
    expect(loaded).not.toBeNull();
    const restored = ProxySession.fromEdgeSnapshot(loaded!.session);
    expect(restored.startTime).toBe(session.startTime);
    expect(restored.requestUrl.toString()).toBe("http://edge.local/v1/messages?beta=true");
    expect(restored.headers.get("anthropic-beta")).toBe("a,b");
    expect(restored.sessionId).toBe("sess_1");
    expect(restored.authState?.key?.costResetAt).toBeInstanceOf(Date);
    expect(restored.getSpecialSettings()).toEqual(session.getSpecialSettings());
    expect(restored.getProviderChain()).toEqual(session.getProviderChain());
    expect(restored.edgeDigestHints?.messagesHash).toBe("0123456789abcdef");
    expect(restored.isHeaderModified("user-agent")).toBe(false);
    expect(restored.shouldPersistSessionDebugArtifacts()).toBe(false);
  });

  test("the raw Responses service_tier survives the snapshot round trip", () => {
    const session = ProxySession.fromEdgeDigest({
      receivedAtMs: 1_700_000_000_000,
      method: "POST",
      requestUrl: new URL("http://edge.local/v1/responses"),
      headers: new Headers(),
      syntheticMessage: { model: "gpt-5-codex", service_tier: "priority" },
      hints: {
        messagesHash: "0123456789abcdef",
        fingerprint: null,
        isProbe: false,
        isWarmup: false,
      },
    });
    expect(session.getRawResponsesServiceTier()).toBe("priority");

    const snapshot = session.toEdgeSnapshot();
    expect(snapshot.rawResponsesServiceTier).toBe("priority");
    expect(ProxySession.fromEdgeSnapshot(snapshot).getRawResponsesServiceTier()).toBe("priority");
  });

  test("snapshots persisted without rawResponsesServiceTier restore it as null", () => {
    const { rawResponsesServiceTier: _omitted, ...legacySnapshot } = makeSession().toEdgeSnapshot();
    const restored = ProxySession.fromEdgeSnapshot(legacySnapshot);
    expect(restored.getRawResponsesServiceTier()).toBeNull();
  });

  test("large states are compressed transparently", async () => {
    const session = makeSession();
    const state = makeState(session, 202);
    state.body.originalTopLevel.metadata = { blob: "x".repeat(40_000) };
    await saveEdgeState(state, 60);
    const raw = await redis.get("cch:edge:req:202");
    expect(raw?.includes("x".repeat(1000))).toBe(false);
    const loaded = await loadEdgeState(202);
    expect((loaded!.body.originalTopLevel.metadata as { blob: string }).blob).toHaveLength(40_000);
  });

  test("missing state loads as null and touch extends TTL", async () => {
    expect(await loadEdgeState(999)).toBeNull();
    const state = makeState(makeSession(), 303);
    await saveEdgeState(state, 1);
    await touchEdgeState(303, 600);
    const entry = redis.strings.get("cch:edge:req:303");
    expect(entry!.expiresAt! - Date.now()).toBeGreaterThan(500_000);
  });

  test("idempotent responses round trip", async () => {
    expect(await getIdempotentResponse("decide:x")).toBeNull();
    await setIdempotentResponse("decide:x", { action: "delegate", reason: "r" }, 60);
    expect(await getIdempotentResponse("decide:x")).toEqual({ action: "delegate", reason: "r" });
  });

  test("deadlines are scheduled, listed by due time and cleared", async () => {
    await scheduleEdgeDeadline(1, 1000);
    await scheduleEdgeDeadline(2, 3000);
    await scheduleEdgeDeadline(3, 2000);
    expect(await listDueEdgeDeadlines(2500, 10)).toEqual([1, 3]);
    await clearEdgeDeadline(1);
    expect(await listDueEdgeDeadlines(5000, 1)).toEqual([3]);
    expect(redis.score(EDGE_DEADLINES_KEY, "2")).toBe(3000);
  });

  test("request lock serializes concurrent critical sections", async () => {
    const order: string[] = [];
    await Promise.all([
      withEdgeRequestLock(7, async () => {
        order.push("a:start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push("a:end");
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await withEdgeRequestLock(7, async () => {
          order.push("b");
        });
      })(),
    ]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
    expect(await redis.get("cch:edge:lock:7")).toBeNull();
  });

  test("lock acquisition times out when the lock is held", async () => {
    vi.useFakeTimers();
    try {
      await redis.set("cch:edge:lock:8", "other", "PX", 60_000);
      const pending = withEdgeRequestLock(8, async () => "never");
      const assertion = expect(pending).rejects.toBeInstanceOf(EdgeStateLockTimeoutError);
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("operations fail fast when Redis is unavailable", async () => {
    redisControl.client = null;
    expect(isEdgeStateStoreAvailable()).toBe(false);
    await expect(loadEdgeState(1)).rejects.toBeInstanceOf(EdgeStateUnavailableError);
    redisControl.client = Object.assign(new FakeRedis(), { status: "connecting" });
    expect(isEdgeStateStoreAvailable()).toBe(false);
  });

  test("generated edge tokens are unique hex strings", () => {
    const a = generateEdgeToken();
    const b = generateEdgeToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});
