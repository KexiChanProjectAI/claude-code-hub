import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";

const queryJsonMock = vi.fn();
const readFloorMock = vi.fn();
const writeFloorMock = vi.fn();
const isEnabledMock = vi.fn();
const getConfigMock = vi.fn();
const redisDelMock = vi.fn();
const getRedisClientMock = vi.fn();

vi.mock("@/lib/clickhouse/client", () => ({
  queryJson: (...args: unknown[]) => queryJsonMock(...args),
}));

vi.mock("@/lib/clickhouse/source", () => ({
  readClickHouseFloor: (...args: unknown[]) => readFloorMock(...args),
  writeClickHouseFloorIfAbsent: (...args: unknown[]) => writeFloorMock(...args),
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
  getClickHouseCleanupCondition,
  resolveFloor,
  SyncStateUnavailableError,
} from "@/lib/clickhouse/sync-state";

function renderSql(sqlObject: unknown): { sql: string; params: unknown[] } {
  return (sqlObject as SQL).toQuery({
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (num: number) => `$${num}`,
    escapeString: (value: string) => `'${value}'`,
    casing: new CasingCache(),
    paramStartIndex: { value: 1 },
  });
}

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

const config: ClickHouseConfig = {
  url: "http://clickhouse:8123",
  user: "default",
  password: "",
  database: "logs",
  table: "cch_request_log",
  requestTimeoutMs: 5000,
  syncIntervalMs: 5000,
  syncBatchSize: 100,
  syncSettleMs: 150000,
  maxPendingAgeMs: 3600000,
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  redisDelMock.mockResolvedValue(1);
  getRedisClientMock.mockReturnValue({ status: "ready", del: redisDelMock });
  isEnabledMock.mockReturnValue(true);
  getConfigMock.mockReturnValue(config);
  queryJsonMock.mockResolvedValue([]);
  readFloorMock.mockResolvedValue(null);
  writeFloorMock.mockImplementation(async (floor: Date) => floor);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveFloor", () => {
  it("reuses the persisted floor without consulting ClickHouse", async () => {
    const persisted = new Date("2026-09-01T00:00:00.000Z");
    readFloorMock.mockResolvedValue(persisted);

    await expect(resolveFloor(config)).resolves.toEqual(persisted);
    expect(queryJsonMock).not.toHaveBeenCalled();
    expect(writeFloorMock).not.toHaveBeenCalled();
  });

  it("starts from the earliest ClickHouse row so rows missed by the old cursor are re-shipped", async () => {
    const earliest = Date.parse("2026-08-01T00:00:00.000Z");
    // UInt64 在 JSONEachRow 输出里是带引号的字符串
    queryJsonMock.mockResolvedValue([{ cnt: "651558", min_ms: String(earliest) }]);

    await expect(resolveFloor(config)).resolves.toEqual(new Date(earliest));
    expect(writeFloorMock).toHaveBeenCalledWith(new Date(earliest));
    expect(String(queryJsonMock.mock.calls[0][1])).toContain("min(created_at)");
  });

  it("covers in-flight requests when ClickHouse is empty (no history backfill)", async () => {
    queryJsonMock.mockResolvedValue([{ cnt: "0", min_ms: "0" }]);

    await expect(resolveFloor(config)).resolves.toEqual(new Date(NOW - config.maxPendingAgeMs));
  });

  it("treats a missing aggregate row as an empty table", async () => {
    queryJsonMock.mockResolvedValue([]);

    await expect(resolveFloor(config)).resolves.toEqual(new Date(NOW - config.maxPendingAgeMs));
  });

  it("defers to whatever another leader persisted first", async () => {
    const winner = new Date("2026-07-01T00:00:00.000Z");
    writeFloorMock.mockResolvedValue(winner);

    await expect(resolveFloor(config)).resolves.toEqual(winner);
  });

  it("drops the legacy Redis cursor state after initializing", async () => {
    await resolveFloor(config);
    expect(redisDelMock).toHaveBeenCalledWith("clickhouse_sync:state");
  });

  it("does not depend on Redis being available", async () => {
    getRedisClientMock.mockReturnValue(null);
    await expect(resolveFloor(config)).resolves.toBeInstanceOf(Date);

    getRedisClientMock.mockReturnValue({
      status: "ready",
      del: vi.fn().mockRejectedValue(new Error("redis gone")),
    });
    await expect(resolveFloor(config)).resolves.toBeInstanceOf(Date);
  });
});

describe("getClickHouseCleanupCondition", () => {
  it("returns null when sync is disabled so cleanup keeps its old behaviour", async () => {
    isEnabledMock.mockReturnValue(false);
    await expect(getClickHouseCleanupCondition()).resolves.toBeNull();
  });

  it("only admits synced or out-of-scope rows, never by id", async () => {
    const floor = new Date("2026-09-01T00:00:00.000Z");
    readFloorMock.mockResolvedValue(floor);

    const condition = await getClickHouseCleanupCondition();
    const rendered = renderSql(condition);

    expect(rendered.sql).toContain('"clickhouse_synced_at" is not null');
    expect(rendered.sql).toContain('"deleted_at" is not null');
    expect(rendered.sql).toContain('"blocked_by" =');
    expect(rendered.sql).toContain('"created_at" <');
    expect(rendered.sql).not.toContain('"id"');
    expect(rendered.params).toEqual(expect.arrayContaining(["warmup", floor.toISOString()]));
    // 四个条件是 OR 关系：任何一个成立即可删除
    expect(rendered.sql.match(/ or /g)).toHaveLength(3);
  });

  it("refuses to produce a fence before the floor is initialized", async () => {
    readFloorMock.mockResolvedValue(null);
    await expect(getClickHouseCleanupCondition()).rejects.toBeInstanceOf(SyncStateUnavailableError);
  });

  it("propagates database failures instead of allowing unfenced deletes", async () => {
    readFloorMock.mockRejectedValue(new Error("pg gone"));
    await expect(getClickHouseCleanupCondition()).rejects.toThrow("pg gone");
  });
});
