import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ChainCall {
  method: string;
  args: unknown[];
}

/**
 * Drizzle query builder 替身：每个链式方法都返回自身，并且整体是 thenable，
 * 所以无论查询以 .limit() 还是 .orderBy() 收尾都能被 await。
 *
 * 用 vi.hoisted 构造：vi.mock 的工厂会被提升到文件顶部，普通模块级变量在那时还没初始化。
 */
const stub = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const state: { rows: unknown[]; executeResults: unknown[] } = { rows: [], executeResults: [] };
  const chain: Record<string, unknown> = {};

  for (const method of [
    "select",
    "from",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
    "insert",
    "values",
    "onConflictDoNothing",
  ]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: thenable 就是这里要模拟的 drizzle 行为
  chain.then = (resolve: (value: unknown) => unknown) => resolve(state.rows);
  chain.execute = (...args: unknown[]) => {
    calls.push({ method: "execute", args });
    return Promise.resolve(state.executeResults.shift() ?? []);
  };

  return { calls, state, chain };
});

vi.mock("@/drizzle/db", () => ({ db: stub.chain }));

import {
  fetchUnsyncedBatch,
  markSynced,
  readClickHouseFloor,
  writeClickHouseFloorIfAbsent,
} from "@/lib/clickhouse/source";

function renderSql(sqlObject: unknown): { sql: string; params: unknown[] } {
  return (sqlObject as SQL).toQuery({
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (num: number) => `$${num}`,
    escapeString: (value: string) => `'${value}'`,
    casing: new CasingCache(),
    paramStartIndex: { value: 1 },
  });
}

function callsOf(method: string): ChainCall[] {
  return stub.calls.filter((call) => call.method === method);
}

function setRows(rows: unknown[]): void {
  stub.state.rows = rows;
}

function makeRow(id: number) {
  return { id, createdAt: new Date(), statusCode: 200 };
}

/** 渲染后的 SQL 压成一行，便于断言 */
function flat(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

const FLOOR = new Date("2026-09-01T00:00:00.000Z");
const SETTLE = new Date("2026-09-26T11:57:30.000Z");
const ORPHAN = new Date("2026-09-26T11:00:00.000Z");

function fetchParams(limit = 10) {
  return { floor: FLOOR, settleCutoff: SETTLE, orphanCutoff: ORPHAN, limit };
}

beforeEach(() => {
  stub.calls.length = 0;
  stub.state.executeResults = [];
  setRows([]);
});

describe("select column list", () => {
  it("never selects the raw API key column", async () => {
    await fetchUnsyncedBatch(fetchParams());

    const selected = callsOf("select")[0].args[0] as Record<string, unknown>;
    expect(Object.keys(selected)).not.toContain("key");
    expect(Object.keys(selected)).toContain("keyId");
    expect(Object.keys(selected)).toContain("keyName");
    expect(Object.keys(selected)).toContain("clientIp");
    expect(Object.keys(selected)).toContain("model");
  });

  it("left joins users, keys and providers so blocked and deleted rows survive", async () => {
    await fetchUnsyncedBatch(fetchParams());
    expect(callsOf("leftJoin")).toHaveLength(3);
  });
});

describe("fetchUnsyncedBatch", () => {
  it("selects by the per-row sync marker, never by an id cursor", async () => {
    await fetchUnsyncedBatch(fetchParams());

    const where = flat(renderSql(callsOf("where")[0].args[0]).sql);
    expect(where).toContain('"clickhouse_synced_at" is null');
    expect(where).not.toContain('"id" >');
  });

  it("excludes soft-deleted rows and warmup probes", async () => {
    await fetchUnsyncedBatch(fetchParams());

    const where = renderSql(callsOf("where")[0].args[0]).sql;
    expect(where).toContain('"deleted_at" is null');
    expect(where).toContain("warmup");
  });

  it("scopes to the floor, the settle cutoff and the orphan escape hatch", async () => {
    await fetchUnsyncedBatch(fetchParams());

    const rendered = renderSql(callsOf("where")[0].args[0]);
    const where = flat(rendered.sql);
    expect(where).toContain('"created_at" >=');
    expect(where).toContain('"updated_at" <=');
    expect(where).toMatch(
      /\("message_request"\."status_code" is not null or "message_request"\."created_at" < \$\d+\)/
    );
    expect(rendered.params).toEqual(
      expect.arrayContaining([FLOOR.toISOString(), SETTLE.toISOString(), ORPHAN.toISOString()])
    );
  });

  it("orders by (created_at, id) to follow the partial index, with the requested limit", async () => {
    await fetchUnsyncedBatch(fetchParams(250));

    const order = callsOf("orderBy")[0].args.map((arg) => flat(renderSql(arg).sql));
    expect(order).toEqual(['"message_request"."created_at" asc', '"message_request"."id" asc']);
    expect(callsOf("limit")[0].args[0]).toBe(250);
  });

  it("collapses duplicates produced by the key-string join", async () => {
    setRows([makeRow(1), makeRow(1), makeRow(2)]);

    const rows = await fetchUnsyncedBatch(fetchParams());

    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });
});

describe("markSynced", () => {
  const syncedAt = new Date("2026-09-26T12:00:00.000Z");

  it("does nothing for an empty id list", async () => {
    await expect(markSynced([], { syncedAt, settleCutoff: SETTLE })).resolves.toEqual([]);
    expect(callsOf("execute")).toHaveLength(0);
  });

  it("marks only unmarked rows that are still settled, in id order, skipping locked rows", async () => {
    stub.state.executeResults = [[{ id: 7 }]];

    const marked = await markSynced([7, 9], { syncedAt, settleCutoff: SETTLE });

    const rendered = renderSql(callsOf("execute")[0].args[0]);
    const text = flat(rendered.sql);
    expect(text).toContain("clickhouse_synced_at IS NULL");
    expect(text).toMatch(/updated_at <= \$\d+::timestamptz/);
    expect(text).toContain("ORDER BY id FOR UPDATE SKIP LOCKED");
    expect(text).toMatch(/SET clickhouse_synced_at = \$\d+::timestamptz/);
    expect(text).toContain("RETURNING m.id");
    expect(rendered.params).toEqual(
      expect.arrayContaining([7, 9, SETTLE.toISOString(), syncedAt.toISOString()])
    );
    expect(marked).toEqual([7]);
  });

  it("never touches updated_at, the ClickHouse version column", async () => {
    await markSynced([1], { syncedAt, settleCutoff: SETTLE });

    const text = flat(renderSql(callsOf("execute")[0].args[0]).sql);
    const setClause = text.slice(text.indexOf(" SET "), text.indexOf(" FROM target"));
    expect(setClause).toContain("clickhouse_synced_at =");
    expect(setClause).not.toContain("updated_at");
  });

  it("chunks large id lists and collects every marked id", async () => {
    const ids = Array.from({ length: 2500 }, (_, index) => index + 1);
    stub.state.executeResults = [[{ id: 1 }], [{ id: "1001" }], [{ id: 2001 }]];

    const marked = await markSynced(ids, { syncedAt, settleCutoff: SETTLE });

    // 2500 个 id -> 1000/1000/500 三条语句
    expect(callsOf("execute")).toHaveLength(3);
    const lastParams = renderSql(callsOf("execute")[2].args[0]).params;
    expect(lastParams.filter((param) => typeof param === "number")).toHaveLength(500);
    expect(marked).toEqual([1, 1001, 2001]);
  });
});

describe("sync scope floor", () => {
  it("reads the persisted floor", async () => {
    setRows([{ floorAt: FLOOR }]);
    await expect(readClickHouseFloor()).resolves.toEqual(FLOOR);
  });

  it("returns null before initialization", async () => {
    setRows([]);
    await expect(readClickHouseFloor()).resolves.toBeNull();
  });

  it("writes only when absent and returns what the database holds", async () => {
    // 另一个 leader 抢先写入了更早的下界：以库里的值为准
    setRows([{ floorAt: FLOOR }]);

    const floor = await writeClickHouseFloorIfAbsent(new Date("2026-09-20T00:00:00.000Z"));

    expect(callsOf("onConflictDoNothing")).toHaveLength(1);
    expect(floor).toEqual(FLOOR);
  });
});
