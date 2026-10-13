import { beforeEach, describe, expect, test, vi } from "vitest";

const redis = vi.hoisted(() => ({ getRedisClient: vi.fn() }));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: redis.getRedisClient }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getUpstreamGzipStateKey,
  loadUpstreamGzipStates,
  saveUpstreamGzipObservation,
} from "@/lib/redis/upstream-gzip-state";

function createPipeline(execResult: unknown) {
  const pipeline = {
    hset: vi.fn(() => pipeline),
    expire: vi.fn(() => pipeline),
    hgetall: vi.fn(() => pipeline),
    exec: vi.fn(async () => execResult),
  };
  return pipeline;
}

describe("upstream-gzip-state", () => {
  beforeEach(() => {
    redis.getRedisClient.mockReset();
  });

  test("Redis 不可用时 save/load 安静降级", async () => {
    redis.getRedisClient.mockReturnValue(null);
    await expect(
      saveUpstreamGzipObservation(1, "request", { state: "supported", updatedAt: 1 })
    ).resolves.toBeUndefined();
    expect((await loadUpstreamGzipStates([1])).size).toBe(0);
  });

  test("save 写入 hash 字段并设置 TTL", async () => {
    const pipeline = createPipeline([]);
    redis.getRedisClient.mockReturnValue({ pipeline: () => pipeline });

    await saveUpstreamGzipObservation(3, "response", { state: "compressed", updatedAt: 5 });

    expect(pipeline.hset).toHaveBeenCalledWith(
      getUpstreamGzipStateKey(3),
      "response",
      JSON.stringify({ state: "compressed", updatedAt: 5 })
    );
    expect(pipeline.expire).toHaveBeenCalledWith("upstream_gzip:state:3", 86400);
  });

  test("save 失败时不抛出", async () => {
    const pipeline = createPipeline([]);
    pipeline.exec.mockRejectedValue(new Error("boom"));
    redis.getRedisClient.mockReturnValue({ pipeline: () => pipeline });
    await expect(
      saveUpstreamGzipObservation(3, "request", { state: "unsupported", updatedAt: 5 })
    ).resolves.toBeUndefined();
  });

  test("load 解析合法字段并丢弃脏数据", async () => {
    const pipeline = createPipeline([
      [
        null,
        {
          request: JSON.stringify({ state: "supported", updatedAt: 10 }),
          response: JSON.stringify({ state: "bogus", updatedAt: 10 }),
        },
      ],
      [null, { request: "not json" }],
      [new Error("x"), null],
      [null, { response: JSON.stringify({ state: "uncompressed", updatedAt: 3 }) }],
    ]);
    redis.getRedisClient.mockReturnValue({ pipeline: () => pipeline });

    const result = await loadUpstreamGzipStates([1, 2, 3, 4]);

    expect(pipeline.hgetall).toHaveBeenCalledTimes(4);
    expect(result.get(1)).toEqual({
      request: { state: "supported", updatedAt: 10 },
      response: undefined,
    });
    expect(result.has(2)).toBe(false);
    expect(result.has(3)).toBe(false);
    expect(result.get(4)?.response).toEqual({ state: "uncompressed", updatedAt: 3 });
  });

  test("load 失败时返回空结果", async () => {
    const pipeline = createPipeline([]);
    pipeline.exec.mockRejectedValue(new Error("down"));
    redis.getRedisClient.mockReturnValue({ pipeline: () => pipeline });
    expect((await loadUpstreamGzipStates([1])).size).toBe(0);
  });
});
