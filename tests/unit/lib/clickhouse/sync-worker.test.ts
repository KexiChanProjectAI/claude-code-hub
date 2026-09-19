import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";
import type { SyncSourceRow } from "@/lib/clickhouse/row-mapper";

const insertJsonEachRowMock = vi.fn();
const getConfigMock = vi.fn();
const ensureSchemaMock = vi.fn();
const fetchBatchAfterMock = vi.fn();
const fetchByIdsMock = vi.fn();
const readStateMock = vi.fn();
const resolveInitialStateMock = vi.fn();
const writeStateMock = vi.fn();
const acquireLeaderLockMock = vi.fn();
const releaseLeaderLockMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock("@/lib/clickhouse/client", () => ({
  insertJsonEachRow: (...args: unknown[]) => insertJsonEachRowMock(...args),
}));

vi.mock("@/lib/clickhouse/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clickhouse/config")>();
  return { ...actual, getClickHouseConfig: (...args: unknown[]) => getConfigMock(...args) };
});

vi.mock("@/lib/clickhouse/schema", () => ({
  ensureSchema: (...args: unknown[]) => ensureSchemaMock(...args),
}));

vi.mock("@/lib/clickhouse/source", () => ({
  fetchBatchAfter: (...args: unknown[]) => fetchBatchAfterMock(...args),
  fetchByIds: (...args: unknown[]) => fetchByIdsMock(...args),
}));

vi.mock("@/lib/clickhouse/sync-state", () => ({
  readState: (...args: unknown[]) => readStateMock(...args),
  resolveInitialState: (...args: unknown[]) => resolveInitialStateMock(...args),
  writeState: (...args: unknown[]) => writeStateMock(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/provider-endpoints/leader-lock", () => ({
  acquireLeaderLock: (...args: unknown[]) => acquireLeaderLockMock(...args),
  releaseLeaderLock: (...args: unknown[]) => releaseLeaderLockMock(...args),
  renewLeaderLock: vi.fn(),
  startLeaderLockKeepAlive: () => ({ stop: () => {} }),
}));

import {
  __test__,
  getClickHouseSyncStatus,
  startClickHouseSyncWorker,
  stopClickHouseSyncWorker,
} from "@/lib/clickhouse/sync-worker";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");

const config: ClickHouseConfig = {
  url: "http://clickhouse:8123",
  user: "default",
  password: "",
  database: "logs",
  table: "cch_request_log",
  requestTimeoutMs: 5000,
  syncIntervalMs: 5000,
  syncBatchSize: 3,
  syncLagMs: 60_000,
  syncSettleMs: 30_000,
  maxPendingAgeMs: 600_000,
  maxPending: 5,
};

/** 默认：足够老（越过回看延迟）且已终态静置，即"可发送" */
function row(
  id: number,
  overrides: { createdAt?: number; updatedAt?: number; statusCode?: number | null } = {}
): SyncSourceRow {
  return {
    id,
    createdAt: new Date(overrides.createdAt ?? NOW - 120_000),
    updatedAt: new Date(overrides.updatedAt ?? NOW - 60_000),
    userId: 1,
    userName: "alice",
    keyId: 2,
    keyName: "laptop",
    clientIp: "203.0.113.9",
    userAgent: "claude-cli",
    model: "claude-sonnet-5",
    originalModel: "claude-sonnet-5",
    actualResponseModel: "claude-sonnet-5",
    providerId: 3,
    providerName: "anthropic",
    endpoint: "/v1/messages",
    apiType: "messages",
    sessionId: "s",
    requestSequence: 1,
    isReplay: false,
    statusCode: overrides.statusCode === undefined ? 200 : overrides.statusCode,
    blockedBy: null,
    durationMs: 10,
    ttftMs: 5,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: "0",
    errorMessage: null,
  };
}

function shippedIds(callIndex = 0): number[] {
  const rows = insertJsonEachRowMock.mock.calls[callIndex][2] as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

beforeEach(() => {
  delete (globalThis as { __CCH_CLICKHOUSE_SYNC_WORKER__?: unknown })
    .__CCH_CLICKHOUSE_SYNC_WORKER__;

  // runSyncOnce 内部用 Date.now() 算截止时间，固定它才能让行时间戳的相对关系成立
  vi.spyOn(Date, "now").mockReturnValue(NOW);

  getConfigMock.mockReturnValue(config);
  ensureSchemaMock.mockResolvedValue(undefined);
  insertJsonEachRowMock.mockResolvedValue(undefined);
  fetchBatchAfterMock.mockResolvedValue([]);
  fetchByIdsMock.mockResolvedValue([]);
  readStateMock.mockResolvedValue({ cursor: 0, pending: [] });
  resolveInitialStateMock.mockResolvedValue({ cursor: 0, pending: [] });
  writeStateMock.mockResolvedValue(undefined);
  acquireLeaderLockMock.mockResolvedValue({ key: "k", lockId: "1", lockType: "redis" });
  releaseLeaderLockMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isShippable", () => {
  it("requires a terminal status code", () => {
    expect(__test__.isShippable(row(1, { statusCode: null }), NOW - 30_000)).toBe(false);
  });

  it("requires the settle window to have elapsed", () => {
    expect(__test__.isShippable(row(1, { updatedAt: NOW - 1_000 }), NOW - 30_000)).toBe(false);
    expect(__test__.isShippable(row(1, { updatedAt: NOW - 60_000 }), NOW - 30_000)).toBe(true);
  });

  it("treats blocked rows as immediately final", () => {
    const blocked = { ...row(1), statusCode: 429, blockedBy: "local_capacity" };
    expect(__test__.isShippable(blocked, NOW - 30_000)).toBe(true);
  });
});

describe("runRound: scanning new rows", () => {
  it("ships settled rows and advances the cursor", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1), row(2)]);

    const result = await __test__.runRound(config, { cursor: 0, pending: [] }, NOW);

    expect(shippedIds()).toEqual([1, 2]);
    expect(result.state).toEqual({ cursor: 2, pending: [] });
    expect(result.batchFull).toBe(false);
    expect(result.shipped).toBe(2);
  });

  it("defers rows that have no terminal status yet", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1), row(2, { statusCode: null })]);

    const result = await __test__.runRound(config, { cursor: 0, pending: [] }, NOW);

    expect(shippedIds()).toEqual([1]);
    expect(result.state).toEqual({ cursor: 2, pending: [2] });
  });

  it("defers finalized rows still inside the settle window", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1, { updatedAt: NOW - 1_000 })]);

    const result = await __test__.runRound(config, { cursor: 0, pending: [] }, NOW);

    expect(insertJsonEachRowMock).not.toHaveBeenCalled();
    expect(result.state).toEqual({ cursor: 1, pending: [1] });
  });

  it("stops at the lag cutoff and does not treat the batch as full", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1), row(2), row(3, { createdAt: NOW - 1_000 })]);

    const result = await __test__.runRound(config, { cursor: 0, pending: [] }, NOW);

    expect(shippedIds()).toEqual([1, 2]);
    expect(result.state.cursor).toBe(2);
    expect(result.batchFull).toBe(false);
  });

  it("reports a full batch so the caller keeps catching up", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1), row(2), row(3)]);

    const result = await __test__.runRound(config, { cursor: 0, pending: [] }, NOW);

    expect(result.batchFull).toBe(true);
    expect(result.state.cursor).toBe(3);
  });

  it("queries from the current cursor with the configured batch size", async () => {
    await __test__.runRound(config, { cursor: 77, pending: [] }, NOW);
    expect(fetchBatchAfterMock).toHaveBeenCalledWith(77, 3);
  });
});

describe("runRound: pending rows", () => {
  it("ships pending rows once they finalize and settle", async () => {
    fetchByIdsMock.mockResolvedValue([row(5)]);

    const result = await __test__.runRound(config, { cursor: 10, pending: [5] }, NOW);

    expect(shippedIds()).toEqual([5]);
    expect(result.state.pending).toEqual([]);
  });

  it("drops pending rows that no longer exist", async () => {
    fetchByIdsMock.mockResolvedValue([]);

    const result = await __test__.runRound(config, { cursor: 10, pending: [5] }, NOW);

    expect(insertJsonEachRowMock).not.toHaveBeenCalled();
    expect(result.state.pending).toEqual([]);
  });

  it("keeps young unfinalized rows waiting", async () => {
    fetchByIdsMock.mockResolvedValue([row(5, { statusCode: null, createdAt: NOW - 100_000 })]);

    const result = await __test__.runRound(config, { cursor: 10, pending: [5] }, NOW);

    expect(insertJsonEachRowMock).not.toHaveBeenCalled();
    expect(result.state.pending).toEqual([5]);
  });

  it("ships over-age unfinalized rows with status_code 0 so orphans cannot wedge the cursor", async () => {
    fetchByIdsMock.mockResolvedValue([row(5, { statusCode: null, createdAt: NOW - 700_000 })]);

    const result = await __test__.runRound(config, { cursor: 10, pending: [5] }, NOW);

    expect(shippedIds()).toEqual([5]);
    const rows = insertJsonEachRowMock.mock.calls[0][2] as Array<{ status_code: number }>;
    expect(rows[0].status_code).toBe(0);
    expect(result.state.pending).toEqual([]);
  });

  it("holds the cursor when the pending backlog reaches the limit", async () => {
    fetchByIdsMock.mockResolvedValue(
      [1, 2, 3, 4, 5].map((id) => row(id, { statusCode: null, createdAt: NOW - 100_000 }))
    );

    const result = await __test__.runRound(config, { cursor: 10, pending: [1, 2, 3, 4, 5] }, NOW);

    expect(fetchBatchAfterMock).not.toHaveBeenCalled();
    expect(result.state.cursor).toBe(10);
    expect(result.state.pending).toHaveLength(5);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Pending backlog at limit"),
      expect.anything()
    );
  });
});

describe("runRound: delivery guarantees", () => {
  it("persists progress only after the insert succeeds", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1)]);

    await __test__.runRound(config, { cursor: 0, pending: [] }, NOW);

    expect(insertJsonEachRowMock).toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledWith({ cursor: 1, pending: [] });
    expect(insertJsonEachRowMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeStateMock.mock.invocationCallOrder[0]
    );
  });

  it("leaves progress untouched when the insert fails", async () => {
    fetchBatchAfterMock.mockResolvedValue([row(1)]);
    insertJsonEachRowMock.mockRejectedValue(new Error("ClickHouse down"));

    await expect(__test__.runRound(config, { cursor: 0, pending: [] }, NOW)).rejects.toThrow(
      "ClickHouse down"
    );
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("still records progress when there was nothing to ship", async () => {
    await __test__.runRound(config, { cursor: 9, pending: [] }, NOW);

    expect(insertJsonEachRowMock).not.toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledWith({ cursor: 9, pending: [] });
  });
});

describe("runSyncOnce", () => {
  it("does nothing when another instance holds the lock", async () => {
    acquireLeaderLockMock.mockResolvedValue(null);

    await __test__.runSyncOnce();

    expect(ensureSchemaMock).not.toHaveBeenCalled();
    expect(fetchBatchAfterMock).not.toHaveBeenCalled();
    expect(releaseLeaderLockMock).not.toHaveBeenCalled();
  });

  it("does nothing when ClickHouse is not configured", async () => {
    getConfigMock.mockReturnValue(null);

    await __test__.runSyncOnce();

    expect(acquireLeaderLockMock).not.toHaveBeenCalled();
  });

  it("ensures the schema once across ticks", async () => {
    await __test__.runSyncOnce();
    await __test__.runSyncOnce();

    expect(ensureSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("persists recovered progress immediately so the cleanup fence is computable", async () => {
    readStateMock.mockResolvedValue(null);
    resolveInitialStateMock.mockResolvedValue({ cursor: 4242, pending: [] });

    await __test__.runSyncOnce();

    expect(writeStateMock).toHaveBeenCalledWith({ cursor: 4242, pending: [] });
  });

  it("keeps draining while batches come back full", async () => {
    fetchBatchAfterMock
      .mockResolvedValueOnce([row(1), row(2), row(3)])
      .mockResolvedValueOnce([row(4)]);

    await __test__.runSyncOnce();

    expect(fetchBatchAfterMock).toHaveBeenCalledTimes(2);
    expect(fetchBatchAfterMock).toHaveBeenNthCalledWith(2, 3, 3);
    expect(getClickHouseSyncStatus().cursor).toBe(4);
    expect(getClickHouseSyncStatus().totalShipped).toBe(4);
  });

  it("swallows failures and releases the lock so the proxy is never affected", async () => {
    fetchBatchAfterMock.mockRejectedValue(new Error("pg gone"));

    await expect(__test__.runSyncOnce()).resolves.toBeUndefined();

    expect(releaseLeaderLockMock).toHaveBeenCalledTimes(1);
    expect(getClickHouseSyncStatus().lastError).toBe("pg gone");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Sync tick failed"),
      expect.objectContaining({ error: "pg gone" })
    );
  });

  it("rate-limits repeated failure logs", async () => {
    fetchBatchAfterMock.mockRejectedValue(new Error("pg gone"));

    await __test__.runSyncOnce();
    await __test__.runSyncOnce();
    await __test__.runSyncOnce();

    const failureLogs = loggerWarnMock.mock.calls.filter((call) =>
      String(call[0]).includes("Sync tick failed")
    );
    expect(failureLogs).toHaveLength(1);
  });

  it("stops before doing work once a stop has been requested", async () => {
    __test__.state().stopRequested = true;

    await __test__.runSyncOnce();

    expect(acquireLeaderLockMock).not.toHaveBeenCalled();
  });
});

describe("start/stop", () => {
  it("is a no-op when ClickHouse is not configured", () => {
    vi.stubEnv("CI", "false");
    getConfigMock.mockReturnValue(null);

    startClickHouseSyncWorker();

    expect(getClickHouseSyncStatus().started).toBe(false);
  });

  it("is a no-op under CI", () => {
    vi.stubEnv("CI", "true");

    startClickHouseSyncWorker();

    expect(getClickHouseSyncStatus().started).toBe(false);
  });

  it("starts once and stops cleanly", async () => {
    vi.stubEnv("CI", "false");

    startClickHouseSyncWorker();
    expect(getClickHouseSyncStatus().started).toBe(true);

    // 重复调用是幂等的：不会再起一个 tick
    startClickHouseSyncWorker();

    await stopClickHouseSyncWorker();

    expect(ensureSchemaMock).toHaveBeenCalledTimes(1);
    expect(getClickHouseSyncStatus().started).toBe(false);
    expect(getClickHouseSyncStatus().running).toBe(false);
  });

  it("waits for the in-flight tick before returning", async () => {
    vi.stubEnv("CI", "false");
    let releaseTick: () => void = () => {};
    fetchBatchAfterMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseTick = () => resolve([]);
        })
    );

    startClickHouseSyncWorker();
    const stopping = stopClickHouseSyncWorker();
    releaseTick();
    await stopping;

    expect(getClickHouseSyncStatus().running).toBe(false);
  });
});
