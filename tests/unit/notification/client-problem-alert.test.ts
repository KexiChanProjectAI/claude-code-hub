import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import {
  classifyClientProblem,
  collectClientProblemHaystack,
} from "@/lib/notification/client-problem-alert";

const addNotificationJob = vi.fn(async () => {});
const addNotificationJobForTarget = vi.fn(async () => {});
const addClientProblemFlushJob = vi.fn(async () => {});
const removeClientProblemFlushJob = vi.fn(async () => {});
const getNotificationSettings = vi.fn();
const getEnabledBindingsByType = vi.fn(async () => []);

const CANONICAL_CYBER_MESSAGE =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cybersecurity program.";

function createRedisMock(store: Store) {
  const redis = {
    eval: vi.fn(
      async (_script: string, _n: number, prefix: string, ...args: Array<string | number>) => {
        return runIncrLua(store, prefix, args);
      }
    ),
    evalsha: vi.fn(
      async (_sha: string, _n: number, prefix: string, ...args: Array<string | number>) => {
        return runIncrLua(store, prefix, args);
      }
    ),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return typeof value === "string" || typeof value === "number" ? String(value) : null;
    }),
    set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    }),
    hgetall: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, string>) }
        : {};
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = (store.get(key) as string[] | undefined) ?? [];
      const end = stop < 0 ? list.length : stop + 1;
      return list.slice(start, end);
    }),
    sismember: vi.fn(async (key: string, member: string) => {
      const value = store.get(key);
      return value instanceof Set && value.has(member) ? 1 : 0;
    }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      const set = (store.get(key) as Set<string> | undefined) ?? new Set<string>();
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added += 1;
        }
      }
      store.set(key, set);
      return added;
    }),
    expire: vi.fn(async () => 1),
  };
  return redis;
}

function runIncrLua(store: Store, prefix: string, args: Array<string | number>): [number, number] {
  const [
    nowMs,
    sampleJson,
    kind,
    status,
    userKey,
    providerKey,
    modelKey,
    thresholdRaw,
    fingerprintRaw,
  ] = args;
  const countKey = `${prefix}:count`;
  const count = Number(store.get(countKey) ?? 0) + 1;
  store.set(countKey, String(count));
  if (count === 1) store.set(`${prefix}:firstAt`, String(nowMs));
  hincr(store, `${prefix}:kind`, String(kind));
  hincr(store, `${prefix}:status`, String(status));
  hincr(store, `${prefix}:user`, String(userKey));
  hincr(store, `${prefix}:provider`, String(providerKey));
  hincr(store, `${prefix}:model`, String(modelKey));
  const samples = (store.get(`${prefix}:samples`) as string[] | undefined) ?? [];
  const fingerprint = String(fingerprintRaw ?? "");
  const fpSet =
    (store.get(`${prefix}:sampleFingerprints`) as Set<string> | undefined) ?? new Set<string>();
  if (fingerprint) {
    if (!fpSet.has(fingerprint) && samples.length < 10) {
      samples.unshift(String(sampleJson));
      fpSet.add(fingerprint);
      store.set(`${prefix}:samples`, samples);
      store.set(`${prefix}:sampleFingerprints`, fpSet);
    }
  } else if (samples.length < 10) {
    samples.unshift(String(sampleJson));
    store.set(`${prefix}:samples`, samples);
  }
  const threshold = Number(thresholdRaw);
  if (count === threshold) return [count, 1];
  if (count === 1) return [count, 2];
  return [count, 0];
}

function hincr(store: Store, key: string, field: string): void {
  const hash = ((store.get(key) as Record<string, string> | undefined) ?? {}) as Record<
    string,
    string
  >;
  hash[field] = String(Number(hash[field] ?? 0) + 1);
  store.set(key, hash);
}

function createSession(overrides: Record<string, unknown> = {}): ProxySession {
  return {
    provider: { id: 5, name: "opus-pool" },
    messageContext: { user: { id: 12, name: "alice" } },
    authState: { user: { id: 12, name: "alice" } },
    getCurrentModel: () => "claude-sonnet-4",
    isWarmupRequest: () => false,
    getProviderChain: () => [],
    ...overrides,
  } as unknown as ProxySession;
}

const enabledSettings = {
  id: 1,
  enabled: true,
  useLegacyMode: true,
  titlePrefix: "PROXY",
  circuitBreakerEnabled: false,
  circuitBreakerWebhook: null,
  dailyLeaderboardEnabled: false,
  dailyLeaderboardWebhook: null,
  dailyLeaderboardTime: "09:00",
  dailyLeaderboardTopN: 5,
  costAlertEnabled: false,
  costAlertWebhook: null,
  costAlertThreshold: "0.80",
  costAlertCheckInterval: 60,
  cacheHitRateAlertEnabled: false,
  cacheHitRateAlertWebhook: null,
  cacheHitRateAlertWindowMode: "auto",
  cacheHitRateAlertCheckInterval: 5,
  cacheHitRateAlertHistoricalLookbackDays: 7,
  cacheHitRateAlertMinEligibleRequests: 20,
  cacheHitRateAlertMinEligibleTokens: 0,
  cacheHitRateAlertAbsMin: "0.05",
  cacheHitRateAlertDropRel: "0.3",
  cacheHitRateAlertDropAbs: "0.1",
  cacheHitRateAlertCooldownMinutes: 30,
  cacheHitRateAlertTopN: 10,
  clientProblemEnabled: true,
  clientProblemWebhook: "https://example.invalid/hook",
  clientProblemCountThreshold: 10,
  clientProblemWindowMinutes: 5,
  clientProblemCyberCountThreshold: 3,
  clientProblemCyberWindowMinutes: 5,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("classifyClientProblem", () => {
  it.each([
    [{ statusCode: 502, isWarmup: true, errorText: "boom" }, null],
    [{ statusCode: 499, isWarmup: false, errorText: "aborted" }, null],
    [{ statusCode: 200, isWarmup: false, errorText: "" }, null],
    [{ statusCode: 400, isWarmup: false, errorText: "invalid_request" }, null],
    [
      { statusCode: 400, isWarmup: false, errorText: "flagged for possible cybersecurity risk" },
      { bucket: "cyber", kind: "cyber" },
    ],
    [
      { statusCode: 400, isWarmup: false, errorText: CANONICAL_CYBER_MESSAGE },
      { bucket: "cyber", kind: "cyber" },
    ],
    [
      {
        statusCode: 400,
        isWarmup: false,
        errorText:
          "To get authorized for security work, join the Trusted Access for Cybersecurity program.",
      },
      { bucket: "cyber", kind: "cyber" },
    ],
    [
      { statusCode: 400, isWarmup: false, errorText: "possible cybersecurity risk detected" },
      { bucket: "cyber", kind: "cyber" },
    ],
    [
      { statusCode: 400, isWarmup: false, errorText: "命中规则 cyber_policy" },
      { bucket: "cyber", kind: "cyber" },
    ],
    [{ statusCode: 400, isWarmup: false, errorText: "This content was flagged by safety" }, null],
    [{ statusCode: 400, isWarmup: false, errorText: "内容被安全过滤器拦截" }, null],
    [
      { statusCode: 502, isWarmup: false, errorText: "" },
      { bucket: "general", kind: "server" },
    ],
    [
      { statusCode: 524, isWarmup: false, errorText: "" },
      { bucket: "general", kind: "timeout" },
    ],
    [
      { statusCode: 504, isWarmup: false, errorText: "" },
      { bucket: "general", kind: "timeout" },
    ],
    [
      { statusCode: 408, isWarmup: false, errorText: "" },
      { bucket: "general", kind: "timeout" },
    ],
    [
      { statusCode: 502, isWarmup: false, errorText: "STREAM_IDLE_TIMEOUT" },
      { bucket: "general", kind: "timeout" },
    ],
    [
      { statusCode: 502, isWarmup: false, errorText: "ETIMEDOUT" },
      { bucket: "general", kind: "timeout" },
    ],
    [{ statusCode: 429, isWarmup: false, errorText: "rate limited" }, null],
  ] as const)("%j -> %j", (input, expected) => {
    expect(classifyClientProblem(input)).toEqual(expected);
  });
});

describe("collectClientProblemHaystack", () => {
  it("returns empty string when getProviderChain is missing", () => {
    expect(collectClientProblemHaystack(createSession({ getProviderChain: undefined }))).toBe("");
  });

  it("joins last-item errors and all reasons", () => {
    const text = collectClientProblemHaystack(
      createSession({
        getProviderChain: () => [
          { reason: "timeout", errorMessage: "first" },
          {
            reason: "client_error_non_retryable",
            errorMessage: "flagged for possible cybersecurity risk",
            errorDetails: { matchedRule: { pattern: "cyber_policy" } },
          },
        ],
      })
    );
    expect(text).toContain("cyber_policy");
    expect(text).toContain("flagged for possible cybersecurity risk");
    expect(text).toContain("timeout");
  });

  it("includes upstreamParsed JSON so cyber_policy in structured bodies is visible", () => {
    const text = collectClientProblemHaystack(
      createSession({
        getProviderChain: () => [
          {
            reason: "client_error_non_retryable",
            errorMessage: "Provider foo returned 400: invalid_request_error",
            errorDetails: {
              provider: {
                statusText: "Bad Request",
                upstreamParsed: {
                  type: "error",
                  error: {
                    code: "cyber_policy",
                    message: CANONICAL_CYBER_MESSAGE,
                  },
                },
              },
            },
          },
        ],
      })
    );
    expect(text).toContain("cyber_policy");
    expect(text).toContain("Trusted Access for Cybersecurity");
  });
});

describe("client problem redis accumulator", () => {
  const store: Store = new Map();
  const redis = createRedisMock(store);

  beforeEach(() => {
    store.clear();
    addNotificationJob.mockClear();
    addNotificationJobForTarget.mockClear();
    addClientProblemFlushJob.mockClear();
    removeClientProblemFlushJob.mockClear();
    getNotificationSettings.mockReset();
    getEnabledBindingsByType.mockReset();
    getNotificationSettings.mockResolvedValue(enabledSettings);
    getEnabledBindingsByType.mockResolvedValue([]);
    vi.resetModules();
    vi.doMock("@/lib/redis/client", () => ({
      getRedisClient: () => redis,
    }));
    vi.doMock("@/repository/notifications", () => ({
      getNotificationSettings,
    }));
    vi.doMock("@/repository/notification-bindings", () => ({
      getEnabledBindingsByType,
    }));
    vi.doMock("@/lib/notification/notification-queue", () => ({
      addNotificationJob,
      addNotificationJobForTarget,
      addClientProblemFlushJob,
      removeClientProblemFlushJob,
    }));
    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/redis/client");
    vi.doUnmock("@/repository/notifications");
    vi.doUnmock("@/repository/notification-bindings");
    vi.doUnmock("@/lib/notification/notification-queue");
    vi.doUnmock("@/lib/logger");
  });

  it("flushes on the third general error when threshold is 3", async () => {
    getNotificationSettings.mockResolvedValue({
      ...enabledSettings,
      clientProblemCountThreshold: 3,
    });
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).not.toHaveBeenCalled();
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).toHaveBeenCalledTimes(1);
    const payload = addNotificationJob.mock.calls[0][2] as {
      totalCount: number;
      trigger: string;
      kindCounts: { server: number };
    };
    expect(payload.totalCount).toBe(3);
    expect(payload.trigger).toBe("count");
    expect(payload.kindCounts.server).toBeGreaterThanOrEqual(1);
    expect(removeClientProblemFlushJob).toHaveBeenCalledWith("general");
  });

  it("schedules a delayed job on the first event below threshold", async () => {
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 502);
    expect(addClientProblemFlushJob).toHaveBeenCalledWith("general", 5 * 60_000);
    expect(addNotificationJob).not.toHaveBeenCalled();
  });

  it("sends a window digest from delayed flush", async () => {
    getNotificationSettings.mockResolvedValue({
      ...enabledSettings,
      clientProblemCountThreshold: 10,
    });
    const { recordClientProblemAlert, handleClientProblemFlush, resetClientProblemAlertForTests } =
      await import("@/lib/notification/client-problem-alert");
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).not.toHaveBeenCalled();
    await handleClientProblemFlush("general");
    expect(addNotificationJob).toHaveBeenCalledTimes(1);
    const payload = addNotificationJob.mock.calls[0][2] as { trigger: string; totalCount: number };
    expect(payload.trigger).toBe("window");
    expect(payload.totalCount).toBe(2);
  });

  it("never increments redis for 499", async () => {
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 499);
    expect(redis.evalsha).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("records cyber 400 into the cyber bucket", async () => {
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(
      createSession({
        getProviderChain: () => [
          {
            errorMessage: "flagged for possible cybersecurity risk",
            reason: "client_error_non_retryable",
          },
        ],
      }),
      400
    );
    expect(store.get("cch:client-problem:cyber:count")).toBe("1");
    expect(addClientProblemFlushJob).toHaveBeenCalledWith("cyber", 5 * 60_000);
  });

  it("stores the matched cyber keyword instead of the full boilerplate", async () => {
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(
      createSession({
        getProviderChain: () => [
          {
            errorMessage: CANONICAL_CYBER_MESSAGE,
            reason: "client_error_non_retryable",
          },
        ],
      }),
      400
    );
    const samples = store.get("cch:client-problem:cyber:samples") as string[];
    expect(samples).toHaveLength(1);
    const sample = JSON.parse(samples[0] as string) as { error: string; kind: string };
    expect(sample.kind).toBe("cyber");
    expect(sample.error).toBe("flagged for possible cybersecurity risk");
    expect(sample.error).not.toContain("Trusted Access");
  });

  it("keeps one unique sample while still counting duplicate content", async () => {
    getNotificationSettings.mockResolvedValue({
      ...enabledSettings,
      clientProblemCountThreshold: 5,
    });
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).not.toHaveBeenCalled();
    const samples = store.get("cch:client-problem:general:samples") as string[];
    expect(samples).toHaveLength(1);
    expect(store.get("cch:client-problem:general:count")).toBe("3");
  });

  it("does not resend the same content after a successful flush", async () => {
    getNotificationSettings.mockResolvedValue({
      ...enabledSettings,
      clientProblemCountThreshold: 3,
    });
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).toHaveBeenCalledTimes(1);
    const firstPayload = addNotificationJob.mock.calls[0][2] as {
      samples: Array<{ fingerprint?: string }>;
    };
    expect(firstPayload.samples.every((sample) => sample.fingerprint == null)).toBe(true);

    addNotificationJob.mockClear();
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).not.toHaveBeenCalled();
    expect(store.get("cch:client-problem:general:count")).toBeUndefined();
  });

  it("still sends a later window when the error content is new", async () => {
    getNotificationSettings.mockResolvedValue({
      ...enabledSettings,
      clientProblemCountThreshold: 2,
    });
    const { recordClientProblemAlert, resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    await recordClientProblemAlert(createSession(), 502);
    await recordClientProblemAlert(createSession(), 502);
    expect(addNotificationJob).toHaveBeenCalledTimes(1);

    addNotificationJob.mockClear();
    await recordClientProblemAlert(createSession(), 504);
    await recordClientProblemAlert(createSession(), 504);
    expect(addNotificationJob).toHaveBeenCalledTimes(1);
    const payload = addNotificationJob.mock.calls[0][2] as {
      samples: Array<{ statusCode: number; error: string }>;
    };
    expect(payload.samples).toHaveLength(1);
    expect(payload.samples[0]?.statusCode).toBe(504);
  });
});

describe("emitProxyMetrics still records when metrics are disabled", () => {
  const store: Store = new Map();
  const redis = createRedisMock(store);

  beforeEach(() => {
    store.clear();
    getNotificationSettings.mockReset();
    getNotificationSettings.mockResolvedValue(enabledSettings);
    vi.resetModules();
    vi.doMock("@/lib/redis/client", () => ({
      getRedisClient: () => redis,
    }));
    vi.doMock("@/repository/notifications", () => ({
      getNotificationSettings,
    }));
    vi.doMock("@/repository/notification-bindings", () => ({
      getEnabledBindingsByType,
    }));
    vi.doMock("@/lib/notification/notification-queue", () => ({
      addNotificationJob,
      addNotificationJobForTarget,
      addClientProblemFlushJob,
      removeClientProblemFlushJob,
    }));
    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock("@/lib/metrics/metrics", () => ({
      getCchMetrics: () => ({ record: vi.fn() }),
      resetCchMetricsForTests: vi.fn(),
    }));
  });

  afterEach(() => {
    delete process.env.METRICS_ENABLED;
    vi.doUnmock("@/lib/redis/client");
    vi.doUnmock("@/repository/notifications");
    vi.doUnmock("@/lib/notification/notification-queue");
  });

  it("increments redis even when METRICS_ENABLED=false", async () => {
    process.env.METRICS_ENABLED = "false";
    const { resetClientProblemAlertForTests } = await import(
      "@/lib/notification/client-problem-alert"
    );
    resetClientProblemAlertForTests();
    const { emitProxyMetrics } = await import("@/lib/metrics/emit");
    emitProxyMetrics(createSession(), { statusCode: 502, durationMs: 10 });
    await vi.waitFor(() => {
      expect(store.get("cch:client-problem:general:count")).toBe("1");
    });
  });
});
