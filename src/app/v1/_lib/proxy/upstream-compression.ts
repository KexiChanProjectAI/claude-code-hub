/**
 * 出站（代理 -> 上游）gzip 支持。
 *
 * 1. 请求体压缩：序列化后的 JSON 请求体超过阈值时用 gzip 压缩，并带 `content-encoding: gzip`。
 *    并非所有上游都能解压请求体，因此需要自动回退：
 *    - 压缩请求返回 FALLBACK_STATUSES 中的状态码，且该上游尚未被确认支持 gzip 时，
 *      在同一上游上用明文立即重发一次（不计入重试次数/熔断）。
 *    - 明文重发成功 -> 记为 "unsupported"，TTL 内对该上游直接发明文；
 *    - 压缩请求成功 -> 记为 "supported"，之后该上游的同类错误不再触发明文重发
 *      （避免把真实的 400 业务错误翻倍成两次往返）。
 *    回退决策只依赖进程内状态，各 worker 独立学习；重启后最多再多一次往返即可重新学到。
 *    状态变化时额外写入 Redis，仅供供应商页面展示。
 *
 * 2. 响应压缩：所有请求（含流式 SSE）发送 `accept-encoding: gzip`，由 fetchWithoutAutoDecode
 *    的容错 Gunzip（Z_SYNC_FLUSH，收到即转发）解压后再交给下游。上游是否压缩、
 *    是否逐事件 flush 由上游自行决定。成功响应是否真的被压缩同样记录下来供页面展示。
 */
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { saveUpstreamGzipObservation } from "@/lib/redis/upstream-gzip-state";
import type { UpstreamGzipRecord } from "@/types/upstream-gzip";

const gzipAsync = promisify(gzip);

/** 压缩请求被这些状态拒绝时，视为上游可能不支持压缩请求体，回退明文重发一次。 */
const FALLBACK_STATUSES: ReadonlySet<number> = new Set([400, 415, 422, 500]);

const SUPPORTED_TTL_MS = 24 * 60 * 60 * 1000;
const UNSUPPORTED_TTL_MS = 60 * 60 * 1000;
const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2048;

export type UpstreamGzipSupport = "supported" | "unsupported" | "unknown";
type RequestState = Exclude<UpstreamGzipSupport, "unknown">;
type ResponseState = "compressed" | "uncompressed";

/** 能力缓存目标：provider + 上游 origin（解压能力是服务器级属性，与具体路径无关）。 */
export interface UpstreamGzipTarget {
  providerId: number;
  key: string;
}

type Entry<TState> = {
  providerId: number;
  state: TState;
  updatedAt: number;
  expiresAt: number;
};

const requestCache = new Map<string, Entry<RequestState>>();
const responseCache = new Map<string, Entry<ResponseState>>();

export function buildUpstreamGzipTarget(
  providerId: number,
  upstreamUrl: string
): UpstreamGzipTarget {
  let origin: string;
  try {
    origin = new URL(upstreamUrl).origin;
  } catch {
    origin = upstreamUrl;
  }
  return { providerId, key: `${providerId}:${origin}` };
}

function readEntry<TState>(cache: Map<string, Entry<TState>>, key: string): Entry<TState> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry;
}

/** 写入并返回状态是否发生变化（变化时才需要持久化）。 */
function writeEntry<TState>(
  cache: Map<string, Entry<TState>>,
  target: UpstreamGzipTarget,
  state: TState,
  ttlMs: number
): { changed: boolean; updatedAt: number } {
  const now = Date.now();
  const previous = readEntry(cache, target.key);
  const changed = previous?.state !== state;
  const updatedAt = changed || !previous ? now : previous.updatedAt;
  // 先删再插，使 Map 迭代顺序近似 LRU；超出上限时淘汰最早写入的键
  cache.delete(target.key);
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(target.key, {
    providerId: target.providerId,
    state,
    updatedAt,
    expiresAt: now + ttlMs,
  });
  return { changed, updatedAt };
}

function persist<D extends keyof UpstreamGzipRecord>(
  providerId: number,
  direction: D,
  observation: NonNullable<UpstreamGzipRecord[D]>
): void {
  void saveUpstreamGzipObservation(providerId, direction, observation).catch((error) =>
    logger.debug("[UpstreamGzip] Failed to persist observation", {
      providerId,
      direction,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

export function getUpstreamGzipSupport(target: UpstreamGzipTarget): UpstreamGzipSupport {
  return readEntry(requestCache, target.key)?.state ?? "unknown";
}

export function markUpstreamGzipSupport(target: UpstreamGzipTarget, state: RequestState): void {
  const { changed, updatedAt } = writeEntry(
    requestCache,
    target,
    state,
    state === "supported" ? SUPPORTED_TTL_MS : UNSUPPORTED_TTL_MS
  );
  if (changed) persist(target.providerId, "request", { state, updatedAt });
}

/**
 * 记录声明了 accept-encoding: gzip 的成功响应是否真的被压缩。
 * "compressed" 具有粘性：小响应即使支持 gzip 也常以明文返回，不应覆盖已观测到的压缩能力。
 */
export function observeUpstreamResponseEncoding(
  target: UpstreamGzipTarget,
  compressed: boolean
): void {
  const previous = readEntry(responseCache, target.key);
  if (!compressed && previous?.state === "compressed") return;
  const state: ResponseState = compressed ? "compressed" : "uncompressed";
  const { changed, updatedAt } = writeEntry(responseCache, target, state, RESPONSE_TTL_MS);
  if (changed) persist(target.providerId, "response", { state, updatedAt });
}

/** 按 provider 汇总本进程的观测（同一 provider 多个 origin 时取最近一次变化）。 */
export function getUpstreamGzipMemorySnapshot(): Map<number, UpstreamGzipRecord> {
  const snapshot = new Map<number, UpstreamGzipRecord>();
  const collect = <D extends keyof UpstreamGzipRecord>(
    cache: Map<string, Entry<RequestState | ResponseState>>,
    direction: D
  ) => {
    for (const key of Array.from(cache.keys())) {
      const entry = readEntry(cache, key);
      if (!entry) continue;
      const record = snapshot.get(entry.providerId) ?? {};
      const current = record[direction];
      if (!current || current.updatedAt < entry.updatedAt) {
        record[direction] = {
          state: entry.state,
          updatedAt: entry.updatedAt,
        } as UpstreamGzipRecord[D];
      }
      snapshot.set(entry.providerId, record);
    }
  };
  collect(requestCache, "request");
  collect(responseCache, "response");
  return snapshot;
}

export function clearUpstreamGzipSupportCache(): void {
  requestCache.clear();
  responseCache.clear();
}

/**
 * 判断本次请求体是否应 gzip 压缩。只处理代理自己序列化出的字符串请求体：
 * raw passthrough（Buffer）与 multipart 保持原样。
 */
export function shouldGzipUpstreamRequestBody(params: {
  body: unknown;
  target: UpstreamGzipTarget;
  hasContentEncoding: boolean;
  bypassForwarderPreprocessing: boolean;
}): boolean {
  const env = getEnvConfig();
  if (!env.ENABLE_UPSTREAM_REQUEST_GZIP) return false;
  if (params.bypassForwarderPreprocessing || params.hasContentEncoding) return false;
  if (typeof params.body !== "string") return false;
  if (Buffer.byteLength(params.body) < env.UPSTREAM_REQUEST_GZIP_MIN_BYTES) return false;
  return getUpstreamGzipSupport(params.target) !== "unsupported";
}

export async function gzipUpstreamRequestBody(body: string): Promise<Uint8Array<ArrayBuffer>> {
  // 异步 API 在 libuv 线程池执行，不阻塞事件循环
  const compressed = await gzipAsync(body);
  // 拷贝到独立 ArrayBuffer：满足 BodyInit 类型，且不引用 Buffer 池的共享内存
  return new Uint8Array(compressed);
}

/** 压缩请求失败时，是否需要用明文在同一上游重发一次。 */
export function shouldRetryWithoutGzip(status: number, target: UpstreamGzipTarget): boolean {
  return FALLBACK_STATUSES.has(status) && getUpstreamGzipSupport(target) !== "supported";
}

/**
 * 把默认的 `accept-encoding: identity` 升级为 gzip。
 * 只改写代理自己写入的默认值；provider 自定义头或过滤器显式设置的值保持不变。
 * 返回最终是否向上游声明了 gzip。
 */
export function applyUpstreamAcceptEncoding(headers: Headers): boolean {
  if (getEnvConfig().ENABLE_UPSTREAM_RESPONSE_GZIP) {
    if (headers.get("accept-encoding") === "identity") headers.set("accept-encoding", "gzip");
  }
  return /\bgzip\b/i.test(headers.get("accept-encoding") ?? "");
}
