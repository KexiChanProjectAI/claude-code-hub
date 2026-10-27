import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

process.env.ENABLE_RATE_LIMIT = "true";
process.env.SESSION_TTL = "60";
process.env.STORE_SESSION_MESSAGES = "true";
process.env.SESSION_REQUEST_BODY_DEDUP_ENABLED = "true";

const { SessionManager } = await import("@/lib/session-manager");
const { closeRedis, getRedisClient } = await import("@/lib/redis/client");

const HAS_REDIS = Boolean(process.env.REDIS_URL);
const runWithRedis = describe.skipIf(!HAS_REDIS);
const TEST_PREFIX = `it-session-request-body-${Date.now()}-${randomUUID()}`;
const touchedSessions = new Set<string>();

const LEGACY_SUFFIXES = [
  "requestBody",
  "messages",
  "snapshot:request:before:body",
  "snapshot:request:before:messages",
  "snapshot:request:after:body",
];

function bundleKey(sessionId: string, sequence = 1): string {
  return `session:${sessionId}:req:${sequence}:request-bodies:v1`;
}

function indexKey(sessionId: string): string {
  return `session:${sessionId}:request-body-bundles:v1`;
}

function agentBody(turns: number, extra: Record<string, unknown> = {}) {
  return {
    model: "claude-test",
    system: "You are an agent.",
    messages: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${randomUUID()} step ${i} ${"tool output ".repeat(20)}` }],
    })),
    ...extra,
  };
}

async function waitForRedisReady() {
  const client = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!client) throw new Error("Redis client unavailable for integration test");
  if (client.status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Redis ready timeout")), 5_000);
      client.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  return client;
}

runWithRedis("session request body deduplication Redis integration", () => {
  let redis: Redis;
  let counter = 0;

  function nextSessionId(label: string): string {
    counter += 1;
    const sessionId = `${TEST_PREFIX}:${label}:${counter}`;
    touchedSessions.add(sessionId);
    return sessionId;
  }

  async function cleanup(): Promise<void> {
    for (const sessionId of touchedSessions) {
      const keys = await redis.keys(`session:${sessionId}:*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    touchedSessions.clear();
  }

  beforeAll(async () => {
    await waitForRedisReady();
    redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
  });

  afterEach(cleanup);

  afterAll(async () => {
    if (redis) {
      await cleanup();
      if (redis.status !== "end") await redis.quit();
    }
    await closeRedis();
  });

  test("stores one frame for identical views and a tiny delta for the after body", async () => {
    const sessionId = nextSessionId("full");
    const prefix = `session:${sessionId}:req:1:`;
    for (const suffix of LEGACY_SUFFIXES) await redis.setex(`${prefix}${suffix}`, 60, "stale");
    const body = agentBody(2000);
    const json = JSON.stringify(body);

    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      sessionId,
      { legacyBody: body, beforeBody: json },
      1
    );
    const after = { ...body, metadata: { user_id: "session_abc" } };
    await SessionManager.storeSessionRequestBodyBundleAfter(sessionId, after, 1, base);

    for (const suffix of LEGACY_SUFFIXES) {
      expect(await redis.exists(`${prefix}${suffix}`)).toBe(0);
    }
    const fields = await redis.hgetallBuffer(bundleKey(sessionId));
    expect(
      Object.keys(fields)
        .filter((field) => field.startsWith("body:"))
        .sort()
    ).toEqual(["body:0", "body:1"]);
    expect(fields["ref:legacy"].toString()).toBe("0");
    expect(fields["ref:before"].toString()).toBe("0");
    expect(fields["ref:after"].toString()).toBe("1");
    expect([...fields["body:0"].subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(fields["body:1"].length).toBeLessThan(2048);
    expect(await redis.ttl(bundleKey(sessionId))).toBeGreaterThan(0);
    expect(await redis.zrange(indexKey(sessionId), 0, -1)).toEqual([bundleKey(sessionId)]);

    const hashBytes = (await redis.memory("USAGE", bundleKey(sessionId))) as number;
    expect(hashBytes).toBeLessThan(Buffer.byteLength(json) / 2);

    await expect(SessionManager.getSessionRequestBody(sessionId, 1)).resolves.toEqual(body);
    await expect(SessionManager.getSessionMessages(sessionId, 1)).resolves.toEqual(body.messages);
    const beforeSnapshot = await SessionManager.getSessionRequestPhaseSnapshot(
      sessionId,
      "before",
      1
    );
    expect(beforeSnapshot?.body).toEqual(body);
    expect(beforeSnapshot?.messages).toEqual(body.messages);
    const afterSnapshot = await SessionManager.getSessionRequestPhaseSnapshot(
      sessionId,
      "after",
      1
    );
    expect(afterSnapshot?.body).toEqual(after);
  });

  test("replaces a retried after body instead of accumulating copies", async () => {
    const sessionId = nextSessionId("retry");
    const body = agentBody(300);
    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      sessionId,
      { legacyBody: body, beforeBody: body },
      1
    );

    for (const model of ["a", "b", "c"]) {
      await SessionManager.storeSessionRequestBodyBundleAfter(
        sessionId,
        { ...body, model },
        1,
        base
      );
    }
    await SessionManager.storeSessionRequestBodyBundleAfter(sessionId, body, 1, base);

    const fields = await redis.hkeys(bundleKey(sessionId));
    expect(fields.filter((field) => field.startsWith("body:"))).toEqual(["body:0"]);
    expect(await redis.hget(bundleKey(sessionId), "ref:after")).toBe("0");
  });

  test("full session termination removes request body bundles and their index", async () => {
    const sessionId = nextSessionId("terminate");
    await SessionManager.storeSessionRequestBodyBundleBase(sessionId, { legacyBody: { a: 1 } }, 1);
    await SessionManager.storeSessionRequestBodyBundleBase(sessionId, { legacyBody: { a: 2 } }, 2);
    expect(await redis.zcard(indexKey(sessionId))).toBe(2);

    await expect(SessionManager.terminateSession(sessionId)).resolves.toBe(true);

    expect(
      await redis.exists(bundleKey(sessionId, 1), bundleKey(sessionId, 2), indexKey(sessionId))
    ).toBe(0);
  });
});
