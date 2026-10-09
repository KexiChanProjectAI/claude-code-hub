import { describe, expect, it } from "vitest";
import {
  CODEX_SERVICE_TIER_OVERRIDE_TARGETS,
  convertLegacyCodexServiceTierToRules,
  evaluateServiceTierOverride,
  isCodexServiceTierOverrideTarget,
  isServiceTierOverrideRuleTarget,
} from "@/lib/service-tier-override";
import type { ServiceTierOverrideRule } from "@/types/provider";

const input = (overrides: Record<string, unknown> = {}) => ({
  originalModel: "gpt-5-codex",
  executionModel: "gpt-5-codex",
  originalServiceTier: null,
  ...overrides,
});

describe("service tier targets", () => {
  it("lists the four concrete tiers", () => {
    expect(CODEX_SERVICE_TIER_OVERRIDE_TARGETS).toEqual(["auto", "default", "flex", "priority"]);
  });

  it("accepts concrete tiers and rejects inherit, empty and unknown values", () => {
    for (const tier of CODEX_SERVICE_TIER_OVERRIDE_TARGETS) {
      expect(isCodexServiceTierOverrideTarget(tier)).toBe(true);
    }
    for (const value of ["inherit", "", "turbo", null, undefined, 1]) {
      expect(isCodexServiceTierOverrideTarget(value)).toBe(false);
    }
  });

  it("allows null as a rule target meaning unset", () => {
    expect(isServiceTierOverrideRuleTarget(null)).toBe(true);
    expect(isServiceTierOverrideRuleTarget("flex")).toBe(true);
    expect(isServiceTierOverrideRuleTarget("")).toBe(false);
    expect(isServiceTierOverrideRuleTarget(undefined)).toBe(false);
  });
});

describe("evaluateServiceTierOverride", () => {
  it("returns no match for null, empty, or non-object input", () => {
    const noMatch = { shouldOverride: false, overriddenServiceTier: null };
    expect(evaluateServiceTierOverride(null, input())).toEqual(noMatch);
    expect(evaluateServiceTierOverride([], input())).toEqual(noMatch);
    expect(evaluateServiceTierOverride([{ when: {}, overrideServiceTier: "flex" }], null)).toEqual(
      noMatch
    );
  });

  it("returns the first match, including a null (unset) target", () => {
    const rules: ServiceTierOverrideRule[] = [
      {
        when: { originalModel: { matchType: "prefix", pattern: "gpt-5" } },
        overrideServiceTier: null,
      },
      { when: {}, overrideServiceTier: "priority" },
    ];
    expect(evaluateServiceTierOverride(rules, input())).toEqual({
      shouldOverride: true,
      overriddenServiceTier: null,
      matchedIndex: 0,
    });
    expect(evaluateServiceTierOverride(rules, input({ originalModel: "o3" }))).toEqual({
      shouldOverride: true,
      overriddenServiceTier: "priority",
      matchedIndex: 1,
    });
  });

  it("matches originalServiceTier any / missing / exact", () => {
    const rules: ServiceTierOverrideRule[] = [
      { when: { originalServiceTier: "priority" }, overrideServiceTier: "default" },
      { when: { originalServiceTier: null }, overrideServiceTier: "flex" },
      { when: {}, overrideServiceTier: "auto" },
    ];
    expect(
      evaluateServiceTierOverride(rules, input({ originalServiceTier: "priority" }))
    ).toMatchObject({ overriddenServiceTier: "default", matchedIndex: 0 });
    expect(evaluateServiceTierOverride(rules, input())).toMatchObject({
      overriddenServiceTier: "flex",
      matchedIndex: 1,
    });
    expect(
      evaluateServiceTierOverride(rules, input({ originalServiceTier: "flex" }))
    ).toMatchObject({ overriddenServiceTier: "auto", matchedIndex: 2 });
  });

  it.each([[""], ["turbo"], ["inherit"]])(
    "treats a list containing invalid target %j as non-matching",
    (target) => {
      const rules = [
        { when: {}, overrideServiceTier: "flex" },
        { when: {}, overrideServiceTier: target },
      ];
      expect(evaluateServiceTierOverride(rules, input()).shouldOverride).toBe(false);
    }
  );

  it("rejects reasoning-effort keys inside a service tier rule", () => {
    const rules = [{ when: { originalReasoningEffort: "high" }, overrideServiceTier: "flex" }];
    expect(evaluateServiceTierOverride(rules, input()).shouldOverride).toBe(false);
  });
});

describe("convertLegacyCodexServiceTierToRules", () => {
  it("converts a concrete legacy tier to a catch-all rule", () => {
    expect(convertLegacyCodexServiceTierToRules("priority")).toEqual([
      { when: {}, overrideServiceTier: "priority" },
    ]);
  });

  it.each([["inherit"], [null], [undefined], ["turbo"]])(
    "returns an empty list for %j",
    (value) => {
      expect(convertLegacyCodexServiceTierToRules(value)).toEqual([]);
    }
  );
});
