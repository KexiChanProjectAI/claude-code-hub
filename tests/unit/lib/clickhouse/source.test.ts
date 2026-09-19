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
  const state: { rows: unknown[] } = { rows: [] };
  const chain: Record<string, unknown> = {};

  for (const method of ["select", "from", "leftJoin", "where", "orderBy", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: thenable 就是这里要模拟的 drizzle 行为
  chain.then = (resolve: (value: unknown) => unknown) => resolve(state.rows);

  return { calls, state, chain };
});

vi.mock("@/drizzle/db", () => ({ db: stub.chain }));

import { fetchBatchAfter, fetchByIds, findCursorBefore, getMaxId } from "@/lib/clickhouse/source";

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

beforeEach(() => {
  stub.calls.length = 0;
  setRows([]);
});

describe("select column list", () => {
  it("never selects the raw API key column", async () => {
    await fetchBatchAfter(0, 10);

    const selected = callsOf("select")[0].args[0] as Record<string, unknown>;
    expect(Object.keys(selected)).not.toContain("key");
    expect(Object.keys(selected)).toContain("keyId");
    expect(Object.keys(selected)).toContain("keyName");
    expect(Object.keys(selected)).toContain("clientIp");
    expect(Object.keys(selected)).toContain("model");
  });

  it("left joins users, keys and providers so blocked and deleted rows survive", async () => {
    await fetchBatchAfter(0, 10);
    expect(callsOf("leftJoin")).toHaveLength(3);
  });
});

describe("fetchBatchAfter", () => {
  it("pages by id with the requested batch size", async () => {
    await fetchBatchAfter(500, 250);

    const where = renderSql(callsOf("where")[0].args[0]);
    expect(where.params).toContain(500);
    expect(where.sql).toContain('"id" >');
    expect(callsOf("limit")[0].args[0]).toBe(250);
  });

  it("excludes soft-deleted rows and warmup probes", async () => {
    await fetchBatchAfter(0, 10);

    const where = renderSql(callsOf("where")[0].args[0]).sql;
    expect(where).toContain('"deleted_at" is null');
    expect(where).toContain("warmup");
  });

  it("orders ascending so the cursor advances monotonically", async () => {
    await fetchBatchAfter(0, 10);
    expect(renderSql(callsOf("orderBy")[0].args[0]).sql).toContain("asc");
  });

  it("collapses duplicates produced by the key-string join", async () => {
    setRows([makeRow(1), makeRow(1), makeRow(2)]);

    const rows = await fetchBatchAfter(0, 10);

    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });
});

describe("fetchByIds", () => {
  it("short-circuits without touching the database", async () => {
    const rows = await fetchByIds([]);

    expect(rows).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it("looks up the requested ids", async () => {
    setRows([makeRow(7)]);

    const rows = await fetchByIds([7, 9]);

    const where = renderSql(callsOf("where")[0].args[0]);
    expect(where.params).toEqual(expect.arrayContaining([7, 9]));
    expect(rows.map((row) => row.id)).toEqual([7]);
  });

  it("chunks large id lists so the bind parameter limit is never hit", async () => {
    setRows([makeRow(1)]);
    const ids = Array.from({ length: 2500 }, (_, index) => index + 1);

    const rows = await fetchByIds(ids);

    // 2500 个 id -> 1000/1000/500 三条查询
    expect(callsOf("where")).toHaveLength(3);
    expect(renderSql(callsOf("where")[0].args[0]).params).toHaveLength(1000);
    expect(renderSql(callsOf("where")[2].args[0]).params).toHaveLength(500);
    // 每个分片都返回同一行，去重后只剩一条
    expect(rows.map((row) => row.id)).toEqual([1]);
  });
});

describe("getMaxId", () => {
  it("returns the current tail", async () => {
    setRows([{ maxId: 1234 }]);
    await expect(getMaxId()).resolves.toBe(1234);
  });

  it("coerces the driver's string output", async () => {
    setRows([{ maxId: "1234" }]);
    await expect(getMaxId()).resolves.toBe(1234);
  });

  it("returns 0 for an empty table", async () => {
    setRows([]);
    await expect(getMaxId()).resolves.toBe(0);
  });
});

describe("findCursorBefore", () => {
  it("returns the id just before the first row at or after the given time", async () => {
    setRows([{ minId: 500 }]);

    await expect(findCursorBefore(new Date("2026-09-19T00:00:00Z"))).resolves.toBe(499);
  });

  it("returns 0 when nothing matches", async () => {
    setRows([{ minId: 0 }]);
    await expect(findCursorBefore(new Date())).resolves.toBe(0);
  });
});
