import { evaluateConditionalOverrideRules, isRecord } from "@/lib/conditional-override-rules";
import type {
  CodexServiceTierOverrideTarget,
  ServiceTierOverrideResult,
  ServiceTierOverrideRule,
} from "@/types/provider";

export const CODEX_SERVICE_TIER_OVERRIDE_TARGETS: readonly CodexServiceTierOverrideTarget[] = [
  "auto",
  "default",
  "flex",
  "priority",
];

const NO_MATCH: ServiceTierOverrideResult = {
  shouldOverride: false,
  overriddenServiceTier: null,
};

export function isCodexServiceTierOverrideTarget(
  value: unknown
): value is CodexServiceTierOverrideTarget {
  return (
    typeof value === "string" &&
    (CODEX_SERVICE_TIER_OVERRIDE_TARGETS as readonly string[]).includes(value)
  );
}

/** A rule target is either a concrete tier or null ("unset": remove service_tier). */
export function isServiceTierOverrideRuleTarget(
  value: unknown
): value is CodexServiceTierOverrideTarget | null {
  return value === null || isCodexServiceTierOverrideTarget(value);
}

const SERVICE_TIER_RULE_SPEC = {
  originalValueKey: "originalServiceTier",
  targetKey: "overrideServiceTier",
  isTarget: isServiceTierOverrideRuleTarget,
} as const;

/**
 * Evaluate conditional service tier rules (first match wins).
 *
 * Input shape: { originalModel, executionModel, originalServiceTier }.
 * A match with overriddenServiceTier === null means the caller must delete service_tier.
 */
export function evaluateServiceTierOverride(
  rules: unknown,
  input: unknown
): ServiceTierOverrideResult {
  const match = evaluateConditionalOverrideRules(
    rules,
    isRecord(input)
      ? {
          originalModel: input.originalModel,
          executionModel: input.executionModel,
          originalValue: input.originalServiceTier,
        }
      : null,
    SERVICE_TIER_RULE_SPEC
  );
  if (!match) {
    return NO_MATCH;
  }

  return {
    shouldOverride: true,
    overriddenServiceTier: match.target,
    matchedIndex: match.matchedIndex,
  };
}

/** Convert the legacy static preference into an equivalent rule list ("inherit"/invalid => []). */
export function convertLegacyCodexServiceTierToRules(
  preference: unknown
): ServiceTierOverrideRule[] {
  if (!isCodexServiceTierOverrideTarget(preference)) {
    return [];
  }

  return [{ when: {}, overrideServiceTier: preference }];
}
