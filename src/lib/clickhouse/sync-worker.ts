import "server-only";
import { insertJsonEachRow } from "@/lib/clickhouse/client";
import {
  type ClickHouseConfig,
  getClickHouseConfig,
  qualifiedTableName,
} from "@/lib/clickhouse/config";
import { type SyncSourceRow, toClickHouseRow } from "@/lib/clickhouse/row-mapper";
import { ensureSchema } from "@/lib/clickhouse/schema";
import { fetchBatchAfter, fetchByIds } from "@/lib/clickhouse/source";
import {
  readState,
  resolveInitialState,
  type SyncState,
  writeState,
} from "@/lib/clickhouse/sync-state";
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
  cursor?: number;
  pendingCount?: number;
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

/**
 * 是否可以发往 ClickHouse。
 *
 * 终态判定用 status_code IS NOT NULL（与仓库内终态围栏一致）；静置延迟是为了等
 * hedge 败者计费这类终态后仍会变化的写入落库，避免同步到中间值。
 */
function isShippable(row: SyncSourceRow, settleCutoffMs: number): boolean {
  if (row.statusCode === null || row.statusCode === undefined) {
    return false;
  }
  return (row.updatedAt?.getTime() ?? 0) <= settleCutoffMs;
}

interface RoundResult {
  state: SyncState;
  batchFull: boolean;
  shipped: number;
}

/**
 * 一轮同步：先复查 pending，再按游标扫新行，最后一次性写入 ClickHouse。
 *
 * 写入成功之后才持久化进度，因此投递语义是"至少一次"：
 * 重复行由 ReplacingMergeTree(updated_at) 在 merge 时折叠。
 */
async function runRound(
  config: ClickHouseConfig,
  current: SyncState,
  nowMs: number
): Promise<RoundResult> {
  const lagCutoff = nowMs - config.syncLagMs;
  const settleCutoff = nowMs - config.syncSettleMs;
  const orphanCutoff = nowMs - config.maxPendingAgeMs;

  const rowsToShip: SyncSourceRow[] = [];
  const nextPending: number[] = [];

  if (current.pending.length > 0) {
    const rows = await fetchByIds(current.pending);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of current.pending) {
      const row = byId.get(id);
      if (!row) {
        // 行已被删除：无需再等
        continue;
      }
      if (isShippable(row, settleCutoff)) {
        rowsToShip.push(row);
        continue;
      }
      if ((row.createdAt?.getTime() ?? 0) < orphanCutoff) {
        // 孤儿行（进程崩溃后 status_code 永远为 NULL）在 PG 侧无人清扫，
        // 等够 maxPendingAgeMs 后按原样发出，status_code 会落成 0。
        rowsToShip.push(row);
        continue;
      }
      nextPending.push(id);
    }
  }

  let cursor = current.cursor;
  let batchFull = false;

  if (nextPending.length >= config.maxPending) {
    logger.warn("[ClickHouseSync] Pending backlog at limit; holding cursor", {
      pending: nextPending.length,
      maxPending: config.maxPending,
    });
  } else {
    const batch = await fetchBatchAfter(cursor, config.syncBatchSize);
    batchFull = batch.length === config.syncBatchSize;

    for (const row of batch) {
      // 回看延迟：serial id 不是提交顺序，太新的行可能还有更小 id 未提交
      if ((row.createdAt?.getTime() ?? 0) > lagCutoff) {
        batchFull = false;
        break;
      }
      cursor = row.id;
      if (isShippable(row, settleCutoff)) {
        rowsToShip.push(row);
      } else {
        nextPending.push(row.id);
      }
    }
  }

  if (rowsToShip.length > 0) {
    await insertJsonEachRow(config, qualifiedTableName(config), rowsToShip.map(toClickHouseRow));
  }

  const nextState: SyncState = { cursor, pending: nextPending };
  await writeState(nextState);

  return { state: nextState, batchFull, shipped: rowsToShip.length };
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

    let syncState = await readState();
    if (!syncState) {
      syncState = await resolveInitialState(config);
      // 立刻落盘：日志清理的围栏依赖这份进度，不能等到第一批数据发出之后
      await writeState(syncState);
    }

    let shippedInTick = 0;

    for (let round = 0; round < MAX_ROUNDS_PER_TICK; round += 1) {
      if (leadershipLost || workerState.stopRequested) {
        break;
      }

      const result = await runRound(config, syncState, Date.now());
      syncState = result.state;
      shippedInTick += result.shipped;

      if (!result.batchFull) {
        break;
      }
    }

    workerState.cursor = syncState.cursor;
    workerState.pendingCount = syncState.pending.length;
    workerState.lastSuccessAt = Date.now();
    workerState.lastError = undefined;
    workerState.totalShipped = (workerState.totalShipped ?? 0) + shippedInTick;

    if (shippedInTick > 0) {
      logger.info("[ClickHouseSync] Shipped rows", {
        shipped: shippedInTick,
        cursor: syncState.cursor,
        pending: syncState.pending.length,
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

  logger.info("[ClickHouseSync] Starting request log sync", {
    table: qualifiedTableName(config),
    intervalMs: config.syncIntervalMs,
    batchSize: config.syncBatchSize,
    lagMs: config.syncLagMs,
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
  cursor?: number;
  pendingCount?: number;
  totalShipped?: number;
  lastSuccessAt?: number;
  lastError?: string;
} {
  const workerState = state();
  return {
    started: workerState.started === true,
    running: workerState.running === true,
    isLeader: workerState.lock !== undefined,
    cursor: workerState.cursor,
    pendingCount: workerState.pendingCount,
    totalShipped: workerState.totalShipped,
    lastSuccessAt: workerState.lastSuccessAt,
    lastError: workerState.lastError,
  };
}

export const __test__ = { isShippable, runRound, runSyncOnce, state };
