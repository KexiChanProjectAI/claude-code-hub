import { matchesPattern } from "@/lib/model-pattern-matcher";
import type {
  ProviderModelRedirectMatchType,
  ReasoningEffortOverrideModelPredicate,
} from "@/types/provider";

/**
 * Shared engine for provider-level conditional override rules.
 *
 * A rule has the shape `{ when: {...}, [targetKey]: TTarget }`, where `when` may contain:
 * - originalModel: model predicate against the raw intake model
 * - executionModel: model predicate against the post-redirect model
 * - [originalValueKey]: omitted = any value; null = client sent no value; string = exact match
 *
 * Rules are evaluated in order and the first match wins. If any rule in the list is malformed,
 * the whole list is treated as non-matching (all-or-nothing), so a partially corrupted config
 * can never silently apply a lower-priority rule.
 */
export type ConditionalOverrideRuleSpec<TTarget> = {
  readonly originalValueKey: string;
  readonly targetKey: string;
  readonly isTarget: (value: unknown) => value is TTarget;
};

export type ConditionalOverrideRuleInput = {
  readonly originalModel: string | null;
  readonly executionModel: string | null;
  readonly originalValue: string | null;
};

export type ConditionalOverrideRuleMatch<TTarget> = {
  readonly matchedIndex: number;
  readonly target: TTarget;
};

const INVALID = Symbol("invalid");

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
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

export function isConditionalModelPredicate(
  value: unknown
): value is ReasoningEffortOverrideModelPredicate {
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

export function isConditionalOverrideRule<TTarget>(
  value: unknown,
  spec: ConditionalOverrideRuleSpec<TTarget>
): boolean {
  if (!isRecord(value) || !hasOwn(value, "when") || !hasOwn(value, spec.targetKey)) {
    return false;
  }

  if (!spec.isTarget(value[spec.targetKey]) || !isRecord(value.when)) {
    return false;
  }

  const when = value.when;
  if (
    !Object.keys(when).every(
      (key) => key === "originalModel" || key === "executionModel" || key === spec.originalValueKey
    )
  ) {
    return false;
  }

  if (hasOwn(when, "originalModel") && !isConditionalModelPredicate(when.originalModel)) {
    return false;
  }

  if (hasOwn(when, "executionModel") && !isConditionalModelPredicate(when.executionModel)) {
    return false;
  }

  if (!hasOwn(when, spec.originalValueKey)) {
    return true;
  }
  const originalValue = when[spec.originalValueKey];
  return originalValue === null || typeof originalValue === "string";
}

function normalizeModel(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) {
    return null;
  }

  return typeof value === "string" ? value : INVALID;
}

function normalizeInput(value: unknown): ConditionalOverrideRuleInput | null {
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
    originalValue: typeof value.originalValue === "string" ? value.originalValue : null,
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

function matchesWhen(
  when: Readonly<Record<string, unknown>>,
  input: ConditionalOverrideRuleInput,
  originalValueKey: string
): boolean {
  const originalModel = when.originalModel as ReasoningEffortOverrideModelPredicate | undefined;
  if (originalModel && !matchesModelPredicate(input.originalModel, originalModel)) {
    return false;
  }

  const executionModel = when.executionModel as ReasoningEffortOverrideModelPredicate | undefined;
  if (executionModel && !matchesModelPredicate(input.executionModel, executionModel)) {
    return false;
  }

  if (hasOwn(when, originalValueKey) && when[originalValueKey] !== input.originalValue) {
    return false;
  }

  return true;
}

/**
 * Evaluate an ordered rule list. Returns the first matching rule's target and index,
 * or null when nothing matches (including empty, non-array, or partially malformed lists,
 * and malformed input).
 */
export function evaluateConditionalOverrideRules<TTarget>(
  rules: unknown,
  input: unknown,
  spec: ConditionalOverrideRuleSpec<TTarget>
): ConditionalOverrideRuleMatch<TTarget> | null {
  const normalizedInput = normalizeInput(input);
  if (!Array.isArray(rules) || rules.length === 0 || !normalizedInput) {
    return null;
  }

  if (!rules.every((candidate) => isConditionalOverrideRule(candidate, spec))) {
    return null;
  }

  for (const [index, rule] of (rules as Readonly<Record<string, unknown>>[]).entries()) {
    if (
      matchesWhen(
        rule.when as Readonly<Record<string, unknown>>,
        normalizedInput,
        spec.originalValueKey
      )
    ) {
      return { matchedIndex: index, target: rule[spec.targetKey] as TTarget };
    }
  }

  return null;
}
