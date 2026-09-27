/**
 * edge 请求状态的 Redis 存储。
 *
 * 同一个 edge 请求的 decide / next / heartbeat / complete 可能落在不同的集群 worker 甚至不同的
 * 实例上，所有跨调用状态都在这里读写：
 * - cch:edge:req:{requestId}          请求状态（JSON，Date 带标记，超阈值压缩）
 * - cch:edge:lock:{requestId}         串行化同一请求的状态变更
 * - cch:edge:idem:{scope}             接口幂等缓存（重放时返回首个响应）
 * - cch:edge:deadlines                watchdog 截止时间 ZSET（score = 截止 epoch ms）
 */
import { randomBytes } from "node:crypto";
import {
  COMPRESS_MIN_BYTES,
  compressPayload,
  decompressPayload,
} from "@/lib/compression/payload-codec";
import { getRedisClient } from "@/lib/redis/client";
import type { ReactiveRectifierRetryState } from "../proxy/forwarder";
import type { EdgeSessionSnapshot } from "../proxy/session";
import type { AttemptFailure, ExecutionStep } from "./contract";
import type { EdgeBodyState } from "./step-builder";

export const EDGE_STATE_KEY_PREFIX = "cch:edge:req:";
export const EDGE_LOCK_KEY_PREFIX = "cch:edge:lock:";
export const EDGE_IDEMPOTENCY_KEY_PREFIX = "cch:edge:idem:";
export const EDGE_DEADLINES_KEY = "cch:edge:deadlines";
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

export interface EdgeAttemptRecord {
  stepId: string;
  kind: ExecutionStep["attemptKind"];
  providerId: number;
  endpointId: number | null;
  baseUrl: string;
  attemptNumber: number;
  totalProvidersAttempted: number;
  /** 本 attempt 所属供应商在本请求内的发起序号（hedge 链路的 sequence） */
  sequence: number;
  status: "inflight" | "failed" | "winner" | "loser";
  isStreaming: boolean;
}

/** 串行路径（及 hedge 单个供应商内部重试）的逐供应商状态，对应 sendInternal 循环变量 */
export interface EdgeProviderAttemptState {
  providerId: number;
  attemptCount: number;
  maxAttemptsPerProvider: number;
  currentEndpointIndex: number;
  endpointCandidates: Array<{ endpointId: number | null; baseUrl: string }>;
  timedOutEndpointKeys: string[];
  reactiveRectifierRetryState: ReactiveRectifierRetryState;
  applyProviderOverrides: boolean;
  isMcpRequest: boolean;
  shouldAccountCircuitBreaker: boolean;
}

export interface EdgePendingRectifierAudit {
  stepId: string;
  trigger: string;
  providerId: number;
  attemptNumber: number;
  retryAttemptNumber: number;
}

export interface EdgeLastFailure {
  providerId: number;
  failure: AttemptFailure;
}

export interface EdgeHedgeState {
  launchedProviderIds: number[];
  launchedProviderCount: number;
  noMoreProviders: boolean;
  maxInFlight: number;
  billLosers: boolean;
  initialProviderId: number;
}

export interface EdgeRequestState {
  v: 1;
  requestId: number;
  edgeToken: string;
  edgeId: string;
  phase: "executing" | "completing" | "settled";
  mode: "serial" | "hedge";
  createdAtMs: number;
  updatedAtMs: number;
  heartbeatIntervalMs: number;
  session: EdgeSessionSnapshot;
  body: EdgeBodyState;
  attempts: EdgeAttemptRecord[];
  totalProvidersAttempted: number;
  failedProviderIds: number[];
  providerAttempts: EdgeProviderAttemptState[];
  hedge: EdgeHedgeState | null;
  pendingRectifierAudits: EdgePendingRectifierAudit[];
  /** billing header 整流每步都会在远端重放，审计只记录首次命中 */
  billingHeaderAudited: boolean;
  lastFailure: EdgeLastFailure | null;
  concurrency: { sessionId: string | null; observedIdentity: string | null };
}

export class EdgeStateUnavailableError extends Error {
  constructor(message = "Edge state store unavailable") {
    super(message);
    this.name = "EdgeStateUnavailableError";
  }
}

export class EdgeStateLockTimeoutError extends Error {
  constructor(requestId: number) {
    super(`Timed out waiting for edge request lock ${requestId}`);
    this.name = "EdgeStateLockTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// 编解码：Date 在 JSON 往返中会丢失类型（Provider / Key / User 均含 Date 字段）
// ---------------------------------------------------------------------------

const DATE_TAG = "$edgeDate";

export function encodeEdgeJson(value: unknown): string {
  return JSON.stringify(value, function replacer(this: Record<string, unknown>, key, current) {
    const original = this[key];
    if (original instanceof Date) {
      return { [DATE_TAG]: Number.isNaN(original.getTime()) ? null : original.toISOString() };
    }
    return current;
  });
}

export function decodeEdgeJson<T>(text: string): T {
  return JSON.parse(text, (_key, value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, DATE_TAG)
    ) {
      const iso = (value as Record<string, unknown>)[DATE_TAG];
      return typeof iso === "string" ? new Date(iso) : new Date(Number.NaN);
    }
    return value;
  }) as T;
}

function requireRedis() {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") {
    throw new EdgeStateUnavailableError();
  }
  return redis;
}

export function isEdgeStateStoreAvailable(): boolean {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  return !!redis && redis.status === "ready";
}

export function generateEdgeToken(): string {
  return randomBytes(24).toString("hex");
}

export async function saveEdgeState(state: EdgeRequestState, ttlSeconds: number): Promise<void> {
  const redis = requireRedis();
  state.updatedAtMs = Date.now();
  const json = encodeEdgeJson(state);
  const stored =
    Buffer.byteLength(json, "utf8") >= COMPRESS_MIN_BYTES ? await compressPayload(json) : json;
  await redis.set(`${EDGE_STATE_KEY_PREFIX}${state.requestId}`, stored, "EX", ttlSeconds);
}

/** 刷新状态 TTL（长流期间由心跳续期，避免状态早于请求过期） */
export async function touchEdgeState(requestId: number, ttlSeconds: number): Promise<void> {
  const redis = requireRedis();
  await redis.expire(`${EDGE_STATE_KEY_PREFIX}${requestId}`, ttlSeconds);
}

export async function loadEdgeState(requestId: number): Promise<EdgeRequestState | null> {
  const redis = requireRedis();
  const stored = await redis.get(`${EDGE_STATE_KEY_PREFIX}${requestId}`);
  if (stored === null) return null;
  return decodeEdgeJson<EdgeRequestState>(await decompressPayload(stored));
}

/**
 * 串行化同一 edge 请求的状态变更（next / complete / heartbeat / watchdog 可能并发到达）。
 */
export async function withEdgeRequestLock<T>(requestId: number, fn: () => Promise<T>): Promise<T> {
  const redis = requireRedis();
  const lockKey = `${EDGE_LOCK_KEY_PREFIX}${requestId}`;
  const owner = generateEdgeToken();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while ((await redis.set(lockKey, owner, "PX", LOCK_TTL_MS, "NX")) !== "OK") {
    if (Date.now() >= deadline) throw new EdgeStateLockTimeoutError(requestId);
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
        1,
        lockKey,
        owner
      )
      .catch(() => undefined);
  }
}

export async function getIdempotentResponse<T>(scope: string): Promise<T | null> {
  const redis = requireRedis();
  const stored = await redis.get(`${EDGE_IDEMPOTENCY_KEY_PREFIX}${scope}`);
  return stored === null ? null : decodeEdgeJson<T>(stored);
}

export async function setIdempotentResponse(
  scope: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const redis = requireRedis();
  await redis.set(
    `${EDGE_IDEMPOTENCY_KEY_PREFIX}${scope}`,
    encodeEdgeJson(value),
    "EX",
    ttlSeconds
  );
}

export async function scheduleEdgeDeadline(requestId: number, deadlineAtMs: number): Promise<void> {
  const redis = requireRedis();
  await redis.zadd(EDGE_DEADLINES_KEY, deadlineAtMs, String(requestId));
}

export async function clearEdgeDeadline(requestId: number): Promise<void> {
  const redis = requireRedis();
  await redis.zrem(EDGE_DEADLINES_KEY, String(requestId));
}

export async function listDueEdgeDeadlines(nowMs: number, limit: number): Promise<number[]> {
  const redis = requireRedis();
  const members = await redis.zrangebyscore(EDGE_DEADLINES_KEY, 0, nowMs, "LIMIT", 0, limit);
  return members.map(Number).filter((id) => Number.isSafeInteger(id));
}
