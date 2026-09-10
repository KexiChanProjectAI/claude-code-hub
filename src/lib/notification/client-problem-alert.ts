import { createHash } from "node:crypto";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis/client";
import type {
  ClientProblemAlertData,
  ClientProblemAlertSample,
  ClientProblemBucket,
  ClientProblemFlushJobData,
  ClientProblemKind,
} from "@/lib/webhook/types";
import { getNotificationSettings, type NotificationSettings } from "@/repository/notifications";
import type { ProviderChainItem } from "@/types/message";

export type { ClientProblemBucket, ClientProblemKind };
export type ClientProblemClass =
  | { bucket: "cyber"; kind: "cyber" }
  | { bucket: "general"; kind: "timeout" | "server" }
  | null;

const CYBER_KEYWORD_RES: readonly RegExp[] = [
  /\bcyber_policy\b/iu,
  /flagged\s+for\s+possible\s+cybersecurity\s+risk/iu,
  /trusted\s+access\s+for\s+cyber/iu,
  /cybersecurity\s+risk/iu,
];

const TIMEOUT_RE =
  /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|STREAM_IDLE_TIMEOUT|STREAM_RESPONSE_TIMEOUT|\btimeout\b/i;
const TIMEOUT_STATUS = new Set([408, 504, 524]);
const HAYSTACK_MAX_CHARS = 8 * 1024;
const SAMPLE_ERROR_MAX_CHARS = 200;
const SAMPLE_LIMIT = 10;
const TOP_GROUP_LIMIT = 8;
const SETTINGS_CACHE_TTL_MS = 15_000;
const REDIS_SKIP_LOG_INTERVAL_MS = 60_000;
const SENT_CONTENT_MIN_TTL_SECONDS = 60 * 60;
const KEY_PREFIX = "cch:client-problem";

const CLIENT_PROBLEM_INCR_LUA = `
local prefix = KEYS[1]
local nowMs = ARGV[1]
local sampleJson = ARGV[2]
local kind = ARGV[3]
local status = ARGV[4]
local userKey = ARGV[5]
local providerKey = ARGV[6]
local modelKey = ARGV[7]
local countThreshold = tonumber(ARGV[8])

local countKey = prefix .. ":count"
local count = redis.call("INCR", countKey)
if count == 1 then
  redis.call("SET", prefix .. ":firstAt", nowMs)
end
redis.call("HINCRBY", prefix .. ":kind", kind, 1)
redis.call("HINCRBY", prefix .. ":status", status, 1)
redis.call("HINCRBY", prefix .. ":user", userKey, 1)
redis.call("HINCRBY", prefix .. ":provider", providerKey, 1)
redis.call("HINCRBY", prefix .. ":model", modelKey, 1)
local fingerprint = ARGV[9]
local fpKey = prefix .. ":sampleFingerprints"
if fingerprint ~= "" then
  if redis.call("SISMEMBER", fpKey, fingerprint) == 0 and redis.call("LLEN", prefix .. ":samples") < 10 then
    redis.call("LPUSH", prefix .. ":samples", sampleJson)
    redis.call("SADD", fpKey, fingerprint)
  end
elseif redis.call("LLEN", prefix .. ":samples") < 10 then
  redis.call("LPUSH", prefix .. ":samples", sampleJson)
end
if count == countThreshold then
  return {count, 1}
end
if count == 1 then
  return {count, 2}
end
return {count, 0}
`;

const CLIENT_PROBLEM_INCR_SHA = createHash("sha1").update(CLIENT_PROBLEM_INCR_LUA).digest("hex");

const recordedSessions = new WeakSet<ProxySession>();

type SettingsCache = { value: NotificationSettings; expiresAt: number };
let settingsCache: SettingsCache | null = null;
let lastRedisSkipLogAt = 0;

type RedisLike = {
  eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  evalsha?: (sha: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    expiryMode: string,
    time: number,
    flag: string
  ) => Promise<string | null>;
  del: (...keys: string[]) => Promise<number>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  lrange: (key: string, start: number, stop: number) => Promise<string[]>;
  sismember: (key: string, member: string) => Promise<number>;
  sadd: (key: string, ...members: string[]) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
};

export type ClientProblemBucketSnapshot = {
  count: number;
  firstAtMs: number;
  kind: Record<string, number>;
  status: Record<string, number>;
  user: Record<string, number>;
  provider: Record<string, number>;
  model: Record<string, number>;
  samples: StoredClientProblemSample[];
};

type StoredClientProblemSample = ClientProblemAlertSample & { fingerprint: string };

export function buildClientProblemContentFingerprint(input: {
  kind: ClientProblemKind;
  statusCode: number;
  providerId: number | null;
  model: string;
  error: string;
}): string {
  return createHash("sha1")
    .update(
      `${input.kind}|${input.statusCode}|${input.providerId ?? "unknown"}|${orUnknown(input.model)}|${input.error}`,
      "utf8"
    )
    .digest("hex");
}

export function classifyClientProblem(input: {
  statusCode: number;
  isWarmup: boolean;
  errorText: string;
}): ClientProblemClass {
  if (input.isWarmup) return null;
  if (input.statusCode === 499) return null;
  if (matchCyberKeyword(input.errorText)) return { bucket: "cyber", kind: "cyber" };
  if (TIMEOUT_STATUS.has(input.statusCode) || TIMEOUT_RE.test(input.errorText)) {
    return { bucket: "general", kind: "timeout" };
  }
  if (input.statusCode >= 500 && input.statusCode <= 599) {
    return { bucket: "general", kind: "server" };
  }
  return null;
}

export function collectClientProblemHaystack(session: ProxySession): string {
  const getter = (session as { getProviderChain?: () => ProviderChainItem[] }).getProviderChain;
  const chain = typeof getter === "function" ? getter.call(session) : [];
  if (!Array.isArray(chain) || chain.length === 0) return "";

  const parts: string[] = [];
  const last = chain[chain.length - 1];
  if (last) collectItemErrorParts(last, parts);
  for (const item of chain) {
    pushHaystackPart(parts, item.reason);
  }
  for (let i = 0; i < chain.length - 1; i++) {
    collectItemErrorParts(chain[i], parts);
  }

  const joined = parts.join("\n");
  return joined.length > HAYSTACK_MAX_CHARS ? joined.slice(0, HAYSTACK_MAX_CHARS) : joined;
}

function collectItemErrorParts(item: ProviderChainItem, parts: string[]): void {
  pushHaystackPart(parts, item.errorMessage);
  pushHaystackPart(parts, item.errorDetails?.clientError);
  pushHaystackPart(parts, item.errorDetails?.matchedRule?.pattern);
  pushHaystackPart(parts, item.errorDetails?.matchedRule?.description);
  pushHaystackPart(parts, item.errorDetails?.system?.errorMessage);
  pushHaystackPart(parts, item.errorDetails?.system?.errorCode);
  const provider = item.errorDetails?.provider;
  if (!provider) return;
  pushHaystackPart(parts, provider.statusText);
  if (typeof provider.upstreamBody === "string") {
    pushHaystackPart(parts, provider.upstreamBody);
  }
  if (provider.upstreamParsed != null) {
    try {
      const json = JSON.stringify(provider.upstreamParsed);
      if (json && json !== "null") pushHaystackPart(parts, json);
    } catch {
      // Parsed body may contain circular refs; skip rather than drop the rest of the haystack.
    }
  }
}

function matchCyberKeyword(text: string): string | null {
  for (const re of CYBER_KEYWORD_RES) {
    const match = text.match(re);
    if (match?.[0]) return match[0];
  }
  return null;
}

function extractSampleError(errorText: string, kind: ClientProblemKind): string {
  if (kind === "cyber") {
    const keyword = matchCyberKeyword(errorText);
    if (keyword) return clipSampleError(keyword);
  }
  return clipSampleError(errorText);
}

function clipSampleError(text: string): string {
  return text.length > SAMPLE_ERROR_MAX_CHARS ? text.slice(0, SAMPLE_ERROR_MAX_CHARS) : text;
}

function pushHaystackPart(parts: string[], value: string | undefined): void {
  if (value && value.length > 0) parts.push(value);
}

export function emitClientProblemAlert(session: ProxySession, statusCode: number): void {
  if (recordedSessions.has(session)) return;
  recordedSessions.add(session);
  void recordClientProblemAlert(session, statusCode).catch((error) => {
    logger.warn({
      action: "client_problem_alert_record_error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function recordClientProblemAlert(
  session: ProxySession,
  statusCode: number
): Promise<void> {
  const errorText = collectClientProblemHaystack(session);
  const classified = classifyClientProblem({
    statusCode,
    isWarmup: typeof session.isWarmupRequest === "function" ? session.isWarmupRequest() : false,
    errorText,
  });
  if (!classified) return;

  const settings = await getCachedNotificationSettings();
  if (!settings.enabled || !settings.clientProblemEnabled) return;

  const redis = getRedisClient({ allowWhenRateLimitDisabled: true }) as RedisLike | null;
  if (!redis) {
    const now = Date.now();
    if (now - lastRedisSkipLogAt >= REDIS_SKIP_LOG_INTERVAL_MS) {
      lastRedisSkipLogAt = now;
      logger.warn({ action: "client_problem_alert_skipped", reason: "redis_unavailable" });
    }
    return;
  }

  const countThreshold =
    classified.bucket === "cyber"
      ? clampCount(settings.clientProblemCyberCountThreshold, 3)
      : clampCount(settings.clientProblemCountThreshold, 10);
  const windowMinutes =
    classified.bucket === "cyber"
      ? clampWindowMinutes(settings.clientProblemCyberWindowMinutes, 5)
      : clampWindowMinutes(settings.clientProblemWindowMinutes, 5);

  const user = session.messageContext?.user ?? session.authState?.user;
  const provider = session.provider;
  const model =
    (typeof session.getCurrentModel === "function" ? session.getCurrentModel() : null) ?? "unknown";
  const userKey = user ? `${user.id}:${user.name}` : "unknown";
  const providerKey = provider ? `${provider.id}:${provider.name}` : "unknown";
  const sampleError = extractSampleError(errorText, classified.kind);
  const fingerprint = buildClientProblemContentFingerprint({
    kind: classified.kind,
    statusCode,
    providerId: provider?.id ?? null,
    model,
    error: sampleError,
  });
  if (await isContentFingerprintSent(redis, classified.bucket, fingerprint)) {
    return;
  }

  const sample: StoredClientProblemSample = {
    at: new Date().toISOString(),
    userName: user?.name ?? "unknown",
    providerName: provider?.name ?? "unknown",
    model,
    statusCode,
    kind: classified.kind,
    error: sampleError,
    fingerprint,
  };

  const prefix = bucketPrefix(classified.bucket);
  const nowMs = Date.now();
  const luaResult = await evalIncr(redis, prefix, [
    String(nowMs),
    JSON.stringify(sample),
    classified.kind,
    String(statusCode || "unknown"),
    orUnknown(userKey),
    orUnknown(providerKey),
    orUnknown(model),
    countThreshold,
    fingerprint,
  ]);
  const code = luaResult[1];

  if (code === 1) {
    const snapshot = await loadAndClearBucket(redis, classified.bucket);
    const { removeClientProblemFlushJob } = await import("./notification-queue");
    await removeClientProblemFlushJob(classified.bucket);
    if (snapshot) {
      await sendClientProblemAlert(
        buildClientProblemAlertData(snapshot, {
          bucket: classified.bucket,
          windowMinutes,
          trigger: "count",
        })
      );
    }
    return;
  }

  if (code === 2) {
    const windowSeconds = windowMinutes * 60;
    const timerSet = await redis.set(`${prefix}:timer`, "1", "EX", windowSeconds, "NX");
    if (timerSet === "OK") {
      const { addClientProblemFlushJob } = await import("./notification-queue");
      await addClientProblemFlushJob(classified.bucket, windowMinutes * 60_000);
    }
  }
}

export async function sendClientProblemAlert(data: ClientProblemAlertData): Promise<void> {
  try {
    const settings = await getNotificationSettings();
    if (!settings.enabled || !settings.clientProblemEnabled) {
      return;
    }

    const redis = getRedisClient({ allowWhenRateLimitDisabled: true }) as RedisLike | null;
    const outbound = redis ? await dropAlreadySentContent(redis, data) : data;
    if (!outbound) {
      logger.info({
        action: "client_problem_alert_skipped",
        reason: "content_already_sent",
        bucket: data.bucket,
      });
      return;
    }

    // Dynamic import: notification-queue pulls Bull; keep it off the emit/metrics path.
    const { addNotificationJob, addNotificationJobForTarget } = await import(
      "./notification-queue"
    );

    if (settings.useLegacyMode) {
      const url = settings.clientProblemWebhook?.trim();
      if (!url) return;
      await addNotificationJob("client-problem", url, stripSampleFingerprints(outbound));
      if (redis) await markContentFingerprintsSent(redis, outbound);
      return;
    }

    const { getEnabledBindingsByType } = await import("@/repository/notification-bindings");
    const bindings = await getEnabledBindingsByType("client_problem");
    if (bindings.length === 0) return;
    for (const binding of bindings) {
      await addNotificationJobForTarget(
        "client-problem",
        binding.targetId,
        binding.id,
        stripSampleFingerprints(outbound)
      );
    }
    if (redis) await markContentFingerprintsSent(redis, outbound);
  } catch (error) {
    logger.error({
      action: "send_client_problem_alert_error",
      bucket: data.bucket,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleClientProblemFlush(bucket: ClientProblemBucket): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true }) as RedisLike | null;
  if (!redis) return;

  const snapshot = await loadAndClearBucket(redis, bucket);
  if (!snapshot || snapshot.count < 1) return;

  const settings = await getNotificationSettings();
  if (!settings.enabled || !settings.clientProblemEnabled) return;

  const windowMinutes =
    bucket === "cyber"
      ? clampWindowMinutes(settings.clientProblemCyberWindowMinutes, 5)
      : clampWindowMinutes(settings.clientProblemWindowMinutes, 5);

  await sendClientProblemAlert(
    buildClientProblemAlertData(snapshot, {
      bucket,
      windowMinutes,
      trigger: "window",
    })
  );
}

export async function loadAndClearBucket(
  redis: RedisLike,
  bucket: ClientProblemBucket
): Promise<ClientProblemBucketSnapshot | null> {
  const prefix = bucketPrefix(bucket);
  const countRaw = await redis.get(`${prefix}:count`);
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count < 1) {
    await redis.del(...bucketKeys(prefix));
    return null;
  }

  const [firstAtRaw, kind, status, user, provider, model, sampleRaw] = await Promise.all([
    redis.get(`${prefix}:firstAt`),
    redis.hgetall(`${prefix}:kind`),
    redis.hgetall(`${prefix}:status`),
    redis.hgetall(`${prefix}:user`),
    redis.hgetall(`${prefix}:provider`),
    redis.hgetall(`${prefix}:model`),
    redis.lrange(`${prefix}:samples`, 0, SAMPLE_LIMIT - 1),
  ]);

  await redis.del(...bucketKeys(prefix));

  return {
    count,
    firstAtMs: Number(firstAtRaw) || Date.now(),
    kind: toCountMap(kind),
    status: toCountMap(status),
    user: toCountMap(user),
    provider: toCountMap(provider),
    model: toCountMap(model),
    samples: (sampleRaw ?? [])
      .map(parseSample)
      .filter((sample): sample is StoredClientProblemSample => sample != null),
  };
}

export function buildClientProblemAlertData(
  snapshot: ClientProblemBucketSnapshot,
  input: {
    bucket: ClientProblemBucket;
    windowMinutes: number;
    trigger: "count" | "window";
  }
): ClientProblemAlertData {
  return {
    bucket: input.bucket,
    kindCounts: {
      timeout: snapshot.kind.timeout ?? 0,
      server: snapshot.kind.server ?? 0,
      cyber: snapshot.kind.cyber ?? 0,
    },
    totalCount: snapshot.count,
    windowStartedAt: new Date(snapshot.firstAtMs).toISOString(),
    windowMinutes: input.windowMinutes,
    trigger: input.trigger,
    byStatus: topCounts(snapshot.status),
    byUser: topCounts(snapshot.user),
    byProvider: topCounts(snapshot.provider),
    byModel: topCounts(snapshot.model),
    samples: snapshot.samples.slice(0, SAMPLE_LIMIT),
  };
}

export function isClientProblemFlushJobData(value: unknown): value is ClientProblemFlushJobData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.flush === true && (record.bucket === "general" || record.bucket === "cyber");
}

export function isClientProblemAlertData(value: unknown): value is ClientProblemAlertData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.bucket === "general" || record.bucket === "cyber") &&
    typeof record.totalCount === "number" &&
    (record.trigger === "count" || record.trigger === "window")
  );
}

export function resetClientProblemAlertForTests(): void {
  settingsCache = null;
  lastRedisSkipLogAt = 0;
}

function contentSentKey(bucket: ClientProblemBucket): string {
  return `${KEY_PREFIX}:${bucket}:sent-content`;
}

function sentContentTtlSeconds(windowMinutes: number): number {
  return Math.max(windowMinutes * 12 * 60, SENT_CONTENT_MIN_TTL_SECONDS);
}

function storedSamples(data: ClientProblemAlertData): StoredClientProblemSample[] {
  return data.samples.map((sample) => {
    const fingerprint = (sample as StoredClientProblemSample).fingerprint;
    if (typeof fingerprint === "string" && fingerprint.length > 0) {
      return { ...sample, fingerprint };
    }
    return {
      ...sample,
      fingerprint: buildClientProblemContentFingerprint({
        kind: sample.kind,
        statusCode: sample.statusCode,
        providerId: null,
        model: sample.model,
        error: sample.error,
      }),
    };
  });
}

function stripSampleFingerprints(data: ClientProblemAlertData): ClientProblemAlertData {
  return {
    ...data,
    samples: data.samples.map((sample) => {
      const { fingerprint: _fingerprint, ...rest } = sample as StoredClientProblemSample;
      return rest;
    }),
  };
}

async function isContentFingerprintSent(
  redis: RedisLike,
  bucket: ClientProblemBucket,
  fingerprint: string
): Promise<boolean> {
  try {
    return (await redis.sismember(contentSentKey(bucket), fingerprint)) === 1;
  } catch (error) {
    logger.warn({
      action: "client_problem_alert_sent_content_read_failed",
      bucket,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function dropAlreadySentContent(
  redis: RedisLike,
  data: ClientProblemAlertData
): Promise<ClientProblemAlertData | null> {
  const samples = storedSamples(data);
  if (samples.length === 0) return data;

  const remaining: StoredClientProblemSample[] = [];
  for (const sample of samples) {
    if (await isContentFingerprintSent(redis, data.bucket, sample.fingerprint)) continue;
    remaining.push(sample);
  }

  if (remaining.length === 0) return null;
  return { ...data, samples: remaining };
}

async function markContentFingerprintsSent(
  redis: RedisLike,
  data: ClientProblemAlertData
): Promise<void> {
  const fingerprints = [...new Set(storedSamples(data).map((sample) => sample.fingerprint))].filter(
    Boolean
  );
  if (fingerprints.length === 0) return;
  try {
    const key = contentSentKey(data.bucket);
    await redis.sadd(key, ...fingerprints);
    await redis.expire(key, sentContentTtlSeconds(data.windowMinutes));
  } catch (error) {
    logger.warn({
      action: "client_problem_alert_sent_content_write_failed",
      bucket: data.bucket,
      keysCount: fingerprints.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function bucketPrefix(bucket: ClientProblemBucket): string {
  return `${KEY_PREFIX}:${bucket}`;
}

function bucketKeys(prefix: string): string[] {
  return [
    `${prefix}:count`,
    `${prefix}:firstAt`,
    `${prefix}:kind`,
    `${prefix}:status`,
    `${prefix}:user`,
    `${prefix}:provider`,
    `${prefix}:model`,
    `${prefix}:samples`,
    `${prefix}:sampleFingerprints`,
    `${prefix}:timer`,
  ];
}

async function evalIncr(
  redis: RedisLike,
  prefix: string,
  args: Array<string | number>
): Promise<[number, number]> {
  let raw: unknown;
  if (redis.evalsha) {
    try {
      raw = await redis.evalsha(CLIENT_PROBLEM_INCR_SHA, 1, prefix, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/NOSCRIPT/i.test(message)) throw error;
      raw = await redis.eval(CLIENT_PROBLEM_INCR_LUA, 1, prefix, ...args);
    }
  } else {
    raw = await redis.eval(CLIENT_PROBLEM_INCR_LUA, 1, prefix, ...args);
  }

  const pair = Array.isArray(raw) ? raw : [0, 0];
  return [Number(pair[0]) || 0, Number(pair[1]) || 0];
}

async function getCachedNotificationSettings(): Promise<NotificationSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) {
    return settingsCache.value;
  }
  const value = await getNotificationSettings();
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

function clampCount(n: unknown, fallback: number): number {
  return Math.min(10000, Math.max(1, Math.trunc(Number(n)) || fallback));
}

function clampWindowMinutes(n: unknown, fallback: number): number {
  return Math.min(1440, Math.max(1, Math.trunc(Number(n)) || fallback));
}

function orUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "unknown";
}

function toCountMap(hash: Record<string, string> | null | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!hash) return result;
  for (const [key, raw] of Object.entries(hash)) {
    const count = Number(raw);
    result[key] = Number.isFinite(count) ? count : 0;
  }
  return result;
}

function topCounts(hash: Record<string, number>): Array<{ key: string; count: number }> {
  return Object.entries(hash)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, TOP_GROUP_LIMIT);
}

function parseSample(raw: string): StoredClientProblemSample | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredClientProblemSample> & {
      kind?: string;
      providerId?: number | null;
    };
    if (!parsed || typeof parsed !== "object") return null;
    const kind: ClientProblemKind =
      parsed.kind === "timeout" || parsed.kind === "server" || parsed.kind === "cyber"
        ? parsed.kind
        : "server";
    const statusCode = Number(parsed.statusCode) || 0;
    const model = typeof parsed.model === "string" ? parsed.model : "unknown";
    const error = typeof parsed.error === "string" ? parsed.error : "";
    const fingerprint =
      typeof parsed.fingerprint === "string" && parsed.fingerprint.length > 0
        ? parsed.fingerprint
        : buildClientProblemContentFingerprint({
            kind,
            statusCode,
            providerId: typeof parsed.providerId === "number" ? parsed.providerId : null,
            model,
            error,
          });
    return {
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
      userName: typeof parsed.userName === "string" ? parsed.userName : "unknown",
      providerName: typeof parsed.providerName === "string" ? parsed.providerName : "unknown",
      model,
      statusCode,
      kind,
      error,
      fingerprint,
    };
  } catch {
    return null;
  }
}
