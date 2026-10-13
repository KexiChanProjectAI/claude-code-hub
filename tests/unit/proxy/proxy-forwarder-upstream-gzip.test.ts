import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import {
  buildUpstreamGzipTarget,
  clearUpstreamGzipSupportCache,
  getUpstreamGzipMemorySnapshot,
  getUpstreamGzipSupport,
} from "@/app/v1/_lib/proxy/upstream-compression";
import type { Provider } from "@/types/provider";

const mocks = vi.hoisted(() => {
  return {
    isHttp2Enabled: vi.fn(async () => false),
  };
});

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    isHttp2Enabled: mocks.isHttp2Enabled,
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

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "p1",
    url: "http://127.0.0.1:1",
    key: "k",
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "openai-compatible",
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

function createSession(params?: { stream?: boolean; content?: string }): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://example.com/v1/chat/completions"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "gpt-5.5",
      log: "(test)",
      message: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: params?.content ?? "x".repeat(4096) }],
        ...(params?.stream ? { stream: true } : {}),
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
    endpointPolicy: resolveEndpointPolicy("/v1/chat/completions"),
    isHeaderModified: () => false,
  });

  return session as ProxySession;
}

type ReceivedRequest = {
  contentEncoding: string | undefined;
  acceptEncoding: string | undefined;
  body: string;
};

type Handler = (req: ReceivedRequest, res: ServerResponse<IncomingMessage>, index: number) => void;

async function startServer(
  handler: Handler
): Promise<{ baseUrl: string; received: ReceivedRequest[]; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const received: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const contentEncoding = req.headers["content-encoding"];
      const entry: ReceivedRequest = {
        contentEncoding,
        acceptEncoding: req.headers["accept-encoding"],
        body: (contentEncoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8"),
      };
      received.push(entry);
      handler(entry, res, received.length - 1);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { baseUrl, received, close };
}

function json(res: ServerResponse<IncomingMessage>, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** 模拟不认识 content-encoding 的上游：收到压缩体直接 400。 */
const rejectsGzip: Handler = (req, res) => {
  if (req.contentEncoding === "gzip") {
    json(res, 400, { error: { message: "invalid json" } });
    return;
  }
  json(res, 200, { ok: true });
};

async function forward(provider: Provider, session: ProxySession): Promise<Response> {
  session.setProvider(provider);
  const doForward = (
    ProxyForwarder as unknown as {
      doForward: (this: typeof ProxyForwarder, ...args: unknown[]) => Promise<Response>;
    }
  ).doForward;
  return await doForward.call(ProxyForwarder, session, provider, provider.url);
}

describe("ProxyForwarder - upstream gzip", () => {
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  beforeEach(() => {
    clearUpstreamGzipSupportCache();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("压缩请求体发往支持 gzip 的上游，并记为 supported", async () => {
    server = await startServer((_req, res) => json(res, 200, { ok: true }));
    const provider = createProvider({ url: server.baseUrl });

    const response = await forward(provider, createSession());
    expect(response.status).toBe(200);
    await response.text();

    expect(server.received).toHaveLength(1);
    expect(server.received[0].contentEncoding).toBe("gzip");
    expect(JSON.parse(server.received[0].body).messages[0].content).toBe("x".repeat(4096));
    expect(getUpstreamGzipSupport(buildUpstreamGzipTarget(provider.id, server.baseUrl))).toBe(
      "supported"
    );
  });

  test("小于阈值的请求体保持明文", async () => {
    server = await startServer((_req, res) => json(res, 200, { ok: true }));
    const provider = createProvider({ url: server.baseUrl });

    const response = await forward(provider, createSession({ content: "hi" }));
    await response.text();

    expect(server.received[0].contentEncoding).toBeUndefined();
  });

  test("上游拒绝压缩体时用明文重发，之后直接发明文", async () => {
    server = await startServer(rejectsGzip);
    const provider = createProvider({ url: server.baseUrl });

    const first = await forward(provider, createSession());
    expect(first.status).toBe(200);
    await first.text();
    expect(server.received.map((r) => r.contentEncoding)).toEqual(["gzip", undefined]);
    expect(server.received[1].body).toBe(server.received[0].body);
    expect(getUpstreamGzipSupport(buildUpstreamGzipTarget(provider.id, server.baseUrl))).toBe(
      "unsupported"
    );

    const second = await forward(provider, createSession());
    expect(second.status).toBe(200);
    await second.text();
    expect(server.received.map((r) => r.contentEncoding)).toEqual(["gzip", undefined, undefined]);
  });

  test("明文重发也失败时不标记 unsupported，并抛出明文请求的错误", async () => {
    server = await startServer((req, res) =>
      json(res, 400, { error: { message: req.contentEncoding ?? "plain" } })
    );
    const provider = createProvider({ url: server.baseUrl });

    const error = await forward(provider, createSession()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyError);
    expect((error as ProxyError).statusCode).toBe(400);
    expect(server.received.map((r) => r.contentEncoding)).toEqual(["gzip", undefined]);
    expect(getUpstreamGzipSupport(buildUpstreamGzipTarget(provider.id, server.baseUrl))).toBe(
      "unknown"
    );
  });

  test("已确认支持 gzip 的上游返回 400 时不再明文重发", async () => {
    server = await startServer((_req, res, index) =>
      index === 0 ? json(res, 200, { ok: true }) : json(res, 400, { error: { message: "bad" } })
    );
    const provider = createProvider({ url: server.baseUrl });

    await (await forward(provider, createSession())).text();
    const error = await forward(provider, createSession()).catch((e: unknown) => e);

    expect((error as ProxyError).statusCode).toBe(400);
    expect(server.received.map((r) => r.contentEncoding)).toEqual(["gzip", "gzip"]);
  });

  test("不在回退集合内的状态码（如 401）不触发明文重发", async () => {
    server = await startServer((_req, res) => json(res, 401, { error: { message: "nope" } }));
    const provider = createProvider({ url: server.baseUrl });

    const error = await forward(provider, createSession()).catch((e: unknown) => e);

    expect((error as ProxyError).statusCode).toBe(401);
    expect(server.received).toHaveLength(1);
  });

  test("非流式请求声明 accept-encoding: gzip 并透明解压响应", async () => {
    server = await startServer((req, res) => {
      const payload = Buffer.from(JSON.stringify({ ok: true, ae: req.acceptEncoding }));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(payload));
    });
    const provider = createProvider({ url: server.baseUrl });

    const response = await forward(provider, createSession());

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ ok: true, ae: "gzip" });
    expect(getUpstreamGzipMemorySnapshot().get(provider.id)?.response?.state).toBe("compressed");
  });

  test("流式请求同样声明 gzip，逐事件 flush 的 SSE 被增量解压", async () => {
    server = await startServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "x-accept-encoding": req.acceptEncoding ?? "",
      });
      const gz = createGzip();
      gz.pipe(res);
      gz.write("data: one\n\n");
      gz.flush(() => {
        gz.write("data: two\n\n");
        gz.end();
      });
    });
    const provider = createProvider({ url: server.baseUrl });

    const response = await forward(provider, createSession({ stream: true }));

    expect(server.received[0].acceptEncoding).toBe("gzip");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    expect(getUpstreamGzipMemorySnapshot().get(provider.id)?.response?.state).toBe("compressed");
  });
});
