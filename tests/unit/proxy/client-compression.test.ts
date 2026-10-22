// @vitest-environment node
import { constants as zlibConstants, createGunzip, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const env = vi.hoisted(() => ({
  ENABLE_CLIENT_RESPONSE_GZIP: true,
  CLIENT_RESPONSE_GZIP_MIN_BYTES: 1024,
}));

const zlibControl = vi.hoisted(() => ({ throwOnCreate: false }));

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => env,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    createGzip: (...args: Parameters<typeof actual.createGzip>) => {
      if (zlibControl.throwOnCreate) throw new Error("zlib unavailable");
      return actual.createGzip(...args);
    },
  };
});

import {
  compressClientResponse,
  decideClientResponseCompression,
  gzipClientResponseBody,
  isCompressibleClientContentType,
  isStreamingClientContentType,
  negotiateClientResponseEncoding,
  withClientResponseCompression,
} from "@/app/v1/_lib/proxy/client-compression";
import { createDemandDrivenResponsePump } from "@/app/v1/_lib/proxy/demand-driven-response-pump";

const encoder = new TextEncoder();

function gzipRequest(method = "POST", acceptEncoding: string | null = "gzip"): Request {
  const headers = new Headers();
  if (acceptEncoding !== null) headers.set("accept-encoding", acceptEncoding);
  return new Request("http://localhost/v1/messages", { method, headers });
}

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(body, { ...init, headers });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

beforeEach(() => {
  env.ENABLE_CLIENT_RESPONSE_GZIP = true;
  env.CLIENT_RESPONSE_GZIP_MIN_BYTES = 1024;
  zlibControl.throwOnCreate = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("negotiateClientResponseEncoding", () => {
  test.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["gzip", "gzip"],
    ["x-gzip", "gzip"],
    ["GZIP", "gzip"],
    ["gzip, deflate, br", "gzip"],
    [" br ;q=1 , gzip ; q=0.5 ", "gzip"],
    ["gzip;q=0", null],
    ["gzip; q=0.0", null],
    ["gzip;q=abc", null],
    ["gzip;level=1", "gzip"],
    ["identity", null],
    ["identity, gzip;q=0", null],
    ["*", null],
    ["deflate, br", null],
    ["gzip;q=0, gzip", "gzip"],
    ["gzip, gzip;q=0", null],
  ])("%s -> %s", (header, expected) => {
    expect(negotiateClientResponseEncoding(header)).toBe(expected);
  });
});

describe("content type policy", () => {
  test.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["application/problem+json", true],
    ["application/x-ndjson", true],
    ["text/plain", true],
    ["TEXT/EVENT-STREAM; charset=utf-8", true],
    ["application/octet-stream", false],
    ["image/png", false],
    ["", false],
    [null, false],
  ])("compressible %s -> %s", (contentType, expected) => {
    expect(isCompressibleClientContentType(contentType)).toBe(expected);
  });

  test.each([
    ["text/event-stream", true],
    ["text/event-stream; charset=utf-8", true],
    ["application/x-ndjson", true],
    ["application/json", false],
    [null, false],
  ])("streaming %s -> %s", (contentType, expected) => {
    expect(isStreamingClientContentType(contentType)).toBe(expected);
  });
});

describe("decideClientResponseCompression", () => {
  test("compresses chunked JSON when gzip is accepted", () => {
    expect(decideClientResponseCompression(gzipRequest(), jsonResponse("{}"))).toEqual({
      encoding: "gzip",
      streaming: false,
    });
  });

  test("marks SSE and NDJSON as streaming", () => {
    for (const contentType of ["text/event-stream", "application/x-ndjson"]) {
      const response = new Response("data: x\n\n", { headers: { "content-type": contentType } });
      expect(decideClientResponseCompression(gzipRequest(), response)?.streaming).toBe(true);
    }
  });

  test("skips when the switch is off", () => {
    env.ENABLE_CLIENT_RESPONSE_GZIP = false;
    expect(decideClientResponseCompression(gzipRequest(), jsonResponse("{}"))).toBeNull();
  });

  test("skips HEAD and clients that do not accept gzip", () => {
    expect(decideClientResponseCompression(gzipRequest("HEAD"), jsonResponse("{}"))).toBeNull();
    expect(
      decideClientResponseCompression(gzipRequest("POST", null), jsonResponse("{}"))
    ).toBeNull();
    expect(
      decideClientResponseCompression(gzipRequest("POST", "gzip;q=0"), jsonResponse("{}"))
    ).toBeNull();
  });

  test.each([101, 204, 304])("skips status %s", (status) => {
    const response = {
      status,
      body: new ReadableStream(),
      headers: new Headers({ "content-type": "application/json" }),
    } as unknown as Response;
    expect(decideClientResponseCompression(gzipRequest(), response)).toBeNull();
  });

  test("skips responses without a body", () => {
    expect(
      decideClientResponseCompression(
        gzipRequest(),
        new Response(null, { status: 200, headers: { "content-type": "application/json" } })
      )
    ).toBeNull();
  });

  test("skips responses that are already encoded, but not identity", () => {
    const br = jsonResponse("{}", { headers: { "content-encoding": "br" } });
    expect(decideClientResponseCompression(gzipRequest(), br)).toBeNull();
    const identity = jsonResponse("{}", { headers: { "content-encoding": "identity" } });
    expect(decideClientResponseCompression(gzipRequest(), identity)).not.toBeNull();
  });

  test("respects cache-control no-transform", () => {
    const response = new Response("data: x\n\n", {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
    });
    expect(decideClientResponseCompression(gzipRequest(), response)).toBeNull();
    const notQuite = jsonResponse("{}", { headers: { "cache-control": "no-transformer" } });
    expect(decideClientResponseCompression(gzipRequest(), notQuite)).not.toBeNull();
  });

  test("skips non-compressible content types", () => {
    const response = new Response("x", { headers: { "content-type": "application/octet-stream" } });
    expect(decideClientResponseCompression(gzipRequest(), response)).toBeNull();
  });

  test("applies the size threshold only when content-length is known", () => {
    const small = jsonResponse("{}", { headers: { "content-length": "100" } });
    expect(decideClientResponseCompression(gzipRequest(), small)).toBeNull();
    const large = jsonResponse("{}", { headers: { "content-length": "4096" } });
    expect(decideClientResponseCompression(gzipRequest(), large)).not.toBeNull();
    env.CLIENT_RESPONSE_GZIP_MIN_BYTES = 0;
    const tiny = jsonResponse("{}", { headers: { "content-length": "2" } });
    expect(decideClientResponseCompression(gzipRequest(), tiny)).not.toBeNull();
  });
});

describe("compressClientResponse", () => {
  test("round-trips a JSON body and rewrites headers", async () => {
    const payload = JSON.stringify({ text: "a".repeat(5 * 1024) });
    const original = jsonResponse(payload, {
      status: 201,
      statusText: "Created",
      headers: { "content-length": String(payload.length), vary: "Origin", "x-keep": "1" },
    });
    const compressed = compressClientResponse(original, { encoding: "gzip", streaming: false });

    expect(compressed.status).toBe(201);
    expect(compressed.statusText).toBe("Created");
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("content-length")).toBeNull();
    expect(compressed.headers.get("vary")).toBe("Origin, Accept-Encoding");
    expect(compressed.headers.get("x-keep")).toBe("1");
    const raw = await readAll(compressed.body as ReadableStream<Uint8Array>);
    expect(raw.length).toBeLessThan(payload.length);
    expect(gunzipSync(raw).toString()).toBe(payload);
  });

  test("does not duplicate an existing Vary accept-encoding", () => {
    const compressed = compressClientResponse(
      jsonResponse("{}", { headers: { vary: "accept-encoding" } }),
      { encoding: "gzip", streaming: false }
    );
    expect(compressed.headers.get("vary")).toBe("accept-encoding");
  });

  test("produces a valid gzip stream for an empty body", async () => {
    const compressed = compressClientResponse(jsonResponse(""), {
      encoding: "gzip",
      streaming: false,
    });
    const raw = await readAll(compressed.body as ReadableStream<Uint8Array>);
    expect(gunzipSync(raw).toString()).toBe("");
  });

  test("returns the response unchanged when it has no body", () => {
    const response = new Response(null, { status: 200 });
    expect(compressClientResponse(response, { encoding: "gzip", streaming: false })).toBe(response);
  });
});

describe("gzipClientResponseBody streaming behavior", () => {
  test("delivers each SSE event before the next one is produced", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const reader = gzipClientResponseBody(source, { streaming: true }).getReader();
    const gunzip = createGunzip({ flush: zlibConstants.Z_SYNC_FLUSH });
    const decoded: string[] = [];
    gunzip.on("data", (chunk: Buffer) => decoded.push(chunk.toString()));

    const readDecoded = async () => {
      const { value } = await reader.read();
      await new Promise<void>((resolve) => gunzip.write(value, () => resolve()));
      await new Promise((resolve) => setImmediate(resolve));
      return decoded.join("");
    };

    controller.enqueue(encoder.encode("data: one\n\n"));
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1000));
    expect(await Promise.race([readDecoded(), timeout])).toBe("data: one\n\n");

    controller.enqueue(encoder.encode("data: two\n\n"));
    expect(await readDecoded()).toBe("data: one\n\ndata: two\n\n");

    controller.close();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gunzip.write(value);
    }
    gunzip.end();
    await new Promise((resolve) => gunzip.on("end", resolve));
    expect(decoded.join("")).toBe("data: one\n\ndata: two\n\n");
  });

  test("propagates client cancellation to the source stream", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls += 1;
          c.enqueue(encoder.encode(`data: ${pulls}\n\n`));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const reader = gzipClientResponseBody(source, { streaming: true }).getReader();
    await reader.read();
    await reader.cancel(new Error("client gone"));

    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ message: "client gone" }));
    });
  });

  test("propagates client cancellation through the demand-driven response pump", async () => {
    const onClientCancel = vi.fn();
    // 手动驱动的上游：客户端断开后 pump 会在后台把上游读完以完成计费，
    // 因此在断言取消之后再关闭上游。
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        upstreamController = c;
      },
    });
    upstreamController.enqueue(encoder.encode("data: 1\n\n"));
    const pump = createDemandDrivenResponsePump({
      source: upstream,
      onChunk: vi.fn(),
      onClientCancel,
    });
    const reader = gzipClientResponseBody(pump.stream, { streaming: true }).getReader();
    await reader.read();
    await reader.cancel(new Error("client gone"));

    await vi.waitFor(() => {
      expect(onClientCancel).toHaveBeenCalledWith(
        expect.objectContaining({ message: "client gone" })
      );
    });
    expect(pump.wasClientAborted()).toBe(true);
    upstreamController.close();
    const completion = await pump.completion;
    expect(completion.clientAborted).toBe(true);
  });

  test("propagates source errors to the client without unhandled rejections", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const reader = gzipClientResponseBody(source, { streaming: true }).getReader();
      controller.enqueue(encoder.encode("data: one\n\n"));
      await reader.read();
      controller.error(new Error("upstream boom"));

      await expect(
        (async () => {
          for (;;) {
            const { done } = await reader.read();
            if (done) return "done";
          }
        })()
      ).rejects.toThrow("upstream boom");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("withClientResponseCompression", () => {
  test("passes the response through when gzip is not negotiated", async () => {
    const response = jsonResponse('{"ok":true}');
    const handler = withClientResponseCompression(() => response);
    expect(await handler(gzipRequest("POST", null))).toBe(response);
  });

  test("compresses when the client accepts gzip", async () => {
    const handler = withClientResponseCompression(async () => jsonResponse('{"ok":true}'));
    const result = await handler(gzipRequest());
    expect(result.headers.get("content-encoding")).toBe("gzip");
    const raw = await readAll(result.body as ReadableStream<Uint8Array>);
    expect(gunzipSync(raw).toString()).toBe('{"ok":true}');
  });

  test("returns the original response when gzip setup fails", async () => {
    zlibControl.throwOnCreate = true;
    const response = jsonResponse('{"ok":true}');
    const handler = withClientResponseCompression(() => response);
    const result = await handler(gzipRequest());
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(await result.text()).toBe('{"ok":true}');
  });
});
