import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";
import type { SyncSourceRow } from "@/lib/clickhouse/row-mapper";

/**
 * message_request 的内存替身：实现与 source.ts 相同的选取与标记契约，
 * 让同步 worker 在虚拟时钟下跑多个周期，从而验证"不漏行"这一不变量本身，
 * 而不只是某一轮的调用参数。
 */
type FakeRow = SyncSourceRow & { deletedAt: Date | null; clickhouseSyncedAt: Date | null };

interface FetchParams {
  floor: Date;
  settleCutoff: Date;
  orphanCutoff: Date;
  limit: number;
}

class FakeMessageRequestTable {
  rows = new Map<number, FakeRow>();
  /** 被其他事务锁住的行：FOR UPDATE SKIP LOCKED 会跳过它们 */
  locked = new Set<number>();
  failNextMark = 0;
  onBeforeMark?: (ids: number[]) => void;

  insert(id: number, at: number, overrides: Partial<FakeRow> = {}): FakeRow {
    const row: FakeRow = {
      ...baseRow(id),
      createdAt: new Date(at),
      updatedAt: new Date(at),
      deletedAt: null,
      clickhouseSyncedAt: null,
      ...overrides,
    };
    this.rows.set(id, row);
    return row;
  }

  /** 模拟一次补写：与生产代码一样把 updated_at 设为 NOW() */
  patch(id: number, at: number, changes: Partial<FakeRow>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    Object.assign(row, changes, { updatedAt: new Date(at) });
  }

  delete(id: number): void {
    this.rows.delete(id);
  }

  async fetchUnsyncedBatch(params: FetchParams): Promise<SyncSourceRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.clickhouseSyncedAt === null &&
          row.deletedAt === null &&
          row.blockedBy !== "warmup" &&
          ms(row.createdAt) >= params.floor.getTime() &&
          ms(row.updatedAt) <= params.settleCutoff.getTime() &&
          (row.statusCode !== null || ms(row.createdAt) < params.orphanCutoff.getTime())
      )
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id - b.id)
      .slice(0, params.limit)
      .map((row) => snapshot(row));
  }

  async markSynced(
    ids: number[],
    params: { syncedAt: Date; settleCutoff: Date }
  ): Promise<number[]> {
    this.onBeforeMark?.(ids);
    if (this.failNextMark > 0) {
      this.failNextMark -= 1;
      throw new Error("pg read-only");
    }
    const marked: number[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const row = this.rows.get(id);
      if (
        row &&
        !this.locked.has(id) &&
        row.clickhouseSyncedAt === null &&
        ms(row.updatedAt) <= params.settleCutoff.getTime()
      ) {
        row.clickhouseSyncedAt = params.syncedAt;
        marked.push(id);
      }
    }
    return marked;
  }

  /** 与 getClickHouseCleanupCondition 相同的放行规则 */
  deletableByCleanup(id: number, floor: Date): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    return (
      row.clickhouseSyncedAt !== null ||
      row.deletedAt !== null ||
      row.blockedBy === "warmup" ||
      ms(row.createdAt) < floor.getTime()
    );
  }
}

function ms(value: Date | null): number {
  return value?.getTime() ?? 0;
}

function snapshot(row: FakeRow): SyncSourceRow {
  const { deletedAt: _deleted, clickhouseSyncedAt: _synced, ...rest } = row;
  return {
    ...rest,
    createdAt: row.createdAt ? new Date(row.createdAt) : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
  };
}

function baseRow(id: number): SyncSourceRow {
  return {
    id,
    createdAt: null,
    updatedAt: null,
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
    statusCode: 200,
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

const table = { current: new FakeMessageRequestTable() };

const insertJsonEachRowMock = vi.fn();
const getConfigMock = vi.fn();
const ensureSchemaMock = vi.fn();
const resolveFloorMock = vi.fn();
const acquireLeaderLockMock = vi.fn();
const releaseLeaderLockMock = vi.fn();
const loggerWarnMock = vi.fn();
const fetchSpy = vi.fn();
const markSpy = vi.fn();

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
  fetchUnsyncedBatch: (params: FetchParams) => {
    fetchSpy(params);
    return table.current.fetchUnsyncedBatch(params);
  },
  markSynced: (ids: number[], params: { syncedAt: Date; settleCutoff: Date }) => {
    markSpy(ids, params);
    return table.current.markSynced(ids, params);
  },
}));

vi.mock("@/lib/clickhouse/sync-state", () => ({
  resolveFloor: (...args: unknown[]) => resolveFloorMock(...args),
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

const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const config: ClickHouseConfig = {
  url: "http://clickhouse:8123",
  user: "default",
  password: "",
  database: "logs",
  table: "cch_request_log",
  requestTimeoutMs: 5000,
  syncIntervalMs: 5000,
  syncBatchSize: 3,
  syncSettleMs: 30_000,
  maxPendingAgeMs: 600_000,
};

/** 同步范围下界：足够早，覆盖所有测试行 */
const FLOOR = new Date(T0 - HOUR);

let now = T0;
function advance(deltaMs: number): void {
  now += deltaMs;
}

type ChRow = { id: number; updated_at: string; status_code: number; created_at: string };

/** ClickHouse 收到的每一条写入（含重复） */
function chInserts(): ChRow[] {
  return insertJsonEachRowMock.mock.calls.flatMap((call) => call[2] as ChRow[]);
}

/** ReplacingMergeTree(updated_at) 合并后的视图：每个 id 保留版本最大的一条 */
function chFinal(): Map<number, ChRow> {
  const merged = new Map<number, ChRow>();
  for (const row of chInserts()) {
    const existing = merged.get(row.id);
    if (!existing || row.updated_at >= existing.updated_at) {
      merged.set(row.id, row);
    }
  }
  return merged;
}

function markedAt(id: number): Date | null {
  return table.current.rows.get(id)?.clickhouseSyncedAt ?? null;
}

/** 下一个周期：推进虚拟时钟，然后跑一次 tick */
async function tick(deltaMs = config.syncIntervalMs): Promise<void> {
  advance(deltaMs);
  await __test__.runSyncOnce();
}

/**
 * 旧版 id 游标算法（仅用于记录回归）：按 id > cursor 读取，
 * created_at 进入回看延迟之前停止，游标推进到看到的最大 id。
 */
function legacyCursorAfter(cursor: number, lagMs: number): number {
  const lagCutoff = now - lagMs;
  const batch = [...table.current.rows.values()]
    .filter((row) => row.id > cursor && row.deletedAt === null && row.blockedBy !== "warmup")
    .sort((a, b) => a.id - b.id);
  let next = cursor;
  for (const row of batch) {
    if (ms(row.createdAt) > lagCutoff) break;
    next = row.id;
  }
  return next;
}

beforeEach(() => {
  delete (globalThis as { __CCH_CLICKHOUSE_SYNC_WORKER__?: unknown })
    .__CCH_CLICKHOUSE_SYNC_WORKER__;

  table.current = new FakeMessageRequestTable();
  now = T0;
  vi.spyOn(Date, "now").mockImplementation(() => now);

  insertJsonEachRowMock.mockReset();
  insertJsonEachRowMock.mockResolvedValue(undefined);
  fetchSpy.mockReset();
  markSpy.mockReset();
  loggerWarnMock.mockReset();
  getConfigMock.mockReturnValue(config);
  ensureSchemaMock.mockReset();
  ensureSchemaMock.mockResolvedValue(undefined);
  resolveFloorMock.mockReset();
  resolveFloorMock.mockResolvedValue(FLOOR);
  acquireLeaderLockMock.mockReset();
  acquireLeaderLockMock.mockResolvedValue({ key: "k", lockId: "1", lockType: "redis" });
  releaseLeaderLockMock.mockReset();
  releaseLeaderLockMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reserved ids used out of order (MESSAGE_REQUEST_INSERT_MODE=async)", () => {
  it("ships a low id that is first used hours after a higher id was synced", async () => {
    // 进程 A 预留 1..128 但一直没有请求；进程 B 预留 129..256，立刻写入 129
    table.current.insert(129, now);
    await tick(config.syncSettleMs + 1_000);

    expect(chFinal().has(129)).toBe(true);
    expect(markedAt(129)).not.toBeNull();

    // 数小时后进程 A 才第一次使用预留的 id 1，created_at 是此刻
    advance(3 * HOUR);
    table.current.insert(1, now);

    // 标记之前，它不能被日志清理删除
    expect(table.current.deletableByCleanup(1, FLOOR)).toBe(false);

    await tick(config.syncSettleMs + 1_000);

    expect(chFinal().get(1)?.status_code).toBe(200);
    expect(markedAt(1)).not.toBeNull();
    expect(table.current.deletableByCleanup(1, FLOOR)).toBe(true);
  });

  it("documents why the old id cursor lost that row", () => {
    const lagMs = 5 * MINUTE;
    table.current.insert(129, now);
    advance(lagMs + 1_000);

    // 旧版：游标越过 129，pending 为空
    const cursor = legacyCursorAfter(0, lagMs);
    expect(cursor).toBe(129);

    advance(3 * HOUR);
    table.current.insert(1, now);
    advance(lagMs + 1_000);

    // id > 129 的查询永远看不到 id 1；旧围栏 id <= 129 却会放行删除它
    expect(legacyCursorAfter(cursor, lagMs)).toBe(cursor);
    const legacyFence = cursor;
    expect(1 <= legacyFence).toBe(true);
  });

  it("converges across many cycles with two processes consuming interleaved reservations", async () => {
    // A: 1..128，B: 129..256。B 持续有流量，A 零星且间隔数小时
    const aIds = Array.from({ length: 128 }, (_, i) => i + 1);
    const bIds = Array.from({ length: 128 }, (_, i) => i + 129);
    const expected: number[] = [];

    for (let cycle = 0; cycle < 40; cycle += 1) {
      for (let k = 0; k < 3; k += 1) {
        const id = bIds.shift();
        if (id !== undefined) {
          table.current.insert(id, now);
          expected.push(id);
        }
      }
      if (cycle % 8 === 7) {
        const id = aIds.shift();
        if (id !== undefined) {
          table.current.insert(id, now);
          expected.push(id);
        }
        advance(2 * HOUR);
      }
      await tick();
    }
    // 流量停止后再跑几个周期，让最后一批静置并发出
    for (let i = 0; i < 20; i += 1) {
      await tick(config.syncSettleMs);
    }

    const final = chFinal();
    for (const id of expected) {
      expect(final.has(id), `id ${id} missing from ClickHouse`).toBe(true);
      expect(markedAt(id), `id ${id} not marked`).not.toBeNull();
    }
    // 旧游标在第一段 A 行出现之前就已越过它们
    expect(Math.min(...expected)).toBe(1);
  });
});

describe("settling and orphans", () => {
  it("waits for a terminal status and the settle window, across several ticks", async () => {
    table.current.insert(5, now, { statusCode: null });

    await tick(config.syncSettleMs + 1_000);
    await tick();
    expect(insertJsonEachRowMock).not.toHaveBeenCalled();
    expect(table.current.deletableByCleanup(5, FLOOR)).toBe(false);

    table.current.patch(5, now, { statusCode: 200 });
    await tick();
    // 刚终态：仍在静置窗口内
    expect(insertJsonEachRowMock).not.toHaveBeenCalled();

    await tick(config.syncSettleMs);
    expect(chFinal().get(5)?.status_code).toBe(200);
    expect(markedAt(5)).not.toBeNull();
  });

  it("ships over-age unfinalized rows with status_code 0 so orphans do not linger", async () => {
    table.current.insert(5, now, { statusCode: null });

    await tick(config.maxPendingAgeMs - 1_000);
    expect(insertJsonEachRowMock).not.toHaveBeenCalled();

    await tick(2_000);
    expect(chFinal().get(5)?.status_code).toBe(0);
    expect(markedAt(5)).not.toBeNull();
  });

  it("passes the settle and orphan cutoffs derived from the clock", async () => {
    await tick();

    const params = fetchSpy.mock.calls[0][0] as FetchParams;
    expect(params.floor).toEqual(FLOOR);
    expect(params.settleCutoff.getTime()).toBe(now - config.syncSettleMs);
    expect(params.orphanCutoff.getTime()).toBe(now - config.maxPendingAgeMs);
    expect(params.limit).toBe(config.syncBatchSize);
  });
});

describe("scope", () => {
  it("never ships soft-deleted or warmup rows, nor rows before the floor", async () => {
    table.current.insert(1, now, { deletedAt: new Date(now) });
    table.current.insert(2, now, { blockedBy: "warmup" });
    table.current.insert(3, FLOOR.getTime() - 1_000);
    table.current.insert(4, now);

    await tick(config.syncSettleMs + 1_000);

    expect([...chFinal().keys()]).toEqual([4]);
    expect(markedAt(1)).toBeNull();
    expect(markedAt(2)).toBeNull();
    expect(markedAt(3)).toBeNull();
    // 范围外的行本就允许清理
    expect(table.current.deletableByCleanup(1, FLOOR)).toBe(true);
    expect(table.current.deletableByCleanup(2, FLOOR)).toBe(true);
    expect(table.current.deletableByCleanup(3, FLOOR)).toBe(true);
  });

  it("resolves the floor once and reuses it", async () => {
    await tick();
    await tick();

    expect(resolveFloorMock).toHaveBeenCalledTimes(1);
    expect(getClickHouseSyncStatus().floorMs).toBe(FLOOR.getTime());
  });
});

describe("delivery guarantees", () => {
  it("marks rows only after ClickHouse accepted them", async () => {
    table.current.insert(1, now);

    await tick(config.syncSettleMs + 1_000);

    expect(insertJsonEachRowMock.mock.invocationCallOrder[0]).toBeLessThan(
      markSpy.mock.invocationCallOrder[0]
    );
  });

  it("leaves rows unmarked when the ClickHouse insert fails, then ships them next tick", async () => {
    table.current.insert(1, now);
    insertJsonEachRowMock.mockRejectedValueOnce(new Error("ClickHouse down"));

    await tick(config.syncSettleMs + 1_000);
    expect(markedAt(1)).toBeNull();
    expect(table.current.deletableByCleanup(1, FLOOR)).toBe(false);
    expect(getClickHouseSyncStatus().lastError).toBe("ClickHouse down");

    await tick();
    expect(markedAt(1)).not.toBeNull();
    expect(chFinal().has(1)).toBe(true);
  });

  it("does not re-ship when only the marker write failed", async () => {
    table.current.insert(1, now);
    table.current.failNextMark = 1;

    await tick(config.syncSettleMs + 1_000);
    expect(insertJsonEachRowMock).toHaveBeenCalledTimes(1);
    expect(markedAt(1)).toBeNull();
    expect(getClickHouseSyncStatus().shippedUnmarkedCount).toBe(1);

    await tick();
    // 同一版本已经在 ClickHouse 里：只补标记，不再写一遍
    expect(insertJsonEachRowMock).toHaveBeenCalledTimes(1);
    expect(markedAt(1)).not.toBeNull();
    expect(getClickHouseSyncStatus().shippedUnmarkedCount).toBe(0);
  });

  it("re-ships a row patched between fetch and mark, with the newer version", async () => {
    table.current.insert(1, now, { costUsd: "0.1" });
    table.current.onBeforeMark = (ids) => {
      if (ids.includes(1)) {
        // hedge 败者计费恰好在静置边界落库
        table.current.patch(1, now, { costUsd: "0.3" });
        table.current.onBeforeMark = undefined;
      }
    };

    await tick(config.syncSettleMs + 1_000);
    expect(markedAt(1)).toBeNull();
    const firstVersion = chFinal().get(1)?.updated_at;

    await tick();
    // 补写后的内容还在静置窗口内：既不重发也不标记
    expect(insertJsonEachRowMock).toHaveBeenCalledTimes(1);
    expect(markedAt(1)).toBeNull();

    await tick(config.syncSettleMs);
    expect(insertJsonEachRowMock).toHaveBeenCalledTimes(2);
    expect(markedAt(1)).not.toBeNull();
    const merged = chFinal().get(1) as ChRow & { cost_usd: string };
    expect(merged.updated_at > (firstVersion ?? "")).toBe(true);
    expect(merged.cost_usd).toBe("0.3");
  });

  it("leaves rows locked by a concurrent patch for the next round without re-inserting", async () => {
    table.current.insert(1, now);
    table.current.locked.add(1);

    await tick(config.syncSettleMs + 1_000);
    expect(markedAt(1)).toBeNull();

    table.current.locked.delete(1);
    await tick();

    expect(insertJsonEachRowMock).toHaveBeenCalledTimes(1);
    expect(markedAt(1)).not.toBeNull();
  });

  it("re-ships after a restart that lost the in-memory state (at-least-once)", async () => {
    table.current.insert(1, now);
    table.current.failNextMark = 1;
    await tick(config.syncSettleMs + 1_000);

    // 进程重启：内存状态全部丢失
    delete (globalThis as { __CCH_CLICKHOUSE_SYNC_WORKER__?: unknown })
      .__CCH_CLICKHOUSE_SYNC_WORKER__;
    await tick();

    expect(insertJsonEachRowMock).toHaveBeenCalledTimes(2);
    expect(markedAt(1)).not.toBeNull();
    // 重复写入由 ReplacingMergeTree 折叠
    expect(chFinal().size).toBe(1);
  });

  it("forgets shipped-but-unmarked rows beyond the memory cap", async () => {
    const remembered = new Map<number, number>();
    const cap = 4 * config.syncBatchSize * 20;
    for (let id = 1_000; id < 1_000 + cap; id += 1) remembered.set(id, 0);
    __test__.state().shippedUnmarked = remembered;

    table.current.insert(1, now);
    table.current.locked.add(1);
    await tick(config.syncSettleMs + 1_000);

    expect(getClickHouseSyncStatus().shippedUnmarkedCount).toBe(0);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Too many shipped-but-unmarked rows"),
      expect.anything()
    );
  });
});

describe("runRound", () => {
  it("reports a full batch so the caller keeps catching up", async () => {
    for (const id of [1, 2, 3]) table.current.insert(id, now - MINUTE);

    const result = await __test__.runRound(config, FLOOR, now);

    expect(result).toEqual({ batchFull: true, shipped: 3, marked: 3 });
  });

  it("does not spin on a full batch that could not be marked at all", async () => {
    for (const id of [1, 2, 3]) {
      table.current.insert(id, now - MINUTE);
      table.current.locked.add(id);
    }

    const result = await __test__.runRound(config, FLOOR, now);

    expect(result).toEqual({ batchFull: false, shipped: 3, marked: 0 });
  });

  it("does nothing when there is nothing to ship", async () => {
    const result = await __test__.runRound(config, FLOOR, now);

    expect(result).toEqual({ batchFull: false, shipped: 0, marked: 0 });
    expect(insertJsonEachRowMock).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
  });
});

describe("runSyncOnce", () => {
  it("does nothing when another instance holds the lock", async () => {
    acquireLeaderLockMock.mockResolvedValue(null);

    await __test__.runSyncOnce();

    expect(ensureSchemaMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("keeps draining while batches come back full", async () => {
    for (const id of [1, 2, 3, 4, 5, 6, 7]) table.current.insert(id, now);

    await tick(config.syncSettleMs + 1_000);

    // 3 + 3 + 1：同一个 tick 内三轮
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(chFinal().size).toBe(7);
    expect(getClickHouseSyncStatus().totalShipped).toBe(7);
  });

  it("swallows failures and releases the lock so the proxy is never affected", async () => {
    resolveFloorMock.mockRejectedValue(new Error("pg gone"));

    await expect(__test__.runSyncOnce()).resolves.toBeUndefined();

    expect(releaseLeaderLockMock).toHaveBeenCalledTimes(1);
    expect(getClickHouseSyncStatus().lastError).toBe("pg gone");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Sync tick failed"),
      expect.objectContaining({ error: "pg gone" })
    );
  });

  it("rate-limits repeated failure logs", async () => {
    resolveFloorMock.mockRejectedValue(new Error("pg gone"));

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

  it("warns when the settle window is shorter than the hedge loser drain window", async () => {
    vi.stubEnv("CI", "false");

    // 测试配置的静置窗口是 30 秒，短于默认的 120 秒 + 30 秒余量
    startClickHouseSyncWorker();
    await stopClickHouseSyncWorker();

    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Settle window is shorter"),
      expect.objectContaining({ settleMs: 30_000 })
    );
  });

  it("waits for the in-flight tick before returning", async () => {
    vi.stubEnv("CI", "false");
    let released = false;
    let resolveTick: () => void = () => {};
    const tickEntered = new Promise<void>((entered) => {
      ensureSchemaMock.mockImplementation(() => {
        entered();
        return new Promise<void>((resolve) => {
          resolveTick = resolve;
        });
      });
    });

    startClickHouseSyncWorker();
    await tickEntered;
    const stopping = stopClickHouseSyncWorker().then(() => {
      released = true;
    });

    // stop 必须等在飞的 tick 结束
    await Promise.resolve();
    expect(released).toBe(false);

    resolveTick();
    await stopping;

    expect(released).toBe(true);
    expect(getClickHouseSyncStatus().running).toBe(false);
  });
});
