import { describe, expect, test } from "vitest";
import {
  detectUpstreamQuotaProbeTypeFromUrl,
  isConcreteUpstreamQuotaProbeType,
  isKnownCnPlatformHost,
  isUpstreamQuotaTrackedProvider,
  resolveUpstreamQuotaProbeType,
} from "@/lib/provider-upstream-quota/detect";

describe("detectUpstreamQuotaProbeTypeFromUrl", () => {
  test.each([
    ["https://api.kimi.com/coding/v1", "kimi-coding"],
    ["https://api.kimi.com/coding", "kimi-coding"],
    ["https://open.bigmodel.cn/api/coding/paas/v4", "zhipu-coding"],
    ["https://open.bigmodel.cn/api/anthropic", "zhipu-coding"],
    ["https://api.z.ai/api/coding/paas/v4", "zhipu-coding"],
    ["https://api.z.ai/api/anthropic", "zhipu-coding"],
    ["https://open.bigmodel.cn/api/paas/v4", "none"],
    ["https://api.minimaxi.com/anthropic", "minimax-coding"],
    ["https://api.minimax.io/v1", "minimax-coding"],
    ["https://opencode.ai/zen/go/v1", "opencode-go"],
    ["https://opencode.ai/zen/v1", "none"],
    ["https://api.moonshot.cn/v1", "none"],
    ["https://api.deepseek.com", "none"],
    ["https://relay.example.com/v1", "none"],
    ["not a url", "none"],
  ])("%s -> %s", (url, expected) => {
    expect(detectUpstreamQuotaProbeTypeFromUrl(url)).toBe(expected);
  });
});

describe("resolveUpstreamQuotaProbeType", () => {
  test("auto falls back to URL detection", () => {
    expect(
      resolveUpstreamQuotaProbeType({
        url: "https://api.kimi.com/coding/v1",
        upstreamQuotaProbeType: "auto",
      })
    ).toBe("kimi-coding");
    expect(resolveUpstreamQuotaProbeType({ url: "https://api.kimi.com/coding/v1" })).toBe(
      "kimi-coding"
    );
  });

  test("explicit types override the URL and none disables", () => {
    expect(
      resolveUpstreamQuotaProbeType({
        url: "https://relay.example.com",
        upstreamQuotaProbeType: "minimax-coding",
      })
    ).toBe("minimax-coding");
    expect(
      resolveUpstreamQuotaProbeType({
        url: "https://api.kimi.com/coding/v1",
        upstreamQuotaProbeType: "none",
      })
    ).toBe("none");
  });

  test("unknown configured values resolve to none", () => {
    expect(
      resolveUpstreamQuotaProbeType({
        url: "https://api.kimi.com/coding/v1",
        upstreamQuotaProbeType: "bogus" as never,
      })
    ).toBe("none");
    expect(isConcreteUpstreamQuotaProbeType("zhipu-coding")).toBe(true);
    expect(isConcreteUpstreamQuotaProbeType("auto")).toBe(false);
  });
});

describe("isKnownCnPlatformHost / isUpstreamQuotaTrackedProvider", () => {
  test("recognizes official CN platform hosts including pay-as-you-go ones", () => {
    expect(isKnownCnPlatformHost("https://api.moonshot.cn/v1")).toBe(true);
    expect(isKnownCnPlatformHost("https://api.deepseek.com")).toBe(true);
    expect(isKnownCnPlatformHost("https://open.bigmodel.cn/api/paas/v4")).toBe(true);
    expect(isKnownCnPlatformHost("https://evil-bigmodel.cn.example.com")).toBe(false);
    expect(isKnownCnPlatformHost("https://api.anthropic.com")).toBe(false);
    expect(isKnownCnPlatformHost("::")).toBe(false);
  });

  test("tracks probe-capable or CN hosts unless explicitly disabled", () => {
    expect(isUpstreamQuotaTrackedProvider({ url: "https://api.deepseek.com" })).toBe(true);
    expect(isUpstreamQuotaTrackedProvider({ url: "https://relay.example.com" })).toBe(false);
    expect(
      isUpstreamQuotaTrackedProvider({
        url: "https://relay.example.com",
        upstreamQuotaProbeType: "kimi-coding",
      })
    ).toBe(true);
    expect(
      isUpstreamQuotaTrackedProvider({
        url: "https://api.deepseek.com",
        upstreamQuotaProbeType: "none",
      })
    ).toBe(false);
  });
});
