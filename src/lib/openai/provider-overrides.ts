import { evaluateReasoningEffortOverride } from "@/lib/reasoning-effort-override";
import type { ReasoningEffortOverrideRule } from "@/types/provider";
import type { ProviderParameterOverrideSpecialSetting } from "@/types/special-settings";

export const OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

type OpenAIChatProviderOverrideConfig = {
  id?: number;
  name?: string;
  providerType?: string;
};

export type OpenAIChatProviderOverrideContext = {
  readonly requestPath: string;
  readonly originalModel: string | null;
  readonly executionModel: string | null;
  /** Raw client top-level reasoning_effort captured at intake (null = client sent none). */
  readonly originalReasoningEffort: string | null;
  readonly reasoningEffortOverrideRules: readonly ReasoningEffortOverrideRule[] | null;
};

function toAuditValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 根据供应商的 reasoning effort 规则覆写 OpenAI Chat Completions 请求体的顶层 reasoning_effort。
 *
 * 约定：
 * - 仅作用于 openai-compatible 供应商的 /v1/chat/completions 请求
 * - 规则为 null/空数组或未命中时保持客户端原值
 * - 只改写顶层 reasoning_effort，不触碰其他字段
 */
export function applyOpenAIChatProviderOverridesWithAudit(
  provider: OpenAIChatProviderOverrideConfig,
  request: Record<string, unknown>,
  context: OpenAIChatProviderOverrideContext
): { request: Record<string, unknown>; audit: ProviderParameterOverrideSpecialSetting | null } {
  if (
    provider.providerType !== "openai-compatible" ||
    context.requestPath !== OPENAI_CHAT_COMPLETIONS_PATH
  ) {
    return { request, audit: null };
  }

  const rules = context.reasoningEffortOverrideRules;
  if (!rules || rules.length === 0) {
    return { request, audit: null };
  }

  const ruleEvaluation = evaluateReasoningEffortOverride(rules, {
    originalModel: context.originalModel,
    executionModel: context.executionModel,
    originalReasoningEffort: context.originalReasoningEffort,
  });
  if (!ruleEvaluation.shouldOverride || ruleEvaluation.overriddenEffort === null) {
    return { request, audit: null };
  }

  const before = toAuditValue(request.reasoning_effort);
  const after = ruleEvaluation.overriddenEffort;
  const nextRequest = { ...request, reasoning_effort: after };

  const changes: ProviderParameterOverrideSpecialSetting["changes"] = [
    { path: "reasoning_effort", before, after, changed: !Object.is(before, after) },
  ];

  return {
    request: nextRequest,
    audit: {
      type: "provider_parameter_override",
      scope: "provider",
      providerId: provider.id ?? null,
      providerName: provider.name ?? null,
      providerType: provider.providerType ?? null,
      hit: true,
      changed: changes.some((c) => c.changed),
      changes,
      ruleEvaluation,
    },
  };
}
