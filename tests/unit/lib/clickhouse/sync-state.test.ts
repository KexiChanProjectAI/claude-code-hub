import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";

const queryJsonMock = vi.fn();
const getMaxIdMock = vi.fn();
const findCursorBeforeMock = vi.fn();
const isEnabledMock = vi.fn();
const getConfigMock = vi.fn();
const redisGetMock = vi.fn();
const redisSetMock = vi.fn();
const getRedisClientMock = vi.fn();

vi.mock("@/lib/clickhouse/client", () => ({
  queryJson: (...args: unknown[]) => queryJsonMock(...args),
}));

vi.mock("@/lib/clickhouse/source", () => ({
  getMaxId: (...args: unknown[]) => getMaxIdMock(...args),
  findCursorBefore: (...args: unknown[]) => findCursorBeforeMock(...args),
}));

vi.mock("@/lib/clickhouse/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clickhouse/config")>();
  return {
    ...actual,
    isClickHouseSyncEnabled: (...args: unknown[]) => isEnabledMock(...args),
    getClickHouseConfig: (...args: unknown[]) => getConfigMock(...args),
  };
});

vi.mock("@/lib/redis", () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  getClickHouseSyncFence,
  readState,
  resolveInitialState,
  SyncStateUnavailableError,
  writeState,
} from "@/lib/clickhouse/sync-state";

const config: ClickHouseConfig = {
  url: "http://clickhouse:8123",
  user: "default",
  password: "",
  database: "logs",
  table: "cch_request_log",
  requestTimeoutMs: 5000,
  syncIntervalMs: 5000,
  syncBatchSize: 100,
  syncLagMs: 300000,
  syncSettleMs: 150000,
  maxPendingAgeMs: 3600000,
  maxPending: 20000,
};

beforeEach(() => {
  redisGetMock.mockResolvedValue(null);
  redisSetMock.mockResolvedValue("OK");
  getRedisClientMock.mockReturnValue({
    status: "ready",
    get: redisGetMock,
    set: redisSetMock,
  });
  isEnabledMock.mockReturnValue(true);
  getConfigMock.mockReturnValue(config);
  queryJsonMock.mockResolvedValue([]);
  getMaxIdMock.mockResolvedValue(0);
  findCursorBeforeMock.mockResolvedValue(0);
});

describe("readState", () => {
  it("returns null when no state has been stored", async () => {
    await expect(readState()).resolves.toBeNull();
  });

  it("parses a stored state", async () => {
    redisGetMock.mockResolvedValue(JSON.stringify({ cursor: 42, pending: [43, 44] }));
    await expect(readState()).resolves.toEqual({ cursor: 42, pending: [43, 44] });
  });

  it("discards malformed JSON", async () => {
    redisGetMock.mockResolvedValue("{not json");
    await expect(readState()).resolves.toBeNull();
  });

  it("discards structurally invalid state", async () => {
    redisGetMock.mockResolvedValue(JSON.stringify({ cursor: "x", pending: [] }));
    await expect(readState()).resolves.toBeNull();

    redisGetMock.mockResolvedValue(JSON.stringify({ cursor: 1, pending: ["a"] }));
    await expect(readState()).resolves.toBeNull();
  });

  it("fails loudly when Redis is not ready", async () => {
    getRedisClientMock.mockReturnValue({ status: "connecting" });
    await expect(readState()).rejects.toBeInstanceOf(SyncStateUnavailableError);
  });

  it("fails loudly when Redis is unavailable entirely", async () => {
    getRedisClientMock.mockReturnValue(null);
    await expect(readState()).rejects.toBeInstanceOf(SyncStateUnavailableError);
  });
});

describe("writeState", () => {
  it("stores the state as JSON", async () => {
    await writeState({ cursor: 10, pending: [11] });
    expect(redisSetMock).toHaveBeenCalledWith(
      "clickhouse_sync:state",
      JSON.stringify({ cursor: 10, pending: [11] })
    );
  });
});

describe("resolveInitialState", () => {
  it("reuses the stored progress when present", async () => {
    redisGetMock.mockResolvedValue(JSON.stringify({ cursor: 99, pending: [] }));

    await expect(resolveInitialState(config)).resolves.toEqual({ cursor: 99, pending: [] });
    expect(queryJsonMock).not.toHaveBeenCalled();
  });

  it("starts at the current tail when both sides are empty (no backfill)", async () => {
    queryJsonMock.mockResolvedValue([{ cnt: "0", max_ms: "0" }]);
    getMaxIdMock.mockResolvedValue(5000);

    await expect(resolveInitialState(config)).resolves.toEqual({ cursor: 5000, pending: [] });
    expect(findCursorBeforeMock).not.toHaveBeenCalled();
  });

  it("rescans a lookback window when state was lost but ClickHouse has data", async () => {
    const watermark = Date.parse("2026-09-19T10:00:00.000Z");
    // UInt64 在 JSONEachRow 输出里是带引号的字符串
    queryJsonMock.mockResolvedValue([{ cnt: "100", max_ms: String(watermark) }]);
    findCursorBeforeMock.mockResolvedValue(1234);

    await expect(resolveInitialState(config)).resolves.toEqual({ cursor: 1234, pending: [] });
    expect(findCursorBeforeMock).toHaveBeenCalledWith(new Date(watermark - config.maxPendingAgeMs));
  });

  it("treats a missing watermark row as an empty table", async () => {
    queryJsonMock.mockResolvedValue([]);
    getMaxIdMock.mockResolvedValue(7);

    await expect(resolveInitialState(config)).resolves.toEqual({ cursor: 7, pending: [] });
  });
});

describe("getClickHouseSyncFence", () => {
  it("returns null when sync is disabled so cleanup keeps its old behaviour", async () => {
    isEnabledMock.mockReturnValue(false);
    await expect(getClickHouseSyncFence()).resolves.toBeNull();
  });

  it("returns the cursor when nothing is pending", async () => {
    redisGetMock.mockResolvedValue(JSON.stringify({ cursor: 500, pending: [] }));
    await expect(getClickHouseSyncFence()).resolves.toBe(500);
  });

  it("holds the fence below the oldest pending row", async () => {
    redisGetMock.mockResolvedValue(JSON.stringify({ cursor: 500, pending: [310, 290, 400] }));
    await expect(getClickHouseSyncFence()).resolves.toBe(289);
  });

  it("refuses to produce a fence when progress is unknown", async () => {
    redisGetMock.mockResolvedValue(null);
    await expect(getClickHouseSyncFence()).rejects.toBeInstanceOf(SyncStateUnavailableError);
  });

  it("propagates Redis outages instead of allowing unfenced deletes", async () => {
    getRedisClientMock.mockReturnValue(null);
    await expect(getClickHouseSyncFence()).rejects.toBeInstanceOf(SyncStateUnavailableError);
  });
});
