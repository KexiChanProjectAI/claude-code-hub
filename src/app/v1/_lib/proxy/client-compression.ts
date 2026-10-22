/**
 * 入站（代理 -> 客户端）响应 gzip 支持。
 *
 * 请求方向（客户端 content-encoding 压缩的请求体）已由 body-store 的流式解码处理，这里只负责响应。
 *
 * 1. 协商：只认客户端 Accept-Encoding 中显式列出的 gzip / x-gzip（q>0）。通配符 `*`
 *    刻意不认：需要 gzip 的客户端都会明确声明。
 * 2. 位置：包在路由导出的处理函数外层（Hono 之外），在所有改写响应体的层（错误 session id、
 *    响应模型复写、CORS 等）之后执行。不用 Hono 中间件：Hono 会忽略 next() 之后返回的
 *    Response，且 c.res setter 会把旧响应头（含过期的 content-length）合并回新响应。
 * 3. 流：Readable.fromWeb -> createGzip -> nodeStreamToWebStreamSafe，用 stream.pipeline 连接。
 *    - SSE / NDJSON 每次写入 Z_SYNC_FLUSH，事件立即到达客户端；其余类型默认 Z_NO_FLUSH。
 *    - 客户端断开：输出流 cancel -> 销毁 gzip -> pipeline 销毁 fromWeb 源 -> 原响应体
 *      reader.cancel()，代理原有的客户端中断检测与计费逻辑照常触发。不能用 .pipe：
 *      它在目标销毁时只 unpipe，源会永远暂停，取消无法传回。
 *    - pipeline 一接上就开始拉取源数据，与客户端是否读取无关；显式的 16 KiB 水位把超前
 *      拉取限制在几十 KiB 内，背压仍能传回源。
 * 4. 响应带 content-encoding 后，Next 自带的 compression 中间件会跳过，不会双重压缩。
 */
import { pipeline, Readable, type TransformOptions } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { createGzip, type ZlibOptions, constants as zlibConstants } from "node:zlib";
import { mergeVaryHeader } from "@/app/v1/_lib/cors";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { nodeStreamToWebStreamSafe } from "./node-stream-to-web";

export type ClientResponseEncoding = "gzip";

export interface ClientCompressionDecision {
  encoding: ClientResponseEncoding;
  /** SSE / NDJSON：每次写入都 flush，保证逐事件送达。 */
  streaming: boolean;
}

/** gzip 内部缓冲与源读取水位；限制 pipeline 在客户端未读取时的超前拉取量。 */
const GZIP_BUFFER_BYTES = 16 * 1024;

const GZIP_TOKENS: ReadonlySet<string> = new Set(["gzip", "x-gzip"]);

function parseQValue(params: string[]): number {
  for (const param of params) {
    const [name, value] = param.split("=").map((part) => part.trim());
    if (name?.toLowerCase() !== "q") continue;
    // 非法 q 值按不可接受处理（RFC 9110 qvalue 只允许 0..1）
    if (value === undefined || !/^\d+(\.\d*)?$/.test(value)) return 0;
    return Math.min(1, Math.max(0, Number(value)));
  }
  return 1;
}

/**
 * 解析客户端 Accept-Encoding，返回应使用的响应编码；不压缩时返回 null。
 * 多个 gzip 条目时以最后一个为准。
 */
export function negotiateClientResponseEncoding(
  acceptEncoding: string | null | undefined
): ClientResponseEncoding | null {
  if (!acceptEncoding) return null;
  let gzipQ: number | null = null;
  for (const entry of acceptEncoding.split(",")) {
    const [token, ...params] = entry.split(";");
    const name = token?.trim().toLowerCase();
    if (!name || !GZIP_TOKENS.has(name)) continue;
    gzipQ = parseQValue(params);
  }
  return gzipQ !== null && gzipQ > 0 ? "gzip" : null;
}

function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** JSON（含 +json）、NDJSON 与所有 text/*（含 SSE）。缺失 content-type 视为不可压缩。 */
export function isCompressibleClientContentType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  if (!type) return false;
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/x-ndjson" ||
    type.endsWith("+json")
  );
}

export function isStreamingClientContentType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type === "text/event-stream" || type === "application/x-ndjson";
}

/** 判断是否压缩该响应；返回 null 表示原样返回。所有跳过规则集中在这里。 */
export function decideClientResponseCompression(
  request: Request,
  response: Response
): ClientCompressionDecision | null {
  const env = getEnvConfig();
  if (!env.ENABLE_CLIENT_RESPONSE_GZIP) return null;
  if (request.method.toUpperCase() === "HEAD") return null;

  const encoding = negotiateClientResponseEncoding(request.headers.get("accept-encoding"));
  if (!encoding) return null;

  const { status, headers } = response;
  if (status < 200 || status === 204 || status === 304) return null;
  if (response.body === null) return null;

  const existingEncoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (existingEncoding && existingEncoding !== "identity") return null;

  if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(headers.get("cache-control") ?? "")) return null;

  const contentType = headers.get("content-type");
  if (!isCompressibleClientContentType(contentType)) return null;

  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length < env.CLIENT_RESPONSE_GZIP_MIN_BYTES) return null;
  }

  return { encoding, streaming: isStreamingClientContentType(contentType) };
}

/** 把 Web 响应体包进 gzip 流。先构造 gzip，最后才锁定源，保证抛错时原响应仍可用。 */
export function gzipClientResponseBody(
  body: ReadableStream<Uint8Array>,
  options: { streaming: boolean }
): ReadableStream<Uint8Array> {
  // zlib 运行时会把选项透传给 Transform，但类型定义未包含流水位字段。
  const gzipOptions: ZlibOptions &
    Pick<TransformOptions, "readableHighWaterMark" | "writableHighWaterMark"> = {
    flush: options.streaming ? zlibConstants.Z_SYNC_FLUSH : zlibConstants.Z_NO_FLUSH,
    chunkSize: GZIP_BUFFER_BYTES,
    readableHighWaterMark: GZIP_BUFFER_BYTES,
    writableHighWaterMark: GZIP_BUFFER_BYTES,
  };
  const gzip = createGzip(gzipOptions);
  const source = Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>, {
    highWaterMark: GZIP_BUFFER_BYTES,
  });
  pipeline(source, gzip, (error) => {
    if (!error) return;
    logger.debug("[ClientGzip] Pipeline closed with error", {
      code: (error as NodeJS.ErrnoException).code,
      error: error.message,
    });
  });
  return nodeStreamToWebStreamSafe(gzip, 0, "client-gzip");
}

/** 返回 gzip 后的新响应：设置 content-encoding，删除长度相关头，Vary 追加 Accept-Encoding。 */
export function compressClientResponse(
  response: Response,
  decision: ClientCompressionDecision
): Response {
  if (!response.body) return response;
  const headers = new Headers(response.headers);
  const body = gzipClientResponseBody(response.body, { streaming: decision.streaming });
  headers.set("content-encoding", decision.encoding);
  headers.delete("content-length");
  headers.delete("content-range");
  headers.set("vary", mergeVaryHeader(headers.get("vary"), "Accept-Encoding"));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 路由级包装：在处理函数返回后按客户端 Accept-Encoding 压缩响应，失败时原样返回。 */
export function withClientResponseCompression(
  handler: (request: Request) => Response | Promise<Response>
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handler(request);
    try {
      const decision = decideClientResponseCompression(request, response);
      if (!decision) return response;
      const compressed = compressClientResponse(response, decision);
      logger.debug("[ClientGzip] Compressing client response", {
        path: new URL(request.url).pathname,
        status: response.status,
        streaming: decision.streaming,
      });
      return compressed;
    } catch (error) {
      logger.debug("[ClientGzip] Compression setup failed, sending identity", {
        error: error instanceof Error ? error.message : String(error),
      });
      return response;
    }
  };
}
