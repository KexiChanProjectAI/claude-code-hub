import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { clickhouseSyncState, messageRequest, usageLedger } from "@/drizzle/schema";

/**
 * ClickHouse 同步标记在真实 PostgreSQL 上的行为。
 *
 * 复现 handoff 中的反例：像 async INSERT 模式一样先从序列预留 id，
 * 高 id 先写入并被同步，低 id 数小时后才写入。新的选取条件必须仍然选中它，
 * 日志清理围栏在它被标记之前也不能删除它。
 */

const ENV_KEYS = ["DSN", "DB_POOL_MAX", "CLICKHOUSE_URL"] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
const dsn = process.env.DSN ?? process.env.DATABASE_URL;

if (dsn) {
  process.env.DSN = dsn;
  process.env.DB_POOL_MAX = "4";
  // 只用于打开清理围栏；本测试不连接 ClickHouse
  process.env.CLICKHOUSE_URL = "http://clickhouse.invalid:8123";
}
vi.resetModules();

const run = describe.skipIf(!dsn);
const KEY_PREFIX = `it-clickhouse-sync-marker-${randomUUID()}`;
// 独立的用户 id：清理只作用于本测试插入的行
const USER_ID = 960_000_000 + Math.floor(Math.random() * 1_000_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SETTLE_MS = 150_000;

run.sequential("ClickHouse sync marker on PostgreSQL", () => {
  let dbModule: typeof import("@/drizzle/db");
  let source: typeof import("@/lib/clickhouse/source");
  let syncState: typeof import("@/lib/clickhouse/sync-state");
  let cleanup: typeof import("@/lib/log-cleanup/service");
  let hadFloorRow = false;

  function db() {
    return dbModule.getDb();
  }

  /** 与 message-insert-buffer 相同的方式预留 id */
  async function reserveIds(count: number): Promise<number[]> {
    const rows = await db().execute(sql`
      SELECT nextval(pg_get_serial_sequence('message_request', 'id'))::bigint AS id
      FROM generate_series(1, ${count})
    `);
    return Array.from(rows as Iterable<{ id: unknown }>, (row) => Number(row.id)).sort(
      (a, b) => a - b
    );
  }

  async function insertRow(
    id: number,
    createdAt: Date,
    overrides: Partial<typeof messageRequest.$inferInsert> = {}
  ): Promise<void> {
    await db()
      .insert(messageRequest)
      .values({
        id,
        providerId: 0,
        userId: USER_ID,
        key: `${KEY_PREFIX}-${id}`,
        model: "integration-model",
        endpoint: "/v1/messages",
        statusCode: 200,
        createdAt,
        updatedAt: createdAt,
        ...overrides,
      });
  }

  async function readRow(id: number) {
    const [row] = await db()
      .select({
        updatedAt: messageRequest.updatedAt,
        clickhouseSyncedAt: messageRequest.clickhouseSyncedAt,
      })
      .from(messageRequest)
      .where(eq(messageRequest.id, id));
    return row;
  }

  async function fetchIds(floor: Date, nowMs: number): Promise<number[]> {
    const rows = await source.fetchUnsyncedBatch({
      floor,
      settleCutoff: new Date(nowMs - SETTLE_MS),
      orphanCutoff: new Date(nowMs - HOUR),
      limit: 10_000,
    });
    return rows.map((row) => row.id);
  }

  beforeAll(async () => {
    if (!dsn) throw new TypeError("DSN or DATABASE_URL is required");
    expect(new URL(dsn).pathname).toMatch(/test/i);

    const harnessDb = await import("@/drizzle/db");
    await harnessDb.closeDbPools();
    vi.resetModules();
    [dbModule, source, syncState, cleanup] = await Promise.all([
      import("@/drizzle/db"),
      import("@/lib/clickhouse/source"),
      import("@/lib/clickhouse/sync-state"),
      import("@/lib/log-cleanup/service"),
    ]);

    hadFloorRow = (await source.readClickHouseFloor()) !== null;
  });

  afterAll(async () => {
    try {
      const keyPattern = `${KEY_PREFIX}%`;
      await db().delete(messageRequest).where(like(messageRequest.key, keyPattern));
      await db().delete(usageLedger).where(like(usageLedger.key, keyPattern));
      if (!hadFloorRow) {
        await db().delete(clickhouseSyncState).where(eq(clickhouseSyncState.key, "default"));
      }
    } finally {
      await dbModule.closeDbPools();
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("selects a low reserved id that is inserted after a higher id was marked", async () => {
    const [low, high] = await reserveIds(2);
    const t0 = Date.now() - 4 * HOUR;
    const floor = new Date(t0 - HOUR);

    // 进程 B 先使用高 id，同步器发送并标记
    await insertRow(high, new Date(t0));
    const firstBatch = await fetchIds(floor, t0 + SETTLE_MS + MINUTE);
    expect(firstBatch).toContain(high);
    expect(firstBatch).not.toContain(low);
    const marked = await source.markSynced([high], {
      syncedAt: new Date(),
      settleCutoff: new Date(t0 + MINUTE),
    });
    expect(marked).toEqual([high]);

    // 数小时后进程 A 才使用预留的低 id
    const late = t0 + 3 * HOUR;
    await insertRow(low, new Date(late));
    const secondBatch = await fetchIds(floor, late + SETTLE_MS + MINUTE);
    expect(secondBatch).toContain(low);
    expect(secondBatch).not.toContain(high);
  });

  test("marks only rows that are still settled and never touches updated_at", async () => {
    const [stable, patched] = await reserveIds(2);
    const t0 = Date.now() - 2 * HOUR;
    await insertRow(stable, new Date(t0));
    await insertRow(patched, new Date(t0));
    const settleCutoff = new Date(t0 + MINUTE);

    // 读取与标记之间落库的补写：updated_at 变为 NOW()
    await db()
      .update(messageRequest)
      .set({ costUsd: "0.3", updatedAt: new Date() })
      .where(eq(messageRequest.id, patched));

    const before = await readRow(stable);
    const marked = await source.markSynced([stable, patched], {
      syncedAt: new Date(),
      settleCutoff,
    });

    expect(marked).toEqual([stable]);
    const after = await readRow(stable);
    expect(after.clickhouseSyncedAt).not.toBeNull();
    expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    expect((await readRow(patched)).clickhouseSyncedAt).toBeNull();

    // 已标记的行不会被再次标记
    await expect(
      source.markSynced([stable], { syncedAt: new Date(), settleCutoff })
    ).resolves.toEqual([]);
  });

  test("skips rows locked by a concurrent writer instead of waiting", async () => {
    const [id] = await reserveIds(1);
    const t0 = Date.now() - 2 * HOUR;
    await insertRow(id, new Date(t0));

    // 用独立连接持锁，模拟另一个进程正在补写这一行（不占用应用连接池）
    const other = postgres(dsn as string, { max: 1 });
    let releaseLock: () => void = () => {};
    let lockHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const holder = other.begin(async (tx) => {
      await tx`SELECT id FROM message_request WHERE id = ${id} FOR UPDATE`;
      lockHeld();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    await held;

    try {
      const marked = await source.markSynced([id], {
        syncedAt: new Date(),
        settleCutoff: new Date(t0 + MINUTE),
      });
      expect(marked).toEqual([]);
    } finally {
      releaseLock();
      await holder;
      await other.end();
    }

    await expect(
      source.markSynced([id], { syncedAt: new Date(), settleCutoff: new Date(t0 + MINUTE) })
    ).resolves.toEqual([id]);
  });

  test("keeps the first persisted floor", async () => {
    const existing = await source.readClickHouseFloor();
    const first = existing ?? new Date("2026-01-01T00:00:00.000Z");

    const stored = await source.writeClickHouseFloorIfAbsent(first);
    const again = await source.writeClickHouseFloorIfAbsent(new Date("2026-06-01T00:00:00.000Z"));

    expect(stored.getTime()).toBe(first.getTime());
    expect(again.getTime()).toBe(first.getTime());
  });

  test("cleanup never deletes an in-scope row before it is marked", async () => {
    const floor = await source.readClickHouseFloor();
    expect(floor).not.toBeNull();
    const floorMs = floor?.getTime() ?? 0;

    const [unsynced, synced, softDeleted, warmup, beforeFloor] = await reserveIds(5);
    const inScope = new Date(Math.max(floorMs + MINUTE, Date.now() - 2 * HOUR));
    await insertRow(unsynced, inScope);
    await insertRow(synced, inScope, { clickhouseSyncedAt: new Date() });
    await insertRow(softDeleted, inScope, { deletedAt: new Date() });
    await insertRow(warmup, inScope, { blockedBy: "warmup" });
    await insertRow(beforeFloor, new Date(floorMs - HOUR));

    const result = await cleanup.cleanupLogs(
      { beforeDate: new Date(), userIds: [USER_ID] },
      {},
      { type: "manual", user: "integration" }
    );
    expect(result.error).toBeUndefined();

    const remaining = await db()
      .select({ id: messageRequest.id })
      .from(messageRequest)
      .where(inArray(messageRequest.id, [unsynced, synced, softDeleted, warmup, beforeFloor]));
    expect(remaining.map((row) => row.id)).toEqual([unsynced]);

    // 标记之后才允许删除
    await source.markSynced([unsynced], { syncedAt: new Date(), settleCutoff: new Date() });
    await cleanup.cleanupLogs(
      { beforeDate: new Date(), userIds: [USER_ID] },
      {},
      { type: "manual", user: "integration" }
    );
    const afterMark = await db()
      .select({ id: messageRequest.id })
      .from(messageRequest)
      .where(eq(messageRequest.id, unsynced));
    expect(afterMark).toHaveLength(0);
  });

  test("the cleanup fence refuses to run before the floor exists", async () => {
    if (hadFloorRow) return;
    const saved = await source.readClickHouseFloor();
    await db().delete(clickhouseSyncState).where(eq(clickhouseSyncState.key, "default"));
    try {
      await expect(syncState.getClickHouseCleanupCondition()).rejects.toBeInstanceOf(
        syncState.SyncStateUnavailableError
      );
    } finally {
      if (saved) await source.writeClickHouseFloorIfAbsent(saved);
    }
  });
});
