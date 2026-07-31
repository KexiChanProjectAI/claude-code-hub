import { matchesPattern } from "@/lib/model-pattern-matcher";
import type {
  AnthropicAdaptiveThinkingEffort,
  AnthropicAdaptiveThinkingModelMatchMode,
  CodexReasoningEffortPreference,
  ProviderModelRedirectMatchType,
  ReasoningEffortOverrideInput,
  ReasoningEffortOverrideModelPredicate,
  ReasoningEffortOverrideResult,
  ReasoningEffortOverrideRule,
} from "@/types/provider";

const NO_MATCH: ReasoningEffortOverrideResult = {
  shouldOverride: false,
  overriddenEffort: null,
};

const INVALID = Symbol("invalid");

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isModelMatchType(value: unknown): value is ProviderModelRedirectMatchType {
  switch (value) {
    case "exact":
    case "prefix":
    case "suffix":
    case "contains":
    case "regex":
      return true;
    default:
      return false;
  }
}

function isModelPredicate(value: unknown): value is ReasoningEffortOverrideModelPredicate {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.every((key) => key === "matchType" || key === "pattern") &&
    hasOwn(value, "matchType") &&
    hasOwn(value, "pattern") &&
    isModelMatchType(value.matchType) &&
    typeof value.pattern === "string"
  );
}

function isReasoningEffortOverrideRule(value: unknown): value is ReasoningEffortOverrideRule {
  if (!isRecord(value) || !hasOwn(value, "when") || !hasOwn(value, "overrideEffort")) {
    return false;
  }

  if (typeof value.overrideEffort !== "string" || !isRecord(value.when)) {
    return false;
  }

  const when = value.when;
  if (
    !Object.keys(when).every(
      (key) =>
        key === "originalModel" || key === "executionModel" || key === "originalReasoningEffort"
    )
  ) {
    return false;
  }

  if (hasOwn(when, "originalModel") && !isModelPredicate(when.originalModel)) {
    return false;
  }

  if (hasOwn(when, "executionModel") && !isModelPredicate(when.executionModel)) {
    return false;
  }

  return (
    !hasOwn(when, "originalReasoningEffort") ||
    when.originalReasoningEffort === null ||
    typeof when.originalReasoningEffort === "string"
  );
}

function normalizeModel(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) {
    return null;
  }

  return typeof value === "string" ? value : INVALID;
}

function normalizeInput(value: unknown): ReasoningEffortOverrideInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const originalModel = normalizeModel(value.originalModel);
  const executionModel = normalizeModel(value.executionModel);
  if (originalModel === INVALID || executionModel === INVALID) {
    return null;
  }

  return {
    originalModel,
    executionModel,
    originalReasoningEffort:
      typeof value.originalReasoningEffort === "string" ? value.originalReasoningEffort : null,
  };
}

function matchesModelPredicate(
  value: string | null,
  predicate: ReasoningEffortOverrideModelPredicate
): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return matchesPattern(value, predicate.matchType, predicate.pattern);
}

function matchesRule(
  rule: ReasoningEffortOverrideRule,
  input: ReasoningEffortOverrideInput
): boolean {
  const when = rule.when;
  if (when.originalModel && !matchesModelPredicate(input.originalModel, when.originalModel)) {
    return false;
  }

  if (when.executionModel && !matchesModelPredicate(input.executionModel, when.executionModel)) {
    return false;
  }

  if (
    hasOwn(when, "originalReasoningEffort") &&
    when.originalReasoningEffort !== input.originalReasoningEffort
  ) {
    return false;
  }

  return true;
}

export function evaluateReasoningEffortOverride(
  rules: unknown,
  input: unknown
): ReasoningEffortOverrideResult {
  const normalizedInput = normalizeInput(input);
  if (!Array.isArray(rules) || rules.length === 0 || !normalizedInput) {
    return NO_MATCH;
  }

  const validRules = rules.filter((candidate): candidate is ReasoningEffortOverrideRule =>
    isReasoningEffortOverrideRule(candidate)
  );
  if (validRules.length !== rules.length) {
    return NO_MATCH;
  }

  for (const [index, rule] of validRules.entries()) {
    if (matchesRule(rule, normalizedInput)) {
      return {
        shouldOverride: true,
        overriddenEffort: rule.overrideEffort,
        matchedIndex: index,
      };
    }
  }

  return NO_MATCH;
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
