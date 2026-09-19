import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvConfigMock = vi.fn();

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => getEnvConfigMock(),
}));

import {
  getClickHouseConfig,
  isClickHouseSyncEnabled,
  qualifiedTableName,
} from "@/lib/clickhouse/config";

const baseEnv = {
  CLICKHOUSE_URL: "http://clickhouse:8123",
  CLICKHOUSE_USER: "cch",
  CLICKHOUSE_PASSWORD: "secret",
  CLICKHOUSE_DATABASE: "logs",
  CLICKHOUSE_TABLE: "cch_request_log",
  CLICKHOUSE_TTL_DAYS: undefined,
  CLICKHOUSE_REQUEST_TIMEOUT_MS: 10000,
  CLICKHOUSE_SYNC_INTERVAL_MS: 5000,
  CLICKHOUSE_SYNC_BATCH_SIZE: 5000,
  CLICKHOUSE_SYNC_LAG_MS: 300000,
  CLICKHOUSE_SYNC_SETTLE_MS: 150000,
  CLICKHOUSE_SYNC_MAX_PENDING_AGE_MS: 3600000,
  CLICKHOUSE_SYNC_MAX_PENDING: 20000,
};

beforeEach(() => {
  getEnvConfigMock.mockReturnValue({ ...baseEnv });
});

describe("isClickHouseSyncEnabled", () => {
  it("is driven solely by the presence of a URL", () => {
    expect(isClickHouseSyncEnabled()).toBe(true);

    getEnvConfigMock.mockReturnValue({ ...baseEnv, CLICKHOUSE_URL: undefined });
    expect(isClickHouseSyncEnabled()).toBe(false);

    getEnvConfigMock.mockReturnValue({ ...baseEnv, CLICKHOUSE_URL: "" });
    expect(isClickHouseSyncEnabled()).toBe(false);
  });
});

describe("getClickHouseConfig", () => {
  it("returns null when no URL is configured", () => {
    getEnvConfigMock.mockReturnValue({ ...baseEnv, CLICKHOUSE_URL: undefined });
    expect(getClickHouseConfig()).toBeNull();
  });

  it("maps the environment onto the config", () => {
    expect(getClickHouseConfig()).toEqual({
      url: "http://clickhouse:8123",
      user: "cch",
      password: "secret",
      database: "logs",
      table: "cch_request_log",
      ttlDays: undefined,
      requestTimeoutMs: 10000,
      syncIntervalMs: 5000,
      syncBatchSize: 5000,
      syncLagMs: 300000,
      syncSettleMs: 150000,
      maxPendingAgeMs: 3600000,
      maxPending: 20000,
    });
  });

  it("strips trailing slashes so URL building stays predictable", () => {
    getEnvConfigMock.mockReturnValue({
      ...baseEnv,
      CLICKHOUSE_URL: "http://clickhouse:8123///",
    });

    expect(getClickHouseConfig()?.url).toBe("http://clickhouse:8123");
  });

  it("carries the optional TTL through", () => {
    getEnvConfigMock.mockReturnValue({ ...baseEnv, CLICKHOUSE_TTL_DAYS: 90 });
    expect(getClickHouseConfig()?.ttlDays).toBe(90);
  });
});

describe("qualifiedTableName", () => {
  it("joins database and table", () => {
    const config = getClickHouseConfig();
    expect(config).not.toBeNull();
    expect(qualifiedTableName(config!)).toBe("logs.cch_request_log");
  });
});
