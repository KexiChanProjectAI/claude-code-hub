import { describe, expect, it } from "vitest";
import {
  type ConditionalOverrideRuleSpec,
  evaluateConditionalOverrideRules,
  isConditionalModelPredicate,
  isConditionalOverrideRule,
} from "@/lib/conditional-override-rules";

const SPEC: ConditionalOverrideRuleSpec<string | null> = {
  originalValueKey: "originalThing",
  targetKey: "overrideThing",
  isTarget: (value: unknown): value is string | null =>
    value === null || value === "a" || value === "b",
};

const input = (overrides: Record<string, unknown> = {}) => ({
  originalModel: "gpt-5-codex",
  executionModel: "gpt-5-codex-exec",
  originalValue: null,
  ...overrides,
});

describe("isConditionalModelPredicate", () => {
  it("accepts a well-formed predicate", () => {
    expect(isConditionalModelPredicate({ matchType: "prefix", pattern: "gpt-" })).toBe(true);
  });

  it.each([
    null,
    "gpt",
    [],
    { matchType: "glob", pattern: "gpt" },
    { matchType: "exact" },
    { pattern: "gpt" },
    { matchType: "exact", pattern: 1 },
    { matchType: "exact", pattern: "gpt", extra: true },
  ])("rejects %j", (value) => {
    expect(isConditionalModelPredicate(value)).toBe(false);
  });
});

describe("isConditionalOverrideRule", () => {
  it("accepts rules keyed by the spec", () => {
    expect(isConditionalOverrideRule({ when: {}, overrideThing: "a" }, SPEC)).toBe(true);
    expect(isConditionalOverrideRule({ when: {}, overrideThing: null }, SPEC)).toBe(true);
    expect(
      isConditionalOverrideRule({ when: { originalThing: null }, overrideThing: "b" }, SPEC)
    ).toBe(true);
    expect(
      isConditionalOverrideRule({ when: { originalThing: "x" }, overrideThing: "b" }, SPEC)
    ).toBe(true);
  });

  it.each([
    [{ overrideThing: "a" }],
    [{ when: {} }],
    [{ when: {}, overrideThing: "zzz" }],
    [{ when: [], overrideThing: "a" }],
    [{ when: { originalReasoningEffort: "x" }, overrideThing: "a" }],
    [{ when: { originalThing: 1 }, overrideThing: "a" }],
    [{ when: { originalModel: { matchType: "exact" } }, overrideThing: "a" }],
    [{ when: { executionModel: "gpt" }, overrideThing: "a" }],
  ])("rejects malformed rule %j", (rule) => {
    expect(isConditionalOverrideRule(rule, SPEC)).toBe(false);
  });
});

describe("evaluateConditionalOverrideRules", () => {
  it("returns null for empty, non-array or malformed inputs", () => {
    expect(evaluateConditionalOverrideRules([], input(), SPEC)).toBeNull();
    expect(evaluateConditionalOverrideRules(null, input(), SPEC)).toBeNull();
    expect(evaluateConditionalOverrideRules({}, input(), SPEC)).toBeNull();
    expect(
      evaluateConditionalOverrideRules([{ when: {}, overrideThing: "a" }], null, SPEC)
    ).toBeNull();
    expect(
      evaluateConditionalOverrideRules(
        [{ when: {}, overrideThing: "a" }],
        input({ originalModel: 1 }),
        SPEC
      )
    ).toBeNull();
    expect(
      evaluateConditionalOverrideRules(
        [{ when: {}, overrideThing: "a" }],
        input({ executionModel: {} }),
        SPEC
      )
    ).toBeNull();
  });

  it("treats a list with any malformed rule as non-matching", () => {
    const rules = [
      { when: {}, overrideThing: "a" },
      { when: {}, overrideThing: "not-a-target" },
    ];
    expect(evaluateConditionalOverrideRules(rules, input(), SPEC)).toBeNull();
  });

  it("returns the first matching rule's target and index", () => {
    const rules = [
      { when: { originalModel: { matchType: "exact", pattern: "other" } }, overrideThing: "a" },
      { when: { originalModel: { matchType: "prefix", pattern: "GPT-5" } }, overrideThing: null },
      { when: {}, overrideThing: "b" },
    ];
    expect(evaluateConditionalOverrideRules(rules, input(), SPEC)).toEqual({
      matchedIndex: 1,
      target: null,
    });
  });

  it("requires every predicate in when to match", () => {
    const rules = [
      {
        when: {
          originalModel: { matchType: "exact", pattern: "gpt-5-codex" },
          executionModel: { matchType: "suffix", pattern: "-other" },
        },
        overrideThing: "a",
      },
    ];
    expect(evaluateConditionalOverrideRules(rules, input(), SPEC)).toBeNull();
  });

  it("does not match model predicates when the input model is missing", () => {
    const rules = [
      { when: { executionModel: { matchType: "contains", pattern: "gpt" } }, overrideThing: "a" },
    ];
    expect(
      evaluateConditionalOverrideRules(rules, input({ executionModel: undefined }), SPEC)
    ).toBeNull();
  });

  it("distinguishes omitted, null and exact original-value conditions", () => {
    const rules = [
      { when: { originalThing: "x" }, overrideThing: "a" },
      { when: { originalThing: null }, overrideThing: "b" },
      { when: {}, overrideThing: null },
    ];
    expect(evaluateConditionalOverrideRules(rules, input({ originalValue: "x" }), SPEC)).toEqual({
      matchedIndex: 0,
      target: "a",
    });
    expect(evaluateConditionalOverrideRules(rules, input(), SPEC)).toEqual({
      matchedIndex: 1,
      target: "b",
    });
    expect(evaluateConditionalOverrideRules(rules, input({ originalValue: "y" }), SPEC)).toEqual({
      matchedIndex: 2,
      target: null,
    });
  });

  it("normalizes a non-string original value to null", () => {
    const rules = [{ when: { originalThing: null }, overrideThing: "a" }];
    expect(evaluateConditionalOverrideRules(rules, input({ originalValue: 5 }), SPEC)).toEqual({
      matchedIndex: 0,
      target: "a",
    });
  });
});
