import { describe, expect, it } from "vitest";
import {
  convertLegacyAnthropicAdaptiveThinkingToRules,
  convertLegacyCodexReasoningEffortToRules,
  convertLegacyReasoningEffortOverrideToRules,
  evaluateReasoningEffortOverride,
} from "@/lib/reasoning-effort-override";
import type { ReasoningEffortOverrideInput, ReasoningEffortOverrideRule } from "@/types/provider";

const input: ReasoningEffortOverrideInput = {
  originalModel: "claude-opus-4-1",
  executionModel: "claude-opus-4-1-20251001",
  originalReasoningEffort: "low",
};

describe("reasoning effort override evaluator", () => {
  it("returns the first matching ordered rule and its index", () => {
    const rules: readonly ReasoningEffortOverrideRule[] = [
      {
        when: { originalModel: { matchType: "prefix", pattern: "claude" } },
        overrideEffort: "high",
      },
      { when: {}, overrideEffort: "medium" },
    ];

    expect(evaluateReasoningEffortOverride(rules, input)).toEqual({
      shouldOverride: true,
      overriddenEffort: "high",
      matchedIndex: 0,
    });
  });

  it.each([
    ["exact", "claude-opus-4-1"],
    ["prefix", "claude-opus"],
    ["suffix", "4-1"],
    ["contains", "opus"],
    ["regex", "^claude-opus-4-1$"],
  ] as const)("supports case-insensitive %s model predicates", (matchType, pattern) => {
    const rules: readonly ReasoningEffortOverrideRule[] = [
      { when: { originalModel: { matchType, pattern } }, overrideEffort: "high" },
    ];

    expect(
      evaluateReasoningEffortOverride(rules, {
        ...input,
        originalModel: "CLAUDE-OPUS-4-1",
      })
    ).toEqual({
      shouldOverride: true,
      overriddenEffort: "high",
      matchedIndex: 0,
    });
  });

  it("ANDs raw-model, execution-model, and effort predicates", () => {
    const rules: readonly ReasoningEffortOverrideRule[] = [
      {
        when: {
          originalModel: { matchType: "exact", pattern: "claude-opus-4-1" },
          executionModel: { matchType: "prefix", pattern: "claude-opus-4-1-2025" },
          originalReasoningEffort: "low",
        },
        overrideEffort: "xhigh",
      },
    ];

    expect(evaluateReasoningEffortOverride(rules, input)).toEqual({
      shouldOverride: true,
      overriddenEffort: "xhigh",
      matchedIndex: 0,
    });
    expect(
      evaluateReasoningEffortOverride(rules, {
        ...input,
        executionModel: "different-model",
      })
    ).toEqual({
      shouldOverride: false,
      overriddenEffort: null,
    });
    expect(
      evaluateReasoningEffortOverride(
        [{ when: { originalReasoningEffort: null }, overrideEffort: "medium" }],
        { originalReasoningEffort: 42 }
      )
    ).toEqual({
      shouldOverride: true,
      overriddenEffort: "medium",
      matchedIndex: 0,
    });
  });

  it("distinguishes omitted effort predicates from explicit missing-effort predicates", () => {
    const rules: readonly ReasoningEffortOverrideRule[] = [
      { when: { originalReasoningEffort: null }, overrideEffort: "medium" },
      { when: {}, overrideEffort: "high" },
    ];

    expect(
      evaluateReasoningEffortOverride(rules, {
        originalModel: input.originalModel,
        executionModel: input.executionModel,
      })
    ).toEqual({
      shouldOverride: true,
      overriddenEffort: "medium",
      matchedIndex: 0,
    });
    expect(evaluateReasoningEffortOverride(rules, input)).toEqual({
      shouldOverride: true,
      overriddenEffort: "high",
      matchedIndex: 1,
    });
    expect(
      evaluateReasoningEffortOverride(
        [{ when: { originalReasoningEffort: "low" }, overrideEffort: "high" }],
        { originalReasoningEffort: 42 }
      )
    ).toEqual({
      shouldOverride: false,
      overriddenEffort: null,
    });
  });

  it("treats Codex none as a real override target", () => {
    expect(evaluateReasoningEffortOverride([{ when: {}, overrideEffort: "none" }], input)).toEqual({
      shouldOverride: true,
      overriddenEffort: "none",
      matchedIndex: 0,
    });
  });

  it("returns the exact no-match result for absent, malformed, and unknown rules", () => {
    const noMatch = { shouldOverride: false, overriddenEffort: null };

    expect(evaluateReasoningEffortOverride(null, input)).toEqual(noMatch);
    expect(evaluateReasoningEffortOverride([], input)).toEqual(noMatch);
    expect(evaluateReasoningEffortOverride(null, null)).toEqual(noMatch);
    expect(
      evaluateReasoningEffortOverride([{ when: null, overrideEffort: "high" }], input)
    ).toEqual(noMatch);
    expect(
      evaluateReasoningEffortOverride(
        [
          {
            when: { originalModel: { matchType: "unknown", pattern: "text" } },
            overrideEffort: "high",
          },
        ],
        input
      )
    ).toEqual(noMatch);
    expect(evaluateReasoningEffortOverride([{ when: {}, overrideEffort: 42 }], input)).toEqual(
      noMatch
    );
    expect(
      evaluateReasoningEffortOverride([{ when: {}, overrideEffort: "high" }], { originalModel: 42 })
    ).toEqual(noMatch);
    expect(
      evaluateReasoningEffortOverride(
        [
          { when: {}, overrideEffort: "high" },
          { when: null, overrideEffort: "medium" },
        ],
        input
      )
    ).toEqual(noMatch);
  });

  it("does not mutate rules or input while evaluating", () => {
    const rules = [
      {
        when: { originalModel: { matchType: "exact", pattern: "claude-opus-4-1" } },
        overrideEffort: "high",
      },
    ];
    const request = { ...input };
    const rulesSnapshot = structuredClone(rules);
    const requestSnapshot = structuredClone(request);

    evaluateReasoningEffortOverride(rules, request);

    expect(rules).toEqual(rulesSnapshot);
    expect(request).toEqual(requestSnapshot);
  });
});

describe("legacy reasoning effort conversion", () => {
  it("converts a Codex static effort into one catch-all rule", () => {
    expect(convertLegacyCodexReasoningEffortToRules("none")).toEqual([
      { when: {}, overrideEffort: "none" },
    ]);
    expect(convertLegacyCodexReasoningEffortToRules("inherit")).toEqual([]);
  });

  it("selects the appropriate legacy converter from a provider-shaped config", () => {
    expect(
      convertLegacyReasoningEffortOverrideToRules({ codexReasoningEffortPreference: "high" })
    ).toEqual([{ when: {}, overrideEffort: "high" }]);
    expect(
      convertLegacyReasoningEffortOverrideToRules({ anthropicAdaptiveThinking: null })
    ).toEqual([]);
    expect(convertLegacyReasoningEffortOverrideToRules(null)).toEqual([]);
  });

  it("converts Anthropic adaptive all into one catch-all rule", () => {
    expect(
      convertLegacyAnthropicAdaptiveThinkingToRules({
        effort: "max",
        modelMatchMode: "all",
        models: [],
      })
    ).toEqual([{ when: {}, overrideEffort: "max" }]);
  });

  it("converts each Anthropic specific model into adjacent exact and dashed-prefix rules", () => {
    expect(
      convertLegacyAnthropicAdaptiveThinkingToRules({
        effort: "high",
        modelMatchMode: "specific",
        models: ["claude-opus-4-1", "claude-sonnet-4-1"],
      })
    ).toEqual([
      {
        when: { originalModel: { matchType: "exact", pattern: "claude-opus-4-1" } },
        overrideEffort: "high",
      },
      {
        when: { originalModel: { matchType: "prefix", pattern: "claude-opus-4-1-" } },
        overrideEffort: "high",
      },
      {
        when: { originalModel: { matchType: "exact", pattern: "claude-sonnet-4-1" } },
        overrideEffort: "high",
      },
      {
        when: { originalModel: { matchType: "prefix", pattern: "claude-sonnet-4-1-" } },
        overrideEffort: "high",
      },
    ]);
    expect(
      convertLegacyAnthropicAdaptiveThinkingToRules({
        effort: "high",
        modelMatchMode: "specific",
        models: [],
      })
    ).toEqual([]);
  });
});
