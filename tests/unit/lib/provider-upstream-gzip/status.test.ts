import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UpstreamGzipRecord } from "@/types/upstream-gzip";

const mocks = vi.hoisted(() => ({
  env: { ENABLE_UPSTREAM_REQUEST_GZIP: true, ENABLE_UPSTREAM_RESPONSE_GZIP: true },
  stored: new Map<number, UpstreamGzipRecord>(),
  memory: new Map<number, UpstreamGzipRecord>(),
}));

vi.mock("@/lib/config/env.schema", () => ({ getEnvConfig: () => mocks.env }));
vi.mock("@/lib/redis/upstream-gzip-state", () => ({
  loadUpstreamGzipStates: async () => mocks.stored,
}));
vi.mock("@/app/v1/_lib/proxy/upstream-compression", () => ({
  getUpstreamGzipMemorySnapshot: () => mocks.memory,
}));

import { buildProviderUpstreamGzipStatusMap } from "@/lib/provider-upstream-gzip/status";

describe("buildProviderUpstreamGzipStatusMap", () => {
  beforeEach(() => {
    mocks.env.ENABLE_UPSTREAM_REQUEST_GZIP = true;
    mocks.env.ENABLE_UPSTREAM_RESPONSE_GZIP = true;
    mocks.stored.clear();
    mocks.memory.clear();
  });

  test("无观测时报告 unknown", async () => {
    expect(await buildProviderUpstreamGzipStatusMap([1])).toEqual({
      1: {
        request: { state: "unknown", updatedAt: null },
        response: { state: "unknown", updatedAt: null },
      },
    });
  });

  test("合并 Redis 与内存，同方向取较新的观测", async () => {
    mocks.stored.set(1, {
      request: { state: "supported", updatedAt: 10 },
      response: { state: "compressed", updatedAt: 50 },
    });
    mocks.memory.set(1, {
      request: { state: "unsupported", updatedAt: 20 },
      response: { state: "uncompressed", updatedAt: 5 },
    });
    mocks.memory.set(2, { response: { state: "uncompressed", updatedAt: 1 } });

    const result = await buildProviderUpstreamGzipStatusMap([1, 2]);

    expect(result[1]).toEqual({
      request: { state: "unsupported", updatedAt: 20 },
      response: { state: "compressed", updatedAt: 50 },
    });
    expect(result[2]).toEqual({
      request: { state: "unknown", updatedAt: null },
      response: { state: "uncompressed", updatedAt: 1 },
    });
  });

  test("关闭开关时报告 disabled", async () => {
    mocks.env.ENABLE_UPSTREAM_REQUEST_GZIP = false;
    mocks.env.ENABLE_UPSTREAM_RESPONSE_GZIP = false;
    mocks.stored.set(1, { request: { state: "supported", updatedAt: 10 } });

    expect((await buildProviderUpstreamGzipStatusMap([1]))[1]).toEqual({
      request: { state: "disabled", updatedAt: null },
      response: { state: "disabled", updatedAt: null },
    });
  });
});
