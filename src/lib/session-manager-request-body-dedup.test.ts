import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const loggerMock = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@/lib/logger", () => ({ logger: loggerMock }));
vi.mock("@/app/v1/_lib/proxy/errors", () => ({
  sanitizeHeaders: vi.fn(() => ""),
  sanitizeUrl: vi.fn((url: unknown) => String(url)),
}));

type Stored = Buffer;
const stringStore = new Map<string, Stored>();
const hashStore = new Map<string, Map<string, Stored>>();
const sortedSetStore = new Map<string, Set<string>>();
const ttlStore = new Map<string, number>();

function bytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(String(value), "utf8");
}

function text(value: Stored | undefined): string | undefined {
  return value === undefined ? undefined : value.toString("utf8");
}

function deleteKey(key: string): number {
  let removed = 0;
  removed += Number(stringStore.delete(key));
  removed += Number(hashStore.delete(key));
  removed += Number(sortedSetStore.delete(key));
  ttlStore.delete(key);
  return removed;
}

function registerIndex(indexKey: string, bundleKey: string, ttl: number): void {
  const index = sortedSetStore.get(indexKey) ?? new Set<string>();
  index.add(bundleKey);
  sortedSetStore.set(indexKey, index);
  ttlStore.set(indexKey, ttl);
}

/** 以 JS 复刻 session-manager 中请求正文 Lua 脚本的语义，供单测验证 TS 侧协议。 */
function runScript(script: string, keyCount: number, rawArgs: unknown[]): unknown {
  const keys = rawArgs.slice(0, keyCount).map(String);
  const args = rawArgs.slice(keyCount);

  if (script.includes("cch:session-request-bundle:write-base:v1")) {
    for (const key of keys.slice(0, 6)) deleteKey(key);
    const ttl = Number(args[0]);
    const count = Number(args[5]);
    const hash = new Map<string, Stored>([
      ["schema", bytes("1")],
      ["layout", bytes("dedup")],
      ["next", bytes(String(count))],
    ]);
    if (String(args[1]) === "1") hash.set("present:legacy", bytes("1"));
    if (String(args[2]) === "1") hash.set("present:before", bytes("1"));
    if (String(args[3]) !== "") hash.set("ref:legacy", bytes(args[3]));
    if (String(args[4]) !== "") hash.set("ref:before", bytes(args[4]));
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 4;
      hash.set(`body:${index}`, bytes(args[offset]));
      hash.set(`hash:${index}`, bytes(args[offset + 1]));
      hash.set(`bytes:${index}`, bytes(args[offset + 2]));
      if (String(args[offset + 3]) !== "") hash.set(`dict:${index}`, bytes(args[offset + 3]));
    }
    hashStore.set(keys[0], hash);
    ttlStore.set(keys[0], ttl);
    registerIndex(keys[6], keys[0], ttl);
    return 1;
  }

  if (script.includes("cch:session-request-bundle:write-after:v1")) {
    const ttl = Number(args[0]);
    const bodyHash = String(args[1]);
    const hash = hashStore.get(keys[0]) ?? new Map<string, Stored>();
    const nextIndex = Number(text(hash.get("next")) ?? "0");
    let newRef: string | null = null;
    if (bodyHash !== "") {
      for (let index = 0; index < nextIndex; index += 1) {
        if (text(hash.get(`hash:${index}`)) === bodyHash) {
          newRef = String(index);
          break;
        }
      }
      if (newRef === null) {
        const dictRef = String(args[4]);
        if (dictRef !== "" && !hash.has(`body:${dictRef}`)) return 0;
        newRef = String(nextIndex);
        hash.set(`body:${newRef}`, bytes(args[3]));
        hash.set(`hash:${newRef}`, bytes(bodyHash));
        hash.set(`bytes:${newRef}`, bytes(args[2]));
        hash.set("next", bytes(String(nextIndex + 1)));
        if (dictRef !== "") hash.set(`dict:${newRef}`, bytes(dictRef));
      }
    }
    const oldRef = text(hash.get("ref:after"));
    if (
      oldRef !== undefined &&
      oldRef !== newRef &&
      oldRef !== text(hash.get("ref:legacy")) &&
      oldRef !== text(hash.get("ref:before"))
    ) {
      for (const field of ["body", "hash", "bytes", "dict"]) hash.delete(`${field}:${oldRef}`);
    }
    deleteKey(keys[1]);
    if (!hash.has("schema")) hash.set("schema", bytes("1"));
    if (!hash.has("layout")) hash.set("layout", bytes("dedup"));
    if (!hash.has("next")) hash.set("next", bytes(String(nextIndex)));
    hash.set("present:after", bytes("1"));
    if (newRef !== null) hash.set("ref:after", bytes(newRef));
    else hash.delete("ref:after");
    hashStore.set(keys[0], hash);
    ttlStore.set(keys[0], ttl);
    registerIndex(keys[2], keys[0], ttl);
    return 1;
  }

  if (script.includes("cch:session-request-bundle:read:v1")) {
    const hash = hashStore.get(keys[0]);
    if (!hash) return [0, 0, null, null];
    const view = String(args[0]);
    const present = hash.has(`present:${view}`) ? 1 : 0;
    const ref = text(hash.get(`ref:${view}`));
    if (ref === undefined) return [1, present, null, null];
    let body = hash.get(`body:${ref}`) ?? null;
    const dictRef = text(hash.get(`dict:${ref}`));
    let dictBody: Buffer | null = null;
    if (dictRef !== undefined) {
      dictBody = hash.get(`body:${dictRef}`) ?? null;
      if (dictBody === null) body = null;
    }
    return [1, present, body, dictBody];
  }

  if (script.includes("cch:session-response-bundle:read:v1")) {
    const legacy = stringStore.get(keys[1]);
    return [0, legacy === undefined ? 0 : 1, legacy ?? null];
  }

  if (script.includes("cch:session-response-bundle:delete-session:v2")) {
    let deleted = 0;
    const requestIndex = sortedSetStore.get(keys[5]);
    deleted += deleteKey(keys[5]);
    for (const bundleKey of requestIndex ?? []) {
      const prefix = bundleKey.slice(0, -"request-bodies:v1".length);
      deleted += deleteKey(bundleKey);
      for (const suffix of [
        "requestBody",
        "messages",
        "snapshot:request:before:body",
        "snapshot:request:before:messages",
        "snapshot:request:after:body",
      ]) {
        deleted += deleteKey(`${prefix}${suffix}`);
      }
    }
    return deleted;
  }

  throw new Error(`unexpected Redis script: ${script.slice(0, 60)}`);
}

const scanMock = vi.fn(async (_cursor: string, _match: string, pattern: string) => {
  const regex = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`
  );
  const keys = [...stringStore.keys(), ...hashStore.keys()].filter((key) => regex.test(key));
  return ["0", keys];
});

const redisMock = {
  status: "ready",
  setex: vi.fn((key: string, ttl: number, value: unknown) => {
    stringStore.set(key, bytes(value));
    ttlStore.set(key, ttl);
    return Promise.resolve("OK");
  }),
  get: vi.fn((key: string) => Promise.resolve(text(stringStore.get(key)) ?? null)),
  getBuffer: vi.fn((key: string) => Promise.resolve(stringStore.get(key) ?? null)),
  del: vi.fn((...keys: string[]) => Promise.resolve(keys.reduce((n, k) => n + deleteKey(k), 0))),
  exists: vi.fn((key: string) => Promise.resolve(stringStore.has(key) ? 1 : 0)),
  scan: scanMock,
  eval: vi.fn(async (script: string, keyCount: number, ...rawArgs: unknown[]) =>
    runScript(script, keyCount, rawArgs)
  ),
  callBuffer: vi.fn(async (command: string, args: unknown[]) => {
    if (command !== "EVAL") throw new Error(`unexpected callBuffer ${command}`);
    const [script, keyCount, ...rest] = args;
    return runScript(String(script), Number(keyCount), rest);
  }),
};

vi.mock("@/lib/redis", () => ({ getRedisClient: () => redisMock }));

let mockStoreMessages = true;
let mockDedupEnabled = true;
let mockArtifactMaxBytes = 5 * 1024 * 1024;

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => ({
    STORE_SESSION_MESSAGES: mockStoreMessages,
    STORE_SESSION_RESPONSE_BODY: true,
    SESSION_REQUEST_BODY_DEDUP_ENABLED: mockDedupEnabled,
    SESSION_REQUEST_ARTIFACT_MAX_BYTES: mockArtifactMaxBytes,
    SESSION_RESPONSE_BODY_MAX_BYTES: 5 * 1024 * 1024,
    SESSION_PAYLOAD_ZSTD_LEVEL: 1,
    SESSION_TTL: 300,
  }),
}));

const { SessionManager } = await import("@/lib/session-manager");

const BUNDLE = "session:sess_req:req:1:request-bodies:v1";
const INDEX = "session:sess_req:request-body-bundles:v1";

function bundleFields(): Map<string, Stored> {
  return hashStore.get(BUNDLE) ?? new Map();
}

function bodyCount(): number {
  return [...bundleFields().keys()].filter((field) => field.startsWith("body:")).length;
}

function largeClaudeBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-test",
    system: "system prompt",
    messages: Array.from({ length: 1500 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i} ${"agent context ".repeat(8)} ${i.toString(36)}`,
    })),
    ...extra,
  };
}

describe("SessionManager request body deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stringStore.clear();
    hashStore.clear();
    sortedSetStore.clear();
    ttlStore.clear();
    redisMock.status = "ready";
    mockStoreMessages = true;
    mockDedupEnabled = true;
    mockArtifactMaxBytes = 5 * 1024 * 1024;
  });

  it("reports the dedup flag only when explicitly true", () => {
    expect(SessionManager.isRequestBodyDedupEnabled()).toBe(true);
    mockDedupEnabled = false;
    expect(SessionManager.isRequestBodyDedupEnabled()).toBe(false);
  });

  it("stores identical legacy and before bodies once and derives messages on read", async () => {
    const body = largeClaudeBody();
    stringStore.set("session:sess_req:req:1:requestBody", bytes("stale"));
    stringStore.set("session:sess_req:req:1:snapshot:request:before:messages", bytes("stale"));

    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: body, beforeBody: JSON.stringify(body) },
      1
    );

    expect(base?.ref).toBe("0");
    expect(bodyCount()).toBe(1);
    expect(text(bundleFields().get("ref:legacy"))).toBe("0");
    expect(text(bundleFields().get("ref:before"))).toBe("0");
    expect(stringStore.size).toBe(0);
    expect(ttlStore.get(BUNDLE)).toBe(300);
    expect(sortedSetStore.get(INDEX)).toEqual(new Set([BUNDLE]));

    const frame = bundleFields().get("body:0") as Buffer;
    expect([...frame.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(frame.length).toBeLessThan(Buffer.byteLength(JSON.stringify(body)) / 4);

    await expect(SessionManager.getSessionRequestBody("sess_req", 1)).resolves.toEqual(body);
    await expect(SessionManager.getSessionMessages("sess_req", 1)).resolves.toEqual(body.messages);
    const before = await SessionManager.getSessionRequestPhaseSnapshot("sess_req", "before", 1);
    expect(before?.body).toEqual(body);
    expect(before?.messages).toEqual(body.messages);
  });

  it("stores a differing before body as a small dictionary delta against the legacy body", async () => {
    const before = largeClaudeBody();
    const legacy = largeClaudeBody({ metadata: { user_id: "session_abc" } });

    await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: legacy, beforeBody: before },
      1
    );

    expect(bodyCount()).toBe(2);
    expect(text(bundleFields().get("ref:legacy"))).toBe("0");
    expect(text(bundleFields().get("ref:before"))).toBe("1");
    expect(text(bundleFields().get("dict:1"))).toBe("0");
    expect((bundleFields().get("body:1") as Buffer).length).toBeLessThan(2048);

    await expect(SessionManager.getSessionRequestBody("sess_req", 1)).resolves.toEqual(legacy);
    const snapshot = await SessionManager.getSessionRequestPhaseSnapshot("sess_req", "before", 1);
    expect(snapshot?.body).toEqual(before);
  });

  it("writes only a reference when the after body equals a stored body", async () => {
    const body = largeClaudeBody();
    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: body, beforeBody: body },
      1
    );
    stringStore.set("session:sess_req:req:1:snapshot:request:after:body", bytes("stale"));

    await SessionManager.storeSessionRequestBodyBundleAfter(
      "sess_req",
      JSON.stringify(body),
      1,
      base
    );

    expect(bodyCount()).toBe(1);
    expect(text(bundleFields().get("ref:after"))).toBe("0");
    expect(stringStore.has("session:sess_req:req:1:snapshot:request:after:body")).toBe(false);
    const after = await SessionManager.getSessionRequestPhaseSnapshot("sess_req", "after", 1);
    expect(after?.body).toEqual(body);
    expect(after?.messages).toBeNull();
  });

  it("dictionary-compresses a changed after body and replaces it on retry", async () => {
    const body = largeClaudeBody();
    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: body, beforeBody: body },
      1
    );

    const firstAfter = { ...body, model: "upstream-a" };
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", firstAfter, 1, base);
    expect(text(bundleFields().get("ref:after"))).toBe("1");
    expect(text(bundleFields().get("dict:1"))).toBe("0");
    expect((bundleFields().get("body:1") as Buffer).length).toBeLessThan(2048);
    await expect(
      SessionManager.getSessionRequestPhaseSnapshot("sess_req", "after", 1)
    ).resolves.toMatchObject({ body: firstAfter });

    const retryAfter = { ...body, model: "upstream-b" };
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", retryAfter, 1, base);
    expect(bundleFields().has("body:1")).toBe(false);
    expect(text(bundleFields().get("ref:after"))).toBe("2");
    expect(bodyCount()).toBe(2);
    await expect(
      SessionManager.getSessionRequestPhaseSnapshot("sess_req", "after", 1)
    ).resolves.toMatchObject({ body: retryAfter });
  });

  it("falls back to an independent frame when the dictionary body is gone", async () => {
    const body = largeClaudeBody();
    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: body, beforeBody: body },
      1
    );
    bundleFields().delete("body:0");

    const after = { ...body, model: "upstream" };
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", after, 1, base);

    const ref = text(bundleFields().get("ref:after"));
    expect(ref).toBeDefined();
    expect(bundleFields().has(`dict:${ref}`)).toBe(false);
    await expect(
      SessionManager.getSessionRequestPhaseSnapshot("sess_req", "after", 1)
    ).resolves.toMatchObject({ body: after });
  });

  it("creates the bundle from the after body alone when no base was written", async () => {
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", { model: "m" }, 1, null);

    expect(text(bundleFields().get("ref:after"))).toBe("0");
    expect(text(bundleFields().get("schema"))).toBe("1");
    await expect(
      SessionManager.getSessionRequestPhaseSnapshot("sess_req", "after", 1)
    ).resolves.toMatchObject({ body: { model: "m" } });
    // 已存在 bundle 时不回退旧 key，legacy 视图缺失即为 null。
    await expect(SessionManager.getSessionRequestBody("sess_req", 1)).resolves.toBeNull();
    await expect(SessionManager.getSessionMessages("sess_req", 1)).resolves.toBeNull();
  });

  it("marks oversized bodies present without storing them", async () => {
    mockArtifactMaxBytes = 64;
    const body = { messages: [{ role: "user", content: "x".repeat(200) }] };

    const base = await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: body, beforeBody: body },
      1
    );
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", body, 1, base);

    expect(base).toBeNull();
    expect(bodyCount()).toBe(0);
    expect(text(bundleFields().get("present:legacy"))).toBe("1");
    expect(text(bundleFields().get("present:after"))).toBe("1");
    expect(bundleFields().has("ref:after")).toBe(false);
    const before = await SessionManager.getSessionRequestPhaseSnapshot("sess_req", "before", 1);
    expect(before).toMatchObject({ body: null, messages: null });
  });

  it("redacts before storing and deduplicates on the redacted form", async () => {
    mockStoreMessages = false;
    const legacy = { messages: [{ role: "user", content: "secret a" }] };
    const before = { messages: [{ role: "user", content: "secret b" }] };

    await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: legacy, beforeBody: before },
      1
    );

    expect(bodyCount()).toBe(1);
    const stored = (await SessionManager.getSessionRequestBody("sess_req", 1)) as {
      messages: Array<{ content: string }>;
    };
    expect(stored.messages[0].content).not.toContain("secret");
  });

  it("derives Codex and Gemini messages views from the body", async () => {
    const codex = { model: "gpt", input: [{ role: "user", content: "hi" }] };
    await SessionManager.storeSessionRequestBodyBundleBase("sess_req", { legacyBody: codex }, 1);
    await expect(SessionManager.getSessionMessages("sess_req", 1)).resolves.toEqual(codex.input);

    const gemini = { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } };
    await SessionManager.storeSessionRequestBodyBundleBase("sess_req", { beforeBody: gemini }, 1);
    const before = await SessionManager.getSessionRequestPhaseSnapshot("sess_req", "before", 1);
    expect(before?.messages).toEqual(gemini.request.contents);
  });

  it("reads old per-view keys, including base64 envelopes, when no bundle exists", async () => {
    const { compressPayload } = await import("@/lib/compression/payload-codec");
    const body = largeClaudeBody();
    stringStore.set(
      "session:sess_req:req:1:requestBody",
      bytes(await compressPayload(JSON.stringify(body)))
    );
    stringStore.set("session:sess_req:req:1:messages", bytes(JSON.stringify(body.messages)));
    stringStore.set(
      "session:sess_req:req:1:snapshot:request:before:body",
      bytes(JSON.stringify({ a: 1 }))
    );

    await expect(SessionManager.getSessionRequestBody("sess_req", 1)).resolves.toEqual(body);
    await expect(SessionManager.getSessionMessages("sess_req", 1)).resolves.toEqual(body.messages);
    await expect(
      SessionManager.getSessionRequestPhaseSnapshot("sess_req", "before", 1)
    ).resolves.toMatchObject({ body: { a: 1 }, messages: null });
    await expect(
      SessionManager.getSessionRequestPhaseSnapshot("sess_req", "after", 1)
    ).resolves.toBeNull();
  });

  it("finds sessions whose messages only live in a request bundle", async () => {
    await expect(SessionManager.hasAnySessionMessages("sess_req")).resolves.toBe(false);
    await SessionManager.storeSessionRequestBodyBundleBase(
      "sess_req",
      { legacyBody: largeClaudeBody() },
      1
    );
    await expect(SessionManager.hasAnySessionMessages("sess_req")).resolves.toBe(true);
  });

  it("returns null and stays silent when Redis is not ready", async () => {
    redisMock.status = "end";
    await expect(
      SessionManager.storeSessionRequestBodyBundleBase("sess_req", { legacyBody: {} }, 1)
    ).resolves.toBeNull();
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", {}, 1, null);
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it("logs and returns null when the bundle write fails", async () => {
    redisMock.eval.mockRejectedValueOnce(new Error("boom"));
    await expect(
      SessionManager.storeSessionRequestBodyBundleBase("sess_req", { legacyBody: { a: 1 } }, 1)
    ).resolves.toBeNull();
    redisMock.eval.mockRejectedValueOnce(new Error("boom"));
    await SessionManager.storeSessionRequestBodyBundleAfter("sess_req", { a: 1 }, 1, null);
    expect(loggerMock.error).toHaveBeenCalledTimes(2);
  });
});
