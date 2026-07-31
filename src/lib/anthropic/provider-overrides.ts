import { evaluateReasoningEffortOverride } from "@/lib/reasoning-effort-override";
import type {
  AnthropicAdaptiveThinkingConfig,
  ReasoningEffortOverrideResult,
  ReasoningEffortOverrideRule,
} from "@/types/provider";
import type { ProviderParameterOverrideSpecialSetting } from "@/types/special-settings";

type AnthropicProviderOverrideConfig = {
  readonly id?: number;
  readonly name?: string;
  readonly providerType?: string;
  readonly anthropicMaxTokensPreference?: string | null;
  readonly anthropicThinkingBudgetPreference?: string | null;
  readonly anthropicAdaptiveThinking?: AnthropicAdaptiveThinkingConfig | null;
  readonly reasoningEffortOverrideRules?: readonly ReasoningEffortOverrideRule[] | null;
};

export type AnthropicProviderOverrideContext = {
  readonly originalModel: string | null;
  readonly executionModel: string | null;
  readonly originalReasoningEffort: string | null;
  readonly reasoningEffortOverrideRules?: readonly ReasoningEffortOverrideRule[] | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAuditValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeNumericPreference(value: string | null | undefined): number | null {
  if (!value || value === "inherit") return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function extractRawEffort(request: Record<string, unknown>): string | null {
  const outputConfig = isPlainObject(request.output_config) ? request.output_config : null;
  return typeof outputConfig?.effort === "string" ? outputConfig.effort : null;
}

function resolveRuleState(
  provider: AnthropicProviderOverrideConfig,
  request: Record<string, unknown>,
  context: AnthropicProviderOverrideContext | undefined
): {
  readonly conditionalRulesConfigured: boolean;
  readonly ruleEvaluation: ReasoningEffortOverrideResult | null;
  readonly originalReasoningEffort: string | null;
} {
  const rules =
    context && Object.hasOwn(context, "reasoningEffortOverrideRules")
      ? context.reasoningEffortOverrideRules
      : provider.reasoningEffortOverrideRules;
  const conditionalRulesConfigured = rules !== null && rules !== undefined;
  const fallbackModel = typeof request.model === "string" ? request.model : null;
  const originalModel = context ? context.originalModel : fallbackModel;
  const executionModel = context ? context.executionModel : fallbackModel;
  const originalReasoningEffort = context
    ? context.originalReasoningEffort
    : extractRawEffort(request);

  return {
    conditionalRulesConfigured,
    ruleEvaluation: conditionalRulesConfigured
      ? evaluateReasoningEffortOverride(rules, {
          originalModel,
          executionModel,
          originalReasoningEffort,
        })
      : null,
    originalReasoningEffort,
  };
}

function applyAdaptiveThinking(ensureCloned: () => Record<string, unknown>, effort: string): void {
  const target = ensureCloned();
  target.thinking = { type: "adaptive" };
  const existingOutputConfig = isPlainObject(target.output_config) ? target.output_config : {};
  target.output_config = { ...existingOutputConfig, effort };
}

function applyAnthropicProviderOverridesInternal(
  provider: AnthropicProviderOverrideConfig,
  request: Record<string, unknown>,
  ruleEvaluation: ReasoningEffortOverrideResult | null
): Record<string, unknown> {
  let output: Record<string, unknown> = request;
  const ensureCloned = () => {
    if (output === request) {
      output = { ...request };
    }
    return output;
  };

  const maxTokens = normalizeNumericPreference(provider.anthropicMaxTokensPreference);
  if (maxTokens !== null) {
    ensureCloned().max_tokens = maxTokens;
  }

  if (ruleEvaluation) {
    if (ruleEvaluation.shouldOverride) {
      applyAdaptiveThinking(ensureCloned, ruleEvaluation.overriddenEffort);
      return output;
    }
  } else {
    const adaptiveConfig = provider.anthropicAdaptiveThinking;
    if (adaptiveConfig) {
      const modelId = typeof request.model === "string" ? request.model : null;
      const isMatch =
        adaptiveConfig.modelMatchMode === "all" ||
        (modelId !== null &&
          adaptiveConfig.models.some(
            (model) => modelId === model || modelId.startsWith(`${model}-`)
          ));
      if (isMatch) {
        applyAdaptiveThinking(ensureCloned, adaptiveConfig.effort);
        return output;
      }
    }
  }

  const thinkingBudget = normalizeNumericPreference(provider.anthropicThinkingBudgetPreference);
  if (thinkingBudget !== null) {
    const target = ensureCloned();
    const existingThinking = isPlainObject(output.thinking) ? output.thinking : {};
    let budgetTokens = thinkingBudget;
    const currentMaxTokens = typeof output.max_tokens === "number" ? output.max_tokens : null;
    // Anthropic API requires budget_tokens >= 1024
    const MIN_BUDGET_TOKENS = 1024;
    if (currentMaxTokens !== null && budgetTokens >= currentMaxTokens) {
      budgetTokens = currentMaxTokens - 1;
    }
    // If clamping would result in budget_tokens < 1024, skip thinking override entirely
    // to avoid invalid API requests
    if (budgetTokens < MIN_BUDGET_TOKENS) {
      return output;
    }
    const nextThinking: Record<string, unknown> = {
      ...existingThinking,
      type: "enabled",
      budget_tokens: budgetTokens,
    };
    target.thinking = nextThinking;
  }

  return output;
}

/**
 * Apply Anthropic provider overrides to request body.
 *
 * Conventions:
 * - providerType !== "claude" && providerType !== "claude-auth" -> no processing
 * - Preference value null/undefined/"inherit" means "follow client"
 * - Overrides only affect:
 *   - max_tokens
 *   - thinking.type / thinking.budget_tokens
 */
export function applyAnthropicProviderOverrides(
  provider: AnthropicProviderOverrideConfig,
  request: Record<string, unknown>,
  context?: AnthropicProviderOverrideContext
): Record<string, unknown> {
  if (provider.providerType !== "claude" && provider.providerType !== "claude-auth") {
    return request;
  }

  const { ruleEvaluation } = resolveRuleState(provider, request, context);
  return applyAnthropicProviderOverridesInternal(provider, request, ruleEvaluation);
}

export function applyAnthropicProviderOverridesWithAudit(
  provider: AnthropicProviderOverrideConfig,
  request: Record<string, unknown>,
  context?: AnthropicProviderOverrideContext
): { request: Record<string, unknown>; audit: ProviderParameterOverrideSpecialSetting | null } {
  if (provider.providerType !== "claude" && provider.providerType !== "claude-auth") {
    return { request, audit: null };
  }

  const maxTokens = normalizeNumericPreference(provider.anthropicMaxTokensPreference);
  const hasAdaptiveConfig = provider.anthropicAdaptiveThinking != null;
  const thinkingBudget = normalizeNumericPreference(provider.anthropicThinkingBudgetPreference);
  const ruleState = resolveRuleState(provider, request, context);

  const hit =
    maxTokens !== null ||
    thinkingBudget !== null ||
    hasAdaptiveConfig ||
    ruleState.conditionalRulesConfigured;

  if (!hit) {
    return { request, audit: null };
  }

  const beforeMaxTokens = toAuditValue(request.max_tokens);
  const beforeThinking = isPlainObject(request.thinking) ? request.thinking : null;
  const beforeThinkingType = toAuditValue(beforeThinking?.type);
  const beforeThinkingBudgetTokens = toAuditValue(beforeThinking?.budget_tokens);

  const nextRequest = applyAnthropicProviderOverridesInternal(
    provider,
    request,
    ruleState.ruleEvaluation
  );

  const afterMaxTokens = toAuditValue(nextRequest.max_tokens);
  const afterThinking = isPlainObject(nextRequest.thinking) ? nextRequest.thinking : null;
  const afterThinkingType = toAuditValue(afterThinking?.type);
  const afterThinkingBudgetTokens = toAuditValue(afterThinking?.budget_tokens);

  const afterOutputConfig = isPlainObject(nextRequest.output_config)
    ? nextRequest.output_config
    : null;
  const beforeOutputConfig = isPlainObject(request.output_config) ? request.output_config : null;
  const afterOutputConfigEffort = toAuditValue(afterOutputConfig?.effort);
  const beforeOutputConfigEffort = context
    ? toAuditValue(ruleState.originalReasoningEffort)
    : toAuditValue(beforeOutputConfig?.effort);

  const changes: ProviderParameterOverrideSpecialSetting["changes"] = [
    {
      path: "max_tokens",
      before: beforeMaxTokens,
      after: afterMaxTokens,
      changed: !Object.is(beforeMaxTokens, afterMaxTokens),
    },
    {
      path: "thinking.type",
      before: beforeThinkingType,
      after: afterThinkingType,
      changed: !Object.is(beforeThinkingType, afterThinkingType),
    },
    {
      path: "thinking.budget_tokens",
      before: beforeThinkingBudgetTokens,
      after: afterThinkingBudgetTokens,
      changed: !Object.is(beforeThinkingBudgetTokens, afterThinkingBudgetTokens),
    },
    {
      path: "output_config.effort",
      before: beforeOutputConfigEffort,
      after: afterOutputConfigEffort,
      changed: !Object.is(beforeOutputConfigEffort, afterOutputConfigEffort),
    },
  ];

  const audit: ProviderParameterOverrideSpecialSetting = {
    type: "provider_parameter_override",
    scope: "provider",
    providerId: provider.id ?? null,
    providerName: provider.name ?? null,
    providerType: provider.providerType ?? null,
    hit: true,
    changed: changes.some((c) => c.changed),
    changes,
    ...(ruleState.ruleEvaluation ? { ruleEvaluation: ruleState.ruleEvaluation } : {}),
  };

  return { request: nextRequest, audit };
}
