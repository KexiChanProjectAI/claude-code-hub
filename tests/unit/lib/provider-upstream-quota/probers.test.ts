import { beforeEach, describe, expect, test, vi } from "vitest";

const proxyMocks = vi.hoisted(() => ({
  createProxyAgentForProvider: vi.fn(() => null as unknown),
  fetchWithDispatcher: vi.fn(),
}));
vi.mock("@/lib/proxy-agent", () => proxyMocks);

import {
  buildKimiCodingUsageUrl,
  kimiCodingProber,
  parseKimiCodingUsage,
} from "@/lib/provider-upstream-quota/probers/kimi-coding";
import {
  buildMiniMaxRemainsUrl,
  miniMaxCodingProber,
  parseMiniMaxRemains,
} from "@/lib/provider-upstream-quota/probers/minimax-coding";
import {
  buildOpenCodeGoUsageUrl,
  openCodeGoProber,
  parseOpenCodeGoUsage,
} from "@/lib/provider-upstream-quota/probers/opencode-go";
import { parseResetTime, toFiniteNumber } from "@/lib/provider-upstream-quota/probers/http";
import {
  buildZhipuQuotaUrl,
  parseZhipuQuotaLimits,
  zhipuCodingProber,
} from "@/lib/provider-upstream-quota/probers/zhipu-coding";
import { UPSTREAM_QUOTA_PROBERS } from "@/lib/provider-upstream-quota/probers";
import type { UpstreamQuotaProbeTarget } from "@/lib/provider-upstream-quota/types";

function target(overrides: Partial<UpstreamQuotaProbeTarget> = {}): UpstreamQuotaProbeTarget {
  return {
    id: 7,
    name: "p7",
    url: "https://api.kimi.com/coding/v1",
    key: "sk-test",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    upstreamQuotaProbeType: "auto",
    upstreamQuotaProbeOptions: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall() {
  const call = proxyMocks.fetchWithDispatcher.mock.calls.at(-1) as unknown as [
    string,
    RequestInit & { dispatcher?: unknown },
  ];
  return { url: call[0], init: call[1], headers: call[1].headers as Record<string, string> };
}

beforeEach(() => {
  vi.clearAllMocks();
  proxyMocks.createProxyAgentForProvider.mockReturnValue(null);
});

describe("http helpers", () => {
  test("parseResetTime accepts seconds, milliseconds and ISO strings", () => {
    expect(parseResetTime(1_800_000_000)).toBe(1_800_000_000_000);
    expect(parseResetTime(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(parseResetTime("1800000000")).toBe(1_800_000_000_000);
    expect(parseResetTime("2027-01-01T00:00:00Z")).toBe(Date.parse("2027-01-01T00:00:00Z"));
    expect(parseResetTime("garbage")).toBeNull();
    expect(parseResetTime(0)).toBeNull();
    expect(parseResetTime(undefined)).toBeNull();
    expect(toFiniteNumber("12.5")).toBe(12.5);
    expect(toFiniteNumber(Number.NaN)).toBeNull();
    expect(toFiniteNumber("")).toBeNull();
  });

  test("registry exposes one prober per concrete type", () => {
    expect(Object.keys(UPSTREAM_QUOTA_PROBERS).sort()).toEqual([
      "kimi-coding",
      "minimax-coding",
      "opencode-go",
      "zhipu-coding",
    ]);
  });
});

describe("Kimi coding prober", () => {
  test("builds the usages URL", () => {
    expect(buildKimiCodingUsageUrl("https://api.kimi.com/coding/v1")).toBe(
      "https://api.kimi.com/coding/v1/usages"
    );
    expect(buildKimiCodingUsageUrl("https://relay.example.com/kimi")).toBe(
      "https://relay.example.com/coding/v1/usages"
    );
    expect(buildKimiCodingUsageUrl("bad url")).toBe("https://api.kimi.com/coding/v1/usages");
  });

  test("parses 5h and weekly windows", () => {
    const windows = parseKimiCodingUsage({
      limits: [{ detail: { limit: "100", remaining: "25", resetTime: "2027-01-01T00:00:00Z" } }],
      usage: { limit: 1000, remaining: 900, resetTime: 1_800_000_000 },
    });
    expect(windows).toEqual([
      { window: "5h", usedPercent: 75, resetAt: Date.parse("2027-01-01T00:00:00Z") },
      { window: "weekly", usedPercent: 10, resetAt: 1_800_000_000_000 },
    ]);
    expect(parseKimiCodingUsage({ limits: [{ detail: { limit: 0, remaining: 0 } }] })).toEqual([]);
    expect(parseKimiCodingUsage(null)).toEqual([]);
  });

  test("sends a bearer token and maps success", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValue(
      jsonResponse({ usage: { limit: 10, remaining: 5, resetTime: 1_800_000_000 } })
    );
    const result = await kimiCodingProber.probe(
      target({ customHeaders: { "X-Extra": "1", Authorization: "ignored" } })
    );
    expect(result).toEqual({
      ok: true,
      windows: [{ window: "weekly", usedPercent: 50, resetAt: 1_800_000_000_000 }],
      planLevel: null,
    });
    const { url, init, headers } = lastCall();
    expect(url).toBe("https://api.kimi.com/coding/v1/usages");
    expect(init.method).toBe("GET");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["X-Extra"]).toBe("1");
  });

  test("maps 401 to credential_invalid with the upstream message", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValue(
      jsonResponse({ error: { message: "invalid key" } }, 401)
    );
    expect(await kimiCodingProber.probe(target())).toEqual({
      ok: false,
      kind: "credential_invalid",
      statusCode: 401,
      message: "invalid key",
    });
  });

  test("maps 402, 5xx, non-JSON and network failures", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(jsonResponse({ msg: "pay" }, 402));
    expect(await kimiCodingProber.probe(target())).toMatchObject({
      ok: false,
      kind: "insufficient_balance",
      message: "pay",
    });

    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    expect(await kimiCodingProber.probe(target())).toMatchObject({
      ok: false,
      kind: "http_error",
      statusCode: 503,
      message: "boom",
    });

    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await kimiCodingProber.probe(target())).toMatchObject({ ok: false, kind: "parse" });

    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(jsonResponse([1, 2]));
    expect(await kimiCodingProber.probe(target())).toMatchObject({ ok: false, kind: "parse" });

    proxyMocks.fetchWithDispatcher.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await kimiCodingProber.probe(target())).toMatchObject({
      ok: false,
      kind: "network",
      message: "ECONNRESET",
    });

    const abort = new Error("aborted");
    abort.name = "AbortError";
    proxyMocks.fetchWithDispatcher.mockRejectedValueOnce(abort);
    expect(await kimiCodingProber.probe(target())).toMatchObject({
      ok: false,
      kind: "network",
      message: expect.stringContaining("timeout"),
    });
  });

  test("uses the proxy dispatcher and falls back to direct when allowed", async () => {
    const agent = { tag: "agent" };
    proxyMocks.createProxyAgentForProvider.mockReturnValue({ agent, fallbackToDirect: true });
    proxyMocks.fetchWithDispatcher
      .mockRejectedValueOnce(new Error("proxy down"))
      .mockResolvedValueOnce(jsonResponse({ usage: { limit: 10, remaining: 10 } }));
    const result = await kimiCodingProber.probe(target({ proxyUrl: "http://proxy:8080" }));
    expect(result.ok).toBe(true);
    const calls = proxyMocks.fetchWithDispatcher.mock.calls as unknown as Array<
      [string, { dispatcher?: unknown }]
    >;
    expect(calls[0][1].dispatcher).toBe(agent);
    expect(calls[1][1].dispatcher).toBeUndefined();
  });

  test("does not fall back to direct when the proxy forbids it", async () => {
    proxyMocks.createProxyAgentForProvider.mockReturnValue({ agent: {}, fallbackToDirect: false });
    proxyMocks.fetchWithDispatcher.mockRejectedValueOnce(new Error("proxy down"));
    expect(await kimiCodingProber.probe(target({ proxyUrl: "http://proxy:8080" }))).toMatchObject({
      ok: false,
      kind: "network",
    });
    expect(proxyMocks.fetchWithDispatcher).toHaveBeenCalledTimes(1);
  });

  test("reports body read failures as network errors", async () => {
    const response = jsonResponse({});
    vi.spyOn(response, "text").mockRejectedValue(new Error("stream broke"));
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(response);
    expect(await kimiCodingProber.probe(target())).toMatchObject({
      ok: false,
      kind: "network",
      statusCode: 200,
      message: "stream broke",
    });
  });
});

describe("Zhipu coding prober", () => {
  test("builds host-specific URLs and team query", () => {
    expect(
      buildZhipuQuotaUrl({
        url: "https://open.bigmodel.cn/api/anthropic",
        upstreamQuotaProbeOptions: null,
      })
    ).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(
      buildZhipuQuotaUrl({ url: "https://api.z.ai/api/anthropic", upstreamQuotaProbeOptions: null })
    ).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(
      buildZhipuQuotaUrl({
        url: "https://relay.example.com/glm",
        upstreamQuotaProbeOptions: { zhipuOrganization: "org" },
      })
    ).toBe("https://relay.example.com/api/monitor/usage/quota/limit?type=2");
  });

  test("prefers TOKENS_LIMIT and maps units", () => {
    const parsed = parseZhipuQuotaLimits({
      success: true,
      data: {
        level: "pro",
        limits: [
          { type: "TIME_LIMIT", percentage: 99, unit: 5 },
          { type: "CREDIT_LIMIT", percentage: 80, unit: 3, nextResetTime: 1_800_000_000_000 },
          { type: "TOKENS_LIMIT", percentage: 12, unit: 6, nextResetTime: 1_800_100_000_000 },
          { type: "TOKENS_LIMIT", percentage: 40, unit: 3, nextResetTime: 1_800_000_000_000 },
        ],
      },
    });
    expect(parsed).toEqual({
      planLevel: "pro",
      windows: [
        { window: "5h", usedPercent: 40, resetAt: 1_800_000_000_000 },
        { window: "weekly", usedPercent: 12, resetAt: 1_800_100_000_000 },
      ],
    });
  });

  test("falls back to CREDIT_LIMIT and assigns unknown units by reset order", () => {
    const parsed = parseZhipuQuotaLimits({
      data: {
        limits: [
          { type: "CREDIT_LIMIT", percentage: 20, unit: 9, nextResetTime: 2_000 },
          { type: "CREDIT_LIMIT", percentage: 70, unit: 9, nextResetTime: 1_000 },
          { type: "CREDIT_LIMIT", percentage: 5, unit: 9, nextResetTime: 3_000 },
          { type: "CREDIT_LIMIT", unit: 3 },
        ],
      },
    });
    expect(parsed.windows.map((w) => [w.window, w.usedPercent])).toEqual([
      ["5h", 70],
      ["weekly", 20],
    ]);
    expect(parseZhipuQuotaLimits({})).toEqual({ windows: [], planLevel: null });
  });

  test("sends the raw key, language and team headers", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValue(
      jsonResponse({ success: true, data: { limits: [] } })
    );
    const result = await zhipuCodingProber.probe(
      target({
        url: "https://open.bigmodel.cn/api/anthropic",
        upstreamQuotaProbeOptions: { zhipuOrganization: " org-1 ", zhipuProject: "proj-1" },
      })
    );
    expect(result).toEqual({ ok: true, windows: [], planLevel: null });
    const { url, headers } = lastCall();
    expect(url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
    expect(headers.Authorization).toBe("sk-test");
    expect(headers["Accept-Language"]).toBe("en-US,en");
    expect(headers["bigmodel-organization"]).toBe("org-1");
    expect(headers["bigmodel-project"]).toBe("proj-1");
  });

  test("maps success=false to errors", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(
      jsonResponse({ success: false, code: 1001, msg: "token invalid" })
    );
    expect(
      await zhipuCodingProber.probe(target({ url: "https://open.bigmodel.cn/api/anthropic" }))
    ).toMatchObject({
      ok: false,
      kind: "credential_invalid",
      message: "token invalid",
    });
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(
      jsonResponse({ success: false, code: 500 })
    );
    expect(
      await zhipuCodingProber.probe(target({ url: "https://open.bigmodel.cn/api/anthropic" }))
    ).toMatchObject({
      ok: false,
      kind: "http_error",
      message: "Zhipu quota query failed",
    });
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(jsonResponse("[]"));
    expect(await zhipuCodingProber.probe(target())).toMatchObject({ ok: false, kind: "parse" });
  });
});

describe("MiniMax coding prober", () => {
  test("chooses the international host for minimax.io", () => {
    expect(buildMiniMaxRemainsUrl("https://api.minimax.io/anthropic")).toBe(
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains"
    );
    expect(buildMiniMaxRemainsUrl("https://api.minimaxi.com/anthropic")).toBe(
      "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"
    );
  });

  test("parses the general model entry and optional weekly window", () => {
    expect(
      parseMiniMaxRemains({
        model_remains: [
          { model_name: "video", current_interval_remaining_percent: 1 },
          {
            model_name: "general",
            current_interval_remaining_percent: 70,
            end_time: 1_800_000_000_000,
            current_weekly_status: 1,
            current_weekly_remaining_percent: 95,
            weekly_end_time: 1_800_500_000_000,
            current_subscribe_title: "Max",
          },
        ],
      })
    ).toEqual({
      planLevel: "Max",
      windows: [
        { window: "5h", usedPercent: 30, resetAt: 1_800_000_000_000 },
        { window: "weekly", usedPercent: 5, resetAt: 1_800_500_000_000 },
      ],
    });
    expect(
      parseMiniMaxRemains({
        model_remains: [
          { model_name: "other", current_interval_remaining_percent: 10, current_weekly_status: 0 },
        ],
      }).windows
    ).toEqual([{ window: "5h", usedPercent: 90, resetAt: null }]);
    expect(parseMiniMaxRemains({})).toEqual({ windows: [], planLevel: null });
  });

  test("maps base_resp errors", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(
      jsonResponse({ base_resp: { status_code: 1004, status_msg: "auth failed" } })
    );
    expect(
      await miniMaxCodingProber.probe(target({ url: "https://api.minimaxi.com/anthropic" }))
    ).toMatchObject({
      ok: false,
      kind: "credential_invalid",
      message: "auth failed",
    });
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(
      jsonResponse({ base_resp: { status_code: 2013 } })
    );
    expect(
      await miniMaxCodingProber.probe(target({ url: "https://api.minimaxi.com/anthropic" }))
    ).toMatchObject({
      ok: false,
      kind: "http_error",
      message: "MiniMax status_code 2013",
    });
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(
      jsonResponse({
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: "general", current_interval_remaining_percent: 50 }],
      })
    );
    expect(
      await miniMaxCodingProber.probe(target({ url: "https://api.minimaxi.com/anthropic" }))
    ).toMatchObject({
      ok: true,
      windows: [{ window: "5h", usedPercent: 50 }],
    });
    expect(lastCall().headers.Authorization).toBe("Bearer sk-test");
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(jsonResponse("[]"));
    expect(await miniMaxCodingProber.probe(target())).toMatchObject({ ok: false, kind: "parse" });
  });
});

describe("OpenCode Go prober", () => {
  test("derives the usage URL from the base URL", () => {
    expect(buildOpenCodeGoUsageUrl("https://opencode.ai/zen/go/v1/")).toBe(
      "https://opencode.ai/zen/go/v1/usage"
    );
    expect(buildOpenCodeGoUsageUrl("https://opencode.ai/zen/go/v1/chat/completions")).toBe(
      "https://opencode.ai/zen/go/v1/usage"
    );
  });

  test("parses rolling, weekly and monthly windows", () => {
    expect(
      parseOpenCodeGoUsage({
        usage: {
          rolling: { percent: 10, resetsAt: "2027-01-01T00:00:00Z" },
          weekly: { percent: "55", resets_at: 1_800_000_000 },
          monthly: { resetsAt: 1 },
        },
      })
    ).toEqual([
      { window: "rolling", usedPercent: 10, resetAt: Date.parse("2027-01-01T00:00:00Z") },
      { window: "weekly", usedPercent: 55, resetAt: 1_800_000_000_000 },
    ]);
    expect(parseOpenCodeGoUsage({})).toEqual([]);
  });

  test("probes with a bearer token", async () => {
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(
      jsonResponse({ usage: { weekly: { percent: 30 } } })
    );
    expect(await openCodeGoProber.probe(target({ url: "https://opencode.ai/zen/go/v1" }))).toEqual({
      ok: true,
      windows: [{ window: "weekly", usedPercent: 30, resetAt: null }],
      planLevel: null,
    });
    expect(lastCall().url).toBe("https://opencode.ai/zen/go/v1/usage");
    proxyMocks.fetchWithDispatcher.mockResolvedValueOnce(jsonResponse("[]"));
    expect(await openCodeGoProber.probe(target())).toMatchObject({ ok: false, kind: "parse" });
  });
});
