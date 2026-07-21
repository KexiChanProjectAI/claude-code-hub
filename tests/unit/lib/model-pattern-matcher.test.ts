import { describe, expect, it } from "vitest";
import { matchesPattern } from "@/lib/model-pattern-matcher";
import type { ProviderModelRedirectMatchType } from "@/types/provider";

describe("matchesPattern", () => {
  it.each<[ProviderModelRedirectMatchType, string, string, boolean]>([
    ["exact", "claude-opus-4-1", "claude-opus-4-1", true],
    ["exact", "claude-opus-4-1", "claude-opus-4-2", false],
    ["prefix", "claude-opus", "claude-opus-4-1", true],
    ["prefix", "gpt", "claude-opus-4-1", false],
    ["suffix", "20251001", "claude-opus-4-1-20251001", true],
    ["suffix", "20251002", "claude-opus-4-1-20251001", false],
    ["contains", "opus", "claude-opus-4-1", true],
    ["contains", "sonnet", "claude-opus-4-1", false],
    ["regex", "^claude-(opus|sonnet)-4", "claude-opus-4-1", true],
    ["regex", "^gpt-", "claude-opus-4-1", false],
  ])("supports %s matching", (matchType, pattern, model, expected) => {
    expect(matchesPattern(model, matchType, pattern)).toBe(expected);
  });

  it("returns false for invalid regex patterns instead of throwing", () => {
    expect(matchesPattern("claude-opus-4-1", "regex", "[")).toBe(false);
  });

  describe("case-insensitive matching", () => {
    it.each<[ProviderModelRedirectMatchType, string, string, boolean]>([
      ["exact", "Xunfei/Kimi-K2.5", "xunfei/kimi-k2.5", true],
      ["exact", "KIMI-K2.5", "kimi-k2.6", false],
      ["prefix", "Moonshot/", "moonshot/kimi-k3", true],
      ["prefix", "MOONSHOT/", "moonshot/kimi-k3", true],
      ["suffix", "K2.5", "xunfei/kimi-k2.5", true],
      ["suffix", "K2.6", "xunfei/kimi-k2.5", false],
      ["contains", "OPUS", "claude-opus-4-1", true],
      ["regex", "^GPT-5", "gpt-5.5", true],
      ["regex", "^GPT-4", "gpt-5.5", false],
    ])(
      "matches %s pattern %s against %s ignoring case -> %s",
      (matchType, pattern, model, expected) => {
        expect(matchesPattern(model, matchType, pattern)).toBe(expected);
      }
    );

    it("glob fallback is also case-insensitive", () => {
      expect(matchesPattern("claude-opus-4-1", "regex", "CLAUDE-*")).toBe(true);
      expect(matchesPattern("gpt-4", "regex", "CLAUDE-*")).toBe(false);
    });
  });

  describe("glob fallback for regex matching", () => {
    it.each<[string, string, boolean]>([
      ["*", "claude-opus-4-1", true],
      ["*", "", true],
      // 锚定 glob 后 `*.` 表示“以 . 结尾”，不再匹配子串中带点的 "claude.opus"。
      ["*.", "claude.opus", false],
      ["*.", "claude.opus.", true],
      ["*.", "claudeopus", false],
      ["claude-*", "claude-opus-4-1", true],
      ["claude-*", "gpt-4", false],
      ["*-opus-*", "claude-opus-4-1", true],
      ["*-opus-*", "claude-sonnet-4-1", false],
    ])("regex pattern %s matches %s -> %s via glob fallback", (pattern, model, expected) => {
      expect(matchesPattern(model, "regex", pattern)).toBe(expected);
    });
  });
});
