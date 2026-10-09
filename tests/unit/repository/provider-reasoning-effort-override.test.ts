import { describe, expect, test } from "vitest";
import type { ReasoningEffortOverrideRule, ServiceTierOverrideRule } from "@/types/provider";
import { toProvider } from "@/repository/_shared/transformers";

const orderedRules: ReasoningEffortOverrideRule[] = [
  {
    when: { originalReasoningEffort: null },
    overrideEffort: "low",
  },
  {
    when: {
      originalModel: { matchType: "exact", pattern: "claude-opus-4-1" },
      executionModel: { matchType: "prefix", pattern: "claude-opus-4-1-" },
    },
    overrideEffort: "high",
  },
];

describe("toProvider reasoning effort override rules", () => {
  test.each([
    ["null", null],
    ["empty", []],
    ["ordered", orderedRules],
  ] satisfies Array<[string, ReasoningEffortOverrideRule[] | null]>)(
    "round-trips the %s stored rule list faithfully",
    (_name, rules) => {
      const provider = toProvider({ reasoningEffortOverrideRules: rules });

      expect(provider.reasoningEffortOverrideRules).toStrictEqual(rules);
    }
  );

  test("preserves an explicit null original effort predicate", () => {
    const provider = toProvider({ reasoningEffortOverrideRules: orderedRules });
    const firstRule = provider.reasoningEffortOverrideRules?.[0];

    expect(firstRule?.when).toHaveProperty("originalReasoningEffort", null);
  });

  test("maps an omitted legacy column to null for fallback behavior", () => {
    const provider = toProvider({});

    expect(provider.reasoningEffortOverrideRules).toBeNull();
  });
});

describe("toProvider service tier override rules", () => {
  const serviceTierRules: ServiceTierOverrideRule[] = [
    { when: { originalServiceTier: null }, overrideServiceTier: "flex" },
    {
      when: { originalModel: { matchType: "prefix", pattern: "gpt-5" } },
      overrideServiceTier: null,
    },
  ];

  test.each([
    ["null", null],
    ["empty", []],
    ["ordered", serviceTierRules],
  ] satisfies Array<[string, ServiceTierOverrideRule[] | null]>)(
    "round-trips the %s stored rule list faithfully",
    (_name, rules) => {
      expect(
        toProvider({ serviceTierOverrideRules: rules }).serviceTierOverrideRules
      ).toStrictEqual(rules);
    }
  );

  test("preserves a null (unset) target", () => {
    const provider = toProvider({ serviceTierOverrideRules: serviceTierRules });
    expect(provider.serviceTierOverrideRules?.[1]).toHaveProperty("overrideServiceTier", null);
  });

  test("maps an omitted column to null for legacy fallback", () => {
    expect(toProvider({}).serviceTierOverrideRules).toBeNull();
  });
});
