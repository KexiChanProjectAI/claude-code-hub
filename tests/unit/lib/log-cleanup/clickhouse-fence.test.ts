import { isNotNull, type SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/** 渲染 drizzle SQL 对象：值走参数绑定，所以围栏要在 params 里找 */
function renderSql(sqlObject: unknown): { sql: string; params: unknown[] } {
  return (sqlObject as SQL).toQuery({
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (num: number) => `$${num}`,
    escapeString: (value: string) => `'${value}'`,
    casing: new CasingCache(),
    paramStartIndex: { value: 1 },
  });
}

const getFenceMock = vi.fn();

vi.mock("@/drizzle/db", () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/clickhouse/sync-state", () => ({
  getClickHouseCleanupCondition: (...args: unknown[]) => getFenceMock(...args),
}));

/** 与真实围栏同形的条件：按行上的同步标记放行，而不是 id 上限 */
async function syncedCondition(): Promise<SQL> {
  const { messageRequest } = await import("@/drizzle/schema");
  return isNotNull(messageRequest.clickhouseSyncedAt);
}

/**
 * 日志清理与 ClickHouse 同步的联动：
 * 只有已经同步出去的行才允许从 PostgreSQL 删除。
 */
describe("log cleanup ClickHouse fence", () => {
  beforeEach(async () => {
    const { db } = await import("@/drizzle/db");
    (db.execute as MockInstance).mockReset();
    getFenceMock.mockResolvedValue(null);
  });

  async function runCleanup() {
    const { cleanupLogs } = await import("@/lib/log-cleanup/service");
    return cleanupLogs({ beforeDate: new Date() }, {}, { type: "scheduled" });
  }

  it("leaves the delete unfenced when sync is disabled", async () => {
    const { db } = await import("@/drizzle/db");
    (db.execute as MockInstance).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await runCleanup();

    expect(result.error).toBeUndefined();
    expect(getFenceMock).toHaveBeenCalledTimes(1);
  });

  it("adds the sync-marker fence to every delete statement when sync is enabled", async () => {
    const { db } = await import("@/drizzle/db");
    getFenceMock.mockResolvedValue(await syncedCondition());
    (db.execute as MockInstance).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await runCleanup();

    expect(result.error).toBeUndefined();
    // 主删除 + 软删除清理，两条语句都必须带上围栏
    expect((db.execute as MockInstance).mock.calls).toHaveLength(2);
    for (const call of (db.execute as MockInstance).mock.calls) {
      const rendered = renderSql(call[0]);
      expect(rendered.sql).toContain('"clickhouse_synced_at" is not null');
      expect(rendered.sql).not.toContain('"id" <=');
    }
  });

  it("aborts the cleanup when sync progress is unknown", async () => {
    const { db } = await import("@/drizzle/db");
    getFenceMock.mockRejectedValue(new Error("sync progress is unknown"));

    const result = await runCleanup();

    expect(result.error).toContain("ClickHouse sync fence unavailable");
    expect(result.totalDeleted).toBe(0);
    // 关键：一条删除语句都不能发出去
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("never turns an empty condition set into a fence-only delete", async () => {
    const { db } = await import("@/drizzle/db");
    getFenceMock.mockResolvedValue(await syncedCondition());

    const { cleanupLogs } = await import("@/lib/log-cleanup/service");
    const result = await cleanupLogs({}, {}, { type: "scheduled" });

    expect(result.error).toBe("No cleanup conditions specified");
    expect(db.execute).not.toHaveBeenCalled();
    // 围栏本身不是删除条件，条件为空时甚至不应该去查它
    expect(getFenceMock).not.toHaveBeenCalled();
  });

  it("applies the fence to dry-run estimates as well", async () => {
    const { db } = await import("@/drizzle/db");
    getFenceMock.mockResolvedValue(await syncedCondition());

    const where = vi.fn().mockResolvedValue([{ count: 7 }]);
    const from = vi.fn().mockReturnValue({ where });
    (db.select as MockInstance).mockReturnValue({ from });

    const { cleanupLogs } = await import("@/lib/log-cleanup/service");
    const result = await cleanupLogs(
      { beforeDate: new Date() },
      { dryRun: true },
      { type: "manual", user: "admin" }
    );

    expect(result.totalDeleted).toBe(7);
    expect(renderSql(where.mock.calls[0][0]).sql).toContain('"clickhouse_synced_at" is not null');
  });
});
