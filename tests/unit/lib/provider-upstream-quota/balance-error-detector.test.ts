import { describe, expect, test } from "vitest";
import { detectUpstreamQuotaExhausted } from "@/lib/provider-upstream-quota/balance-error-detector";
import { buildUpstreamQuotaProbeOptions } from "@/lib/provider-upstream-quota/options";

describe("detectUpstreamQuotaExhausted", () => {
  test("402 always counts", () => {
    expect(detectUpstreamQuotaExhausted(402)).toBe("reactive_402");
  });

  test.each([
    '{"error":{"message":"余额不足，请充值"}}',
    '{"error":{"type":"insufficient_credit"}}',
    "Insufficient Balance",
    "your balance is not enough",
    "no enough balance",
  ])("429 with balance wording counts: %s", (body) => {
    expect(detectUpstreamQuotaExhausted(429, body)).toBe("reactive_429_balance");
  });

  test("429 reads the parsed body too", () => {
    expect(
      detectUpstreamQuotaExhausted(429, "", { error: { message: "Insufficient balance" } })
    ).toBe("reactive_429_balance");
    expect(detectUpstreamQuotaExhausted(429, undefined, "insufficient_balance")).toBe(
      "reactive_429_balance"
    );
  });

  test("plain rate limits and other statuses do not count", () => {
    expect(detectUpstreamQuotaExhausted(429, '{"error":{"message":"Rate limit exceeded"}}')).toBe(
      null
    );
    expect(detectUpstreamQuotaExhausted(429)).toBe(null);
    expect(detectUpstreamQuotaExhausted(500, "insufficient balance")).toBe(null);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(detectUpstreamQuotaExhausted(429, "", circular)).toBe(null);
  });
});

describe("buildUpstreamQuotaProbeOptions", () => {
  test("returns null without an organization", () => {
    expect(buildUpstreamQuotaProbeOptions("", "proj")).toBeNull();
    expect(buildUpstreamQuotaProbeOptions(null, undefined)).toBeNull();
  });

  test("trims values and omits an empty project", () => {
    expect(buildUpstreamQuotaProbeOptions(" org-1 ", " ")).toEqual({ zhipuOrganization: "org-1" });
    expect(buildUpstreamQuotaProbeOptions("org-1", "proj-1")).toEqual({
      zhipuOrganization: "org-1",
      zhipuProject: "proj-1",
    });
  });
});
