import "server-only";
import { insertJsonEachRow } from "@/lib/clickhouse/client";
import {
  type ClickHouseConfig,
  getClickHouseConfig,
  qualifiedTableName,
} from "@/lib/clickhouse/config";
import { type SyncSourceRow, toClickHouseRow } from "@/lib/clickhouse/row-mapper";
import { ensureSchema } from "@/lib/clickhouse/schema";
import { fetchUnsyncedBatch, markSynced } from "@/lib/clickhouse/source";
import { resolveFloor } from "@/lib/clickhouse/sync-state";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import {
  acquireLeaderLock,
  type LeaderLock,
  releaseLeaderLock,
  startLeaderLockKeepAlive,
} from "@/lib/provider-endpoints/leader-lock";

const LOCK_KEY = "locks:clickhouse-sync";
const LOCK_TTL_MS = 5 * 60 * 1000;
/** 单个 tick 内的最大轮数：追平积压时不要无限占用一个 tick */
const MAX_ROUNDS_PER_TICK = 20;
/** 失败告警限频窗口：ClickHouse 长时间不可用时不要刷日志 */
const ERROR_LOG_INTERVAL_MS = 60 * 1000;
/** "已发送未标记"记忆上限相对单 tick 最大行数的倍数 */
const SHIPPED_UNMARKED_CAP_FACTOR = 4;
/** 静置窗口相对 hedge 败者排空超时的建议余量 */
const SETTLE_MARGIN_MS = 30 * 1000;

interface WorkerState {
  started?: boolean;
  intervalId?: ReturnType<typeof setInterval>;
  lock?: LeaderLock;
  running?: boolean;
  currentPromise?: Promise<void>;
  stopRequested?: boolean;
  schemaReady?: boolean;
  lastErrorLoggedAt?: number;
  lastError?: string;
  lastSuccessAt?: number;
  totalShipped?: number;
  floorMs?: number;
  /**
   * 本进程已写入 ClickHouse、但同步标记没能落库的行：id -> 发送时的 updated_at。
   *
   * PG 能读不能写（只读切换、磁盘满、语句超时）时，没有这份记忆每轮都会把同一批行重发一遍。
   * 以 updated_at 为键：内容变化过的行仍会重新发送。条目描述的是 ClickHouse 已有的内容，
   * 与 leader 锁无关（锁每个 tick 都会释放），因此跨 tick 保留，只在停止或超过上限时清空。
   */
  shippedUnmarked?: Map<number, number>;
}

const globalState = globalThis as typeof globalThis & {
  __CCH_CLICKHOUSE_SYNC_WORKER__?: WorkerState;
};

function state(): WorkerState {
  if (!globalState.__CCH_CLICKHOUSE_SYNC_WORKER__) {
    globalState.__CCH_CLICKHOUSE_SYNC_WORKER__ = {};
  }
  return globalState.__CCH_CLICKHOUSE_SYNC_WORKER__;
}

function shippedUnmarked(): Map<number, number> {
  const workerState = state();
  if (!workerState.shippedUnmarked) {
    workerState.shippedUnmarked = new Map();
  }
  return workerState.shippedUnmarked;
}

function versionOf(row: SyncSourceRow): number {
  return row.updatedAt?.getTime() ?? 0;
}

interface RoundResult {
  batchFull: boolean;
  shipped: number;
  marked: number;
}

/**
 * 一轮同步：读出一批可发送且未标记的行，写入 ClickHouse，再把它们标记为已同步。
 *
 * 进度记录在行上，因此不存在"游标越过、之后才出现的更小 id"这种漏数路径：
 * 一行只要还没被标记，下一轮就会再次被选中。
 *
 * 写入成功之后才标记，投递语义是"至少一次"：重复行由 ReplacingMergeTree(updated_at)
 * 在 merge 时折叠。
 */
async function runRound(
  config: ClickHouseConfig,
  floor: Date,
  nowMs: number
): Promise<RoundResult> {
  const settleCutoff = new Date(nowMs - config.syncSettleMs);
  const orphanCutoff = new Date(nowMs - config.maxPendingAgeMs);

  const rows = await fetchUnsyncedBatch({
    floor,
    settleCutoff,
    orphanCutoff,
    limit: config.syncBatchSize,
  });
  const batchFull = rows.length === config.syncBatchSize;
  if (rows.length === 0) {
    return { batchFull, shipped: 0, marked: 0 };
  }

  const remembered = shippedUnmarked();
  const rowsToShip = rows.filter((row) => remembered.get(row.id) !== versionOf(row));
  if (rowsToShip.length > 0) {
    await insertJsonEachRow(config, qualifiedTableName(config), rowsToShip.map(toClickHouseRow));
  }

  const ids = rows.map((row) => row.id);
  let markedIds: number[];
  try {
    markedIds = await markSynced(ids, { syncedAt: new Date(nowMs), settleCutoff });
  } catch (error) {
    for (const row of rows) {
      remembered.set(row.id, versionOf(row));
    }
    throw error;
  }

  const marked = new Set(markedIds);
  for (const row of rows) {
    if (marked.has(row.id)) {
      remembered.delete(row.id);
    } else {
      remembered.set(row.id, versionOf(row));
    }
  }

  if (marked.size < ids.length) {
    logger.debug("[ClickHouseSync] Some shipped rows were not marked; they will be re-evaluated", {
      fetched: ids.length,
      marked: marked.size,
    });
  }

  const cap = SHIPPED_UNMARKED_CAP_FACTOR * config.syncBatchSize * MAX_ROUNDS_PER_TICK;
  if (remembered.size > cap) {
    logger.warn("[ClickHouseSync] Too many shipped-but-unmarked rows; forgetting them", {
      count: remembered.size,
    });
    remembered.clear();
  }

  // 整批都没能标记（例如全部被并发补写锁住）时不在本 tick 内重试同一批，等下一个周期
  return {
    batchFull: batchFull && marked.size > 0,
    shipped: rowsToShip.length,
    marked: marked.size,
  };
}

function logFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const workerState = state();
  workerState.lastError = message;

  const now = Date.now();
  const lastLoggedAt = workerState.lastErrorLoggedAt ?? 0;
  if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) {
    return;
  }

  workerState.lastErrorLoggedAt = now;
  logger.warn("[ClickHouseSync] Sync tick failed", { error: message });
}

async function runSyncOnce(): Promise<void> {
  const workerState = state();
  if (workerState.running || workerState.stopRequested) {
    return;
  }

  const config = getClickHouseConfig();
  if (!config) {
    return;
  }

  workerState.running = true;

  let lock: LeaderLock | null = null;
  let leadershipLost = false;
  let stopKeepAlive: (() => void) | undefined;

  try {
    lock = await acquireLeaderLock(LOCK_KEY, LOCK_TTL_MS);
    if (!lock) {
      return;
    }

    workerState.lock = lock;

    stopKeepAlive = startLeaderLockKeepAlive({
      getLock: () => state().lock,
      clearLock: () => {
        state().lock = undefined;
      },
      ttlMs: LOCK_TTL_MS,
      logTag: "ClickHouseSync",
      onLost: () => {
        leadershipLost = true;
      },
    }).stop;

    if (!workerState.schemaReady) {
      await ensureSchema(config);
      workerState.schemaReady = true;
    }

    if (workerState.floorMs === undefined) {
      workerState.floorMs = (await resolveFloor(config)).getTime();
    }
    const floor = new Date(workerState.floorMs);

    let shippedInTick = 0;
    let markedInTick = 0;

    for (let round = 0; round < MAX_ROUNDS_PER_TICK; round += 1) {
      if (leadershipLost || workerState.stopRequested) {
        break;
      }

      const result = await runRound(config, floor, Date.now());
      shippedInTick += result.shipped;
      markedInTick += result.marked;

      if (!result.batchFull) {
        break;
      }
    }

    workerState.lastSuccessAt = Date.now();
    workerState.lastError = undefined;
    workerState.totalShipped = (workerState.totalShipped ?? 0) + shippedInTick;

    if (shippedInTick > 0) {
      logger.info("[ClickHouseSync] Shipped rows", {
        shipped: shippedInTick,
        marked: markedInTick,
        shippedUnmarked: shippedUnmarked().size,
      });
    }
  } catch (error) {
    logFailure(error);
  } finally {
    stopKeepAlive?.();
    state().running = false;

    if (lock) {
      state().lock = undefined;
      await releaseLeaderLock(lock);
    }
  }
}

function launchSync(): void {
  const workerState = state();
  if (workerState.currentPromise) {
    return;
  }

  const current = runSyncOnce().finally(() => {
    if (state().currentPromise === current) {
      state().currentPromise = undefined;
    }
  });
  workerState.currentPromise = current;
}

/**
 * 启动同步 worker。未配置 CLICKHOUSE_URL 时直接返回，不产生任何开销。
 */
export function startClickHouseSyncWorker(): void {
  if (process.env.CI === "true") {
    return;
  }

  const config = getClickHouseConfig();
  if (!config) {
    return;
  }

  const workerState = state();
  if (workerState.started) {
    return;
  }

  workerState.started = true;
  workerState.stopRequested = false;

  // 静置窗口是 hedge 败者计费晚到与"已标记同步"之间唯一的屏障：标记之后的补写不会再发出
  const hedgeDrainMs = getEnvConfig().HEDGE_LOSER_DRAIN_TIMEOUT_MS;
  if (config.syncSettleMs < hedgeDrainMs + SETTLE_MARGIN_MS) {
    logger.warn("[ClickHouseSync] Settle window is shorter than the hedge loser drain window", {
      settleMs: config.syncSettleMs,
      recommendedMinMs: hedgeDrainMs + SETTLE_MARGIN_MS,
    });
  }

  logger.info("[ClickHouseSync] Starting request log sync", {
    table: qualifiedTableName(config),
    intervalMs: config.syncIntervalMs,
    batchSize: config.syncBatchSize,
    settleMs: config.syncSettleMs,
  });

  launchSync();

  const intervalId = setInterval(() => {
    launchSync();
  }, config.syncIntervalMs);
  (intervalId as unknown as { unref?: () => void }).unref?.();
  workerState.intervalId = intervalId;
}

/**
 * 停止 worker：只等当前在飞的 tick 结束，不做额外的收尾同步。
 * 未发送的行仍在 PG 里，下次启动会从同一游标继续。
 */
export async function stopClickHouseSyncWorker(): Promise<void> {
  const workerState = state();
  workerState.stopRequested = true;

  if (workerState.intervalId) {
    clearInterval(workerState.intervalId);
  }
  workerState.intervalId = undefined;
  workerState.started = false;
  shippedUnmarked().clear();

  await workerState.currentPromise;

  const lock = workerState.lock;
  workerState.lock = undefined;
  if (lock) {
    await releaseLeaderLock(lock);
  }
}

export function getClickHouseSyncStatus(): {
  started: boolean;
  running: boolean;
  isLeader: boolean;
  floorMs?: number;
  shippedUnmarkedCount: number;
  totalShipped?: number;
  lastSuccessAt?: number;
  lastError?: string;
} {
  const workerState = state();
  return {
    started: workerState.started === true,
    running: workerState.running === true,
    isLeader: workerState.lock !== undefined,
    floorMs: workerState.floorMs,
    shippedUnmarkedCount: workerState.shippedUnmarked?.size ?? 0,
    totalShipped: workerState.totalShipped,
    lastSuccessAt: workerState.lastSuccessAt,
    lastError: workerState.lastError,
  };
}

export const __test__ = { runRound, runSyncOnce, state };
