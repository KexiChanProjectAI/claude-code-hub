import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const env = vi.hoisted(() => ({
  ENABLE_UPSTREAM_REQUEST_GZIP: true,
  UPSTREAM_REQUEST_GZIP_MIN_BYTES: 1024,
  ENABLE_UPSTREAM_RESPONSE_GZIP: true,
}));

const redis = vi.hoisted(() => ({ save: vi.fn(async () => undefined) }));

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => env,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redis/upstream-gzip-state", () => ({
  saveUpstreamGzipObservation: redis.save,
}));

import {
  applyUpstreamAcceptEncoding,
  buildUpstreamGzipTarget,
  clearUpstreamGzipSupportCache,
  getUpstreamGzipMemorySnapshot,
  getUpstreamGzipSupport,
  gzipUpstreamRequestBody,
  markUpstreamGzipSupport,
  observeUpstreamResponseEncoding,
  shouldGzipUpstreamRequestBody,
  shouldRetryWithoutGzip,
} from "@/app/v1/_lib/proxy/upstream-compression";

const KEY = buildUpstreamGzipTarget(1, "https://api.example.com/v1/messages?x=1");
const BIG = "a".repeat(2048);

function check(overrides: Partial<Parameters<typeof shouldGzipUpstreamRequestBody>[0]> = {}) {
  return shouldGzipUpstreamRequestBody({
    body: BIG,
    target: KEY,
    hasContentEncoding: false,
    bypassForwarderPreprocessing: false,
    ...overrides,
  });
}

describe("upstream-compression", () => {
  beforeEach(() => {
    clearUpstreamGzipSupportCache();
    redis.save.mockClear();
    env.ENABLE_UPSTREAM_REQUEST_GZIP = true;
    env.ENABLE_UPSTREAM_RESPONSE_GZIP = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("缓存键按 provider + origin 归并", () => {
    expect(KEY).toEqual({ providerId: 1, key: "1:https://api.example.com" });
    expect(buildUpstreamGzipTarget(2, "not a url").key).toBe("2:not a url");
  });

  test("shouldGzipUpstreamRequestBody 的各项前置条件", () => {
    expect(check()).toBe(true);
    expect(check({ body: "small" })).toBe(false);
    expect(check({ body: new Uint8Array(4096) })).toBe(false);
    expect(check({ hasContentEncoding: true })).toBe(false);
    expect(check({ bypassForwarderPreprocessing: true })).toBe(false);

    env.ENABLE_UPSTREAM_REQUEST_GZIP = false;
    expect(check()).toBe(false);
  });

  test("unsupported 期间不压缩，TTL 过期后重新探测", () => {
    vi.useFakeTimers();
    markUpstreamGzipSupport(KEY, "unsupported");
    expect(check()).toBe(false);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(getUpstreamGzipSupport(KEY)).toBe("unknown");
    expect(check()).toBe(true);
  });

  test("shouldRetryWithoutGzip 仅对回退状态码且未确认支持时生效", () => {
    expect(shouldRetryWithoutGzip(400, KEY)).toBe(true);
    expect(shouldRetryWithoutGzip(415, KEY)).toBe(true);
    expect(shouldRetryWithoutGzip(401, KEY)).toBe(false);
    expect(shouldRetryWithoutGzip(429, KEY)).toBe(false);

    markUpstreamGzipSupport(KEY, "supported");
    expect(shouldRetryWithoutGzip(400, KEY)).toBe(false);
  });

  test("状态变化时才持久化，重复标记只续期", () => {
    markUpstreamGzipSupport(KEY, "supported");
    markUpstreamGzipSupport(KEY, "supported");
    expect(redis.save).toHaveBeenCalledTimes(1);
    expect(redis.save).toHaveBeenCalledWith(1, "request", {
      state: "supported",
      updatedAt: expect.any(Number),
    });

    markUpstreamGzipSupport(KEY, "unsupported");
    expect(redis.save).toHaveBeenCalledTimes(2);
  });

  test("响应压缩观测：compressed 具有粘性", () => {
    observeUpstreamResponseEncoding(KEY, false);
    expect(getUpstreamGzipMemorySnapshot().get(1)?.response?.state).toBe("uncompressed");

    observeUpstreamResponseEncoding(KEY, true);
    observeUpstreamResponseEncoding(KEY, false);
    expect(getUpstreamGzipMemorySnapshot().get(1)?.response?.state).toBe("compressed");
    expect(redis.save).toHaveBeenCalledTimes(2);
  });

  test("内存快照按 provider 汇总，同方向取最近一次变化", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    markUpstreamGzipSupport(buildUpstreamGzipTarget(7, "https://a.example.com"), "supported");
    vi.setSystemTime(2_000);
    markUpstreamGzipSupport(buildUpstreamGzipTarget(7, "https://b.example.com"), "unsupported");

    const snapshot = getUpstreamGzipMemorySnapshot();
    expect(snapshot.get(7)).toEqual({ request: { state: "unsupported", updatedAt: 2_000 } });
  });

  test("gzipUpstreamRequestBody 可被还原", async () => {
    const compressed = await gzipUpstreamRequestBody(BIG);
    expect(compressed.byteLength).toBeLessThan(BIG.length);
    expect(gunzipSync(compressed).toString("utf8")).toBe(BIG);
  });

  test("applyUpstreamAcceptEncoding 只升级默认的 identity", () => {
    const headers = new Headers({ "accept-encoding": "identity" });
    expect(applyUpstreamAcceptEncoding(headers)).toBe(true);
    expect(headers.get("accept-encoding")).toBe("gzip");

    const custom = new Headers({ "accept-encoding": "br" });
    expect(applyUpstreamAcceptEncoding(custom)).toBe(false);
    expect(custom.get("accept-encoding")).toBe("br");

    env.ENABLE_UPSTREAM_RESPONSE_GZIP = false;
    const disabled = new Headers({ "accept-encoding": "identity" });
    expect(applyUpstreamAcceptEncoding(disabled)).toBe(false);
    expect(disabled.get("accept-encoding")).toBe("identity");
  });
});
