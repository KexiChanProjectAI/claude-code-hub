// @vitest-environment node
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, test, vi } from "vitest";

const env = vi.hoisted(() => ({
  ENABLE_CLIENT_RESPONSE_GZIP: true,
  CLIENT_RESPONSE_GZIP_MIN_BYTES: 1024,
}));

const mocks = vi.hoisted(() => ({
  respond: (() => new Response("{}")) as () => Response | Promise<Response>,
}));

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => env,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

vi.mock("@/app/v1/_lib/proxy-handler", () => ({
  handleProxyRequest: () => mocks.respond(),
}));

vi.mock("@/app/v1/_lib/models/available-models", () => ({
  handleAvailableModels: () => Response.json({ data: [{ id: "model-a" }] }),
  handleCodexModels: () => Response.json({ data: [] }),
  handleOpenAICompatibleModels: () => Response.json({ data: [] }),
}));

vi.mock("@/app/v1/_lib/catalog/handle-catalog", () => ({
  handleModelCatalog: () => Response.json({ catalog: [] }),
}));

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: { initialize: vi.fn(async () => undefined) },
}));

vi.mock("@/lib/sensitive-word-detector", () => ({
  sensitiveWordDetector: { reload: vi.fn(async () => undefined) },
}));

vi.mock("@/drizzle/db", () => ({
  withDataDbScope: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

import {
  GET as v1Get,
  HEAD as v1Head,
  OPTIONS as v1Options,
  POST as v1Post,
} from "@/app/v1/[...route]/route";
import { GET as v1betaGet, POST as v1betaPost } from "@/app/v1beta/[...route]/route";

const PAYLOAD = JSON.stringify({ id: "msg_1", content: "x".repeat(2048) });

function post(path: string, acceptEncoding: string | null = "gzip"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (acceptEncoding !== null) headers.set("accept-encoding", acceptEncoding);
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: "{}" });
}

function get(path: string, acceptEncoding: string | null = "gzip", method = "GET"): Request {
  const headers = new Headers();
  if (acceptEncoding !== null) headers.set("accept-encoding", acceptEncoding);
  return new Request(`http://localhost${path}`, { method, headers });
}

async function gunzipBody(response: Response): Promise<string> {
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString();
}

beforeEach(() => {
  env.ENABLE_CLIENT_RESPONSE_GZIP = true;
  env.CLIENT_RESPONSE_GZIP_MIN_BYTES = 1024;
  mocks.respond = () =>
    new Response(PAYLOAD, { headers: { "content-type": "application/json; charset=utf-8" } });
});

describe("/v1 client response gzip", () => {
  test("compresses proxy JSON responses when the client accepts gzip", async () => {
    const response = await v1Post(post("/v1/messages"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
    expect(await gunzipBody(response)).toBe(PAYLOAD);
  });

  test("leaves responses untouched when the client does not accept gzip", async () => {
    const response = await v1Post(post("/v1/messages", null));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(PAYLOAD);
  });

  test("compresses SSE streams", async () => {
    const events = ["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"];
    mocks.respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) controller.enqueue(new TextEncoder().encode(event));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    const response = await v1Post(post("/v1/chat/completions"));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzipBody(response)).toBe(events.join(""));
  });

  test("respects cache-control no-transform", async () => {
    mocks.respond = () =>
      new Response("data: x\n\n", {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
      });
    const response = await v1Post(post("/v1/messages"));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("data: x\n\n");
  });

  test("does not compress 204 responses", async () => {
    mocks.respond = () => new Response(null, { status: 204 });
    const response = await v1Post(post("/v1/messages"));
    expect(response.status).toBe(204);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("compresses error responses", async () => {
    const error = JSON.stringify({ error: { type: "rate_limit", message: "slow down" } });
    mocks.respond = () =>
      new Response(error, { status: 429, headers: { "content-type": "application/json" } });
    const response = await v1Post(post("/v1/messages"));
    expect(response.status).toBe(429);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzipBody(response)).toBe(error);
  });

  test("returns the Hono 500 when the handler throws", async () => {
    mocks.respond = () => {
      throw new Error("boom");
    };
    const response = await v1Post(post("/v1/messages"));
    expect(response.status).toBe(500);
  });

  test("covers model list routes", async () => {
    const response = await v1Get(get("/v1/models"));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(await gunzipBody(response))).toEqual({ data: [{ id: "model-a" }] });
  });

  test("covers unprefixed alias paths", async () => {
    const response = await v1Post(post("/messages"));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzipBody(response)).toBe(PAYLOAD);
  });

  test("does not compress HEAD or OPTIONS", async () => {
    const head = await v1Head(get("/v1/models", "gzip", "HEAD"));
    expect(head.headers.get("content-encoding")).toBeNull();
    const options = await v1Options(get("/v1/messages", "gzip", "OPTIONS"));
    expect(options.status).toBe(204);
    expect(options.headers.get("content-encoding")).toBeNull();
  });

  test("keeps the internal ping plain without accept-encoding", async () => {
    const response = await v1Get(get("/v1/_ping", null));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ status: "pong" });
  });

  test("honors the switch", async () => {
    env.ENABLE_CLIENT_RESPONSE_GZIP = false;
    const response = await v1Post(post("/v1/messages"));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(PAYLOAD);
  });
});

describe("/v1beta client response gzip", () => {
  test("compresses Gemini proxy responses", async () => {
    const response = await v1betaPost(post("/v1beta/models/gemini-pro:generateContent"));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzipBody(response)).toBe(PAYLOAD);
  });

  test("compresses the model list", async () => {
    const response = await v1betaGet(get("/v1beta/models"));
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  test("leaves responses untouched without accept-encoding", async () => {
    const response = await v1betaPost(post("/v1beta/models/gemini-pro:generateContent", null));
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});
