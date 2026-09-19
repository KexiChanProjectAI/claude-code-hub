import { describe, expect, it } from "vitest";
import {
  normalizeIpForClickHouse,
  type SyncSourceRow,
  toClickHouseRow,
} from "@/lib/clickhouse/row-mapper";

function makeRow(overrides: Partial<SyncSourceRow> = {}): SyncSourceRow {
  return {
    id: 1,
    createdAt: new Date("2026-09-19T10:00:00.000Z"),
    updatedAt: new Date("2026-09-19T10:00:05.000Z"),
    userId: 7,
    userName: "alice",
    keyId: 3,
    keyName: "laptop",
    clientIp: "203.0.113.9",
    userAgent: "claude-cli/1.2.3",
    model: "claude-sonnet-5",
    originalModel: "claude-sonnet-5",
    actualResponseModel: "claude-sonnet-5",
    providerId: 11,
    providerName: "anthropic",
    endpoint: "/v1/messages",
    apiType: "messages",
    sessionId: "sess-1",
    requestSequence: 2,
    isReplay: false,
    statusCode: 200,
    blockedBy: null,
    durationMs: 1234,
    ttftMs: 321,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 5,
    costUsd: "0.001234500000000",
    errorMessage: null,
    ...overrides,
  };
}

describe("normalizeIpForClickHouse", () => {
  it("maps IPv4 into the IPv4-mapped IPv6 form", () => {
    expect(normalizeIpForClickHouse("203.0.113.9")).toBe("::ffff:203.0.113.9");
  });

  it("passes IPv6 through unchanged", () => {
    expect(normalizeIpForClickHouse("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIpForClickHouse("::ffff:127.0.0.1")).toBe("::ffff:127.0.0.1");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeIpForClickHouse("  203.0.113.9  ")).toBe("::ffff:203.0.113.9");
  });

  it("falls back to :: for empty and malformed values", () => {
    expect(normalizeIpForClickHouse(null)).toBe("::");
    expect(normalizeIpForClickHouse(undefined)).toBe("::");
    expect(normalizeIpForClickHouse("")).toBe("::");
    expect(normalizeIpForClickHouse("unknown")).toBe("::");
    expect(normalizeIpForClickHouse("999.1.1.1")).toBe("::");
  });
});

describe("toClickHouseRow", () => {
  it("maps a fully populated row", () => {
    const row = toClickHouseRow(makeRow());

    expect(row).toMatchObject({
      id: 1,
      created_at: "2026-09-19T10:00:00.000Z",
      updated_at: "2026-09-19T10:00:05.000Z",
      user_id: 7,
      user_name: "alice",
      key_id: 3,
      key_name: "laptop",
      client_ip: "::ffff:203.0.113.9",
      model: "claude-sonnet-5",
      provider_id: 11,
      provider_name: "anthropic",
      endpoint: "/v1/messages",
      status_code: 200,
      is_replay: 0,
      duration_ms: 1234,
      input_tokens: 100,
      cost_usd: "0.001234500000000",
    });
  });

  it("never carries the raw API key", () => {
    // SyncSourceRow 本身就不含 key 字段；这里锁死输出列集合，
    // 避免后续有人把 message_request.key 加进 SELECT 后被一路带到 ClickHouse。
    const row = toClickHouseRow(makeRow());
    expect(Object.keys(row)).not.toContain("key");
    expect(JSON.stringify(row)).not.toContain("sk-");
  });

  it("folds nulls into the column zero values", () => {
    const row = toClickHouseRow(
      makeRow({
        userName: null,
        keyId: null,
        keyName: null,
        clientIp: null,
        userAgent: null,
        model: null,
        originalModel: null,
        actualResponseModel: null,
        providerName: null,
        endpoint: null,
        apiType: null,
        sessionId: null,
        requestSequence: null,
        statusCode: null,
        blockedBy: null,
        durationMs: null,
        ttftMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        costUsd: null,
        errorMessage: null,
      })
    );

    expect(row).toMatchObject({
      user_name: "",
      key_id: 0,
      key_name: "",
      client_ip: "::",
      user_agent: "",
      model: "",
      endpoint: "",
      session_id: "",
      request_sequence: 0,
      status_code: 0,
      blocked_by: "",
      duration_ms: 0,
      input_tokens: 0,
      cost_usd: "0",
      error_message: "",
    });
  });

  it("marks replay rows and keeps blocked_by", () => {
    const row = toClickHouseRow(makeRow({ isReplay: true, blockedBy: "sensitive_word" }));
    expect(row.is_replay).toBe(1);
    expect(row.blocked_by).toBe("sensitive_word");
  });

  it("keeps cost as a string so numeric precision survives", () => {
    const row = toClickHouseRow(makeRow({ costUsd: "123.000000000000001" }));
    expect(row.cost_usd).toBe("123.000000000000001");
    expect(typeof row.cost_usd).toBe("string");
  });

  it("rejects non-numeric cost values", () => {
    expect(toClickHouseRow(makeRow({ costUsd: "NaN" })).cost_usd).toBe("0");
    expect(toClickHouseRow(makeRow({ costUsd: "1e5" })).cost_usd).toBe("0");
    expect(toClickHouseRow(makeRow({ costUsd: "-1.5" })).cost_usd).toBe("-1.5");
  });

  it("truncates oversized text fields", () => {
    const row = toClickHouseRow(
      makeRow({
        userAgent: "u".repeat(900),
        errorMessage: "e".repeat(9000),
        sessionId: "s".repeat(200),
      })
    );

    expect((row.user_agent as string).length).toBe(512);
    expect((row.error_message as string).length).toBe(4096);
    expect((row.session_id as string).length).toBe(64);
  });

  it("clamps negative and non-finite numerics to zero", () => {
    const row = toClickHouseRow(
      makeRow({ durationMs: -5, ttftMs: Number.NaN, inputTokens: -1, requestSequence: 0 })
    );

    expect(row.duration_ms).toBe(0);
    expect(row.ttft_ms).toBe(0);
    expect(row.input_tokens).toBe(0);
    expect(row.request_sequence).toBe(0);
  });

  it("falls back to the epoch when timestamps are missing or invalid", () => {
    const row = toClickHouseRow(makeRow({ createdAt: null, updatedAt: new Date(Number.NaN) }));

    expect(row.created_at).toBe("1970-01-01T00:00:00.000Z");
    expect(row.updated_at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("omits synced_at so ClickHouse fills its DEFAULT now()", () => {
    expect(Object.keys(toClickHouseRow(makeRow()))).not.toContain("synced_at");
  });
});
