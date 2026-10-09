import { evaluateConditionalOverrideRules, isRecord } from "@/lib/conditional-override-rules";
import type {
  AnthropicAdaptiveThinkingEffort,
  AnthropicAdaptiveThinkingModelMatchMode,
  CodexReasoningEffortPreference,
  ReasoningEffortOverrideResult,
  ReasoningEffortOverrideRule,
} from "@/types/provider";

const NO_MATCH: ReasoningEffortOverrideResult = {
  shouldOverride: false,
  overriddenEffort: null,
};

const REASONING_EFFORT_RULE_SPEC = {
  originalValueKey: "originalReasoningEffort",
  targetKey: "overrideEffort",
  isTarget: (value: unknown): value is string => typeof value === "string",
} as const;

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function evaluateReasoningEffortOverride(
  rules: unknown,
  input: unknown
): ReasoningEffortOverrideResult {
  const match = evaluateConditionalOverrideRules(
    rules,
    isRecord(input)
      ? {
          originalModel: input.originalModel,
          executionModel: input.executionModel,
          originalValue: input.originalReasoningEffort,
        }
      : null,
    REASONING_EFFORT_RULE_SPEC
  );
  if (!match) {
    return NO_MATCH;
  }

  return {
    shouldOverride: true,
    overriddenEffort: match.target,
    matchedIndex: match.matchedIndex,
  };
}

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffortPreference {
  switch (value) {
    case "inherit":
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return true;
    default:
      return false;
  }
}

function isAnthropicAdaptiveThinkingEffort(
  value: unknown
): value is AnthropicAdaptiveThinkingEffort {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return true;
    default:
      return false;
  }
}

function isAnthropicAdaptiveThinkingModelMatchMode(
  value: unknown
): value is AnthropicAdaptiveThinkingModelMatchMode {
  return value === "specific" || value === "all";
}

export function convertLegacyCodexReasoningEffortToRules(
  effort: unknown
): ReasoningEffortOverrideRule[] {
  if (!isCodexReasoningEffort(effort) || effort === "inherit") {
    return [];
  }

  return [{ when: {}, overrideEffort: effort }];
}

export function convertLegacyAnthropicAdaptiveThinkingToRules(
  config: unknown
): ReasoningEffortOverrideRule[] {
  if (!isRecord(config)) {
    return [];
  }

  const effort = config.effort;
  const modelMatchMode = config.modelMatchMode;
  const models = config.models;
  if (
    !isAnthropicAdaptiveThinkingEffort(effort) ||
    !isAnthropicAdaptiveThinkingModelMatchMode(modelMatchMode) ||
    !Array.isArray(models) ||
    !models.every((model) => typeof model === "string")
  ) {
    return [];
  }

  if (modelMatchMode === "all") {
    return [{ when: {}, overrideEffort: effort }];
  }

  return models.flatMap((model) => [
    {
      when: { originalModel: { matchType: "exact", pattern: model } },
      overrideEffort: effort,
    },
    {
      when: { originalModel: { matchType: "prefix", pattern: `${model}-` } },
      overrideEffort: effort,
    },
  ]);
}

export function convertLegacyReasoningEffortOverrideToRules(
  config: unknown
): ReasoningEffortOverrideRule[] {
  if (!isRecord(config)) {
    return [];
  }

  if (hasOwn(config, "codexReasoningEffortPreference")) {
    return convertLegacyCodexReasoningEffortToRules(config.codexReasoningEffortPreference);
  }

  if (hasOwn(config, "anthropicAdaptiveThinking")) {
    return convertLegacyAnthropicAdaptiveThinkingToRules(config.anthropicAdaptiveThinking);
  }

  return [];
}
