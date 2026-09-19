import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";
import { toClickHouseRow } from "@/lib/clickhouse/row-mapper";

const execMock = vi.fn();
const queryJsonMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock("@/lib/clickhouse/client", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  queryJson: (...args: unknown[]) => queryJsonMock(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildAddColumnSql,
  buildCreateTableSql,
  CLICKHOUSE_COLUMNS,
  ensureSchema,
} from "@/lib/clickhouse/schema";

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
  execMock.mockResolvedValue(undefined);
  queryJsonMock.mockResolvedValue([]);
});

describe("buildCreateTableSql", () => {
  it("creates a ReplacingMergeTree keyed for time-range scans", () => {
    const sql = buildCreateTableSql(config);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS logs.cch_request_log");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(updated_at)");
    expect(sql).toContain("PARTITION BY toYYYYMM(created_at)");
    expect(sql).toContain("ORDER BY (created_at, id)");
    expect(sql).toContain("INDEX idx_client_ip client_ip TYPE bloom_filter");
  });

  it("declares every column", () => {
    const sql = buildCreateTableSql(config);
    for (const column of CLICKHOUSE_COLUMNS) {
      expect(sql).toContain(`${column.name} ${column.type}`);
    }
  });

  it("omits TTL unless configured", () => {
    expect(buildCreateTableSql(config)).not.toContain("TTL");
  });

  it("includes TTL when configured", () => {
    expect(buildCreateTableSql({ ...config, ttlDays: 90 })).toContain(
      "TTL toDateTime(created_at) + INTERVAL 90 DAY"
    );
  });
});

describe("buildAddColumnSql", () => {
  it("emits an idempotent ADD COLUMN per column", () => {
    expect(buildAddColumnSql(config, 0)).toBe(
      "ALTER TABLE logs.cch_request_log ADD COLUMN IF NOT EXISTS id UInt64"
    );
  });
});

describe("ensureSchema", () => {
  it("creates the database, the table and every column", async () => {
    await ensureSchema(config);

    const statements = execMock.mock.calls.map((call) => call[1] as string);
    expect(statements[0]).toBe("CREATE DATABASE IF NOT EXISTS logs");
    expect(statements[1]).toContain("CREATE TABLE IF NOT EXISTS logs.cch_request_log");
    expect(statements).toHaveLength(2 + CLICKHOUSE_COLUMNS.length);
    expect(statements.filter((s) => s.includes("ADD COLUMN IF NOT EXISTS"))).toHaveLength(
      CLICKHOUSE_COLUMNS.length
    );
  });

  it("warns with a ready-to-run ALTER when an existing table has no TTL", async () => {
    queryJsonMock.mockResolvedValue([
      { engine_full: "ReplacingMergeTree(updated_at) ORDER BY ..." },
    ]);

    await ensureSchema({ ...config, ttlDays: 30 });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("no TTL"),
      expect.objectContaining({
        applyManually: expect.stringContaining(
          "MODIFY TTL toDateTime(created_at) + INTERVAL 30 DAY"
        ),
      })
    );
  });

  it("stays quiet when the existing table already has a TTL", async () => {
    queryJsonMock.mockResolvedValue([{ engine_full: "ReplacingMergeTree(updated_at) TTL foo" }]);

    await ensureSchema({ ...config, ttlDays: 30 });

    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("skips TTL inspection when no TTL is configured", async () => {
    await ensureSchema(config);
    expect(queryJsonMock).not.toHaveBeenCalled();
  });

  it("never lets a failed TTL inspection break the sync", async () => {
    queryJsonMock.mockRejectedValue(new Error("system.tables denied"));
    await expect(ensureSchema({ ...config, ttlDays: 30 })).resolves.toBeUndefined();
  });
});

describe("mapper/DDL drift", () => {
  it("emits exactly the declared columns, minus the server-filled synced_at", () => {
    const mapped = Object.keys(
      toClickHouseRow({
        id: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: 1,
        userName: "u",
        keyId: 1,
        keyName: "k",
        clientIp: "127.0.0.1",
        userAgent: "ua",
        model: "m",
        originalModel: "m",
        actualResponseModel: "m",
        providerId: 1,
        providerName: "p",
        endpoint: "/v1/messages",
        apiType: "messages",
        sessionId: "s",
        requestSequence: 1,
        isReplay: false,
        statusCode: 200,
        blockedBy: null,
        durationMs: 1,
        ttftMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        costUsd: "0",
        errorMessage: null,
      })
    ).sort();

    const declared = CLICKHOUSE_COLUMNS.map((column) => column.name)
      .filter((name) => name !== "synced_at")
      .sort();

    expect(mapped).toEqual(declared);
  });
});
