import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickHouseError, exec, insertJsonEachRow, queryJson } from "@/lib/clickhouse/client";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";

const config: ClickHouseConfig = {
  url: "http://clickhouse:8123",
  user: "cch",
  password: "secret",
  database: "logs",
  table: "cch_request_log",
  requestTimeoutMs: 5000,
  syncIntervalMs: 5000,
  syncBatchSize: 100,
  syncSettleMs: 150000,
  maxPendingAgeMs: 3600000,
};

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse(body = ""): Response {
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
}

describe("exec", () => {
  it("posts the statement as the request body", async () => {
    await exec(config, "CREATE DATABASE IF NOT EXISTS logs");

    const [url, init] = lastCall();
    expect(url).toBe("http://clickhouse:8123/?database=logs");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("CREATE DATABASE IF NOT EXISTS logs");
  });

  it("sends credentials via ClickHouse headers", async () => {
    await exec(config, "SELECT 1");

    const headers = lastCall()[1].headers as Record<string, string>;
    expect(headers["X-ClickHouse-User"]).toBe("cch");
    expect(headers["X-ClickHouse-Key"]).toBe("secret");
  });

  it("omits the key header when no password is configured", async () => {
    await exec({ ...config, password: "" }, "SELECT 1");

    const headers = lastCall()[1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty("X-ClickHouse-Key");
  });

  it("throws ClickHouseError carrying the HTTP status and body", async () => {
    // 每次调用都要新建 Response：body 只能被读取一次
    fetchMock.mockImplementation(
      async () => new Response("Code: 60. Unknown table", { status: 404 })
    );

    await expect(exec(config, "SELECT 1")).rejects.toMatchObject({
      name: "ClickHouseError",
      status: 404,
    });
    await expect(exec(config, "SELECT 1")).rejects.toThrow(/Unknown table/);
  });

  it("reports transport failures with status 0", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const error = await exec(config, "SELECT 1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClickHouseError);
    expect((error as ClickHouseError).status).toBe(0);
    expect((error as ClickHouseError).message).toMatch(/ECONNREFUSED/);
  });

  it("passes an abort signal derived from the request timeout", async () => {
    await exec(config, "SELECT 1");
    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("queryJson", () => {
  it("parses JSONEachRow output line by line", async () => {
    fetchMock.mockResolvedValue(okResponse('{"a":1}\n{"a":2}\n'));

    const rows = await queryJson<{ a: number }>(config, "SELECT a FROM t");

    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(lastCall()[0]).toContain("default_format=JSONEachRow");
  });

  it("returns an empty array for an empty result", async () => {
    fetchMock.mockResolvedValue(okResponse("\n"));
    await expect(queryJson(config, "SELECT 1")).resolves.toEqual([]);
  });
});

describe("insertJsonEachRow", () => {
  it("sends newline-delimited JSON with an INSERT query parameter", async () => {
    await insertJsonEachRow(config, "logs.cch_request_log", [{ id: 1 }, { id: 2 }]);

    const [url, init] = lastCall();
    expect(url).toContain("query=INSERT+INTO+logs.cch_request_log+FORMAT+JSONEachRow");
    expect(url).toContain("date_time_input_format=best_effort");
    expect(init.body).toBe('{"id":1}\n{"id":2}');
  });

  it("skips the HTTP call entirely when there is nothing to write", async () => {
    await insertJsonEachRow(config, "logs.cch_request_log", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates insert failures so the caller can hold the cursor", async () => {
    fetchMock.mockResolvedValue(new Response("Code: 241. Memory limit", { status: 500 }));

    await expect(
      insertJsonEachRow(config, "logs.cch_request_log", [{ id: 1 }])
    ).rejects.toMatchObject({ status: 500 });
  });
});
