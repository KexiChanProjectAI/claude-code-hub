import { describe, expect, test } from "vitest";
import type { ReasoningEffortOverrideRule } from "@/types/provider";
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
