import type { OpenAIReasoningEffortFieldSource, SpecialSetting } from "@/types/special-settings";

/** 从 OpenAI Chat Completions 请求体解析出的思考强度信息。 */
export interface OpenAIReasoningEffortExtraction {
  effort: string;
  source: OpenAIReasoningEffortFieldSource;
}

/**
 * 过滤非字符串及空白值，避免把无效参数写入审计记录。
 * 校验用裁剪后值，但返回原始字符串，保证审计记录如实反映客户端发送的字段值。
 */
function normalizeOpenAIReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim().length > 0 ? value : null;
}

/**
 * 从 OpenAI Chat Completions 请求体解析思考强度。
 *
 * 兼容两种载体（外部兼容性调研结论）：
 * - 顶层标量 `reasoning_effort`：OpenAI 官方 Chat Completions 参数，且是
 *   DeepSeek / xAI / Mistral / Groq / Gemini(OAI-compat) / DeepInfra / OpenRouter /
 *   LiteLLM 等大多数 openai-compatible 供应商接受的 de-facto 标准 → 优先读取。
 * - 嵌套对象 `reasoning.effort`：OpenRouter / Ollama / Vercel AI Gateway 等
 *   在 chat/completions 端点也接受该 Responses 风格载体 → 兜底读取。
 *
 * 两者同时存在且不一致时以顶层为准：与 OpenRouter 官方声明「reasoning_effort 是
 * reasoning.effort 的简写、二者不可冲突」的语义一致，避免嵌套值覆盖顶层声明。
 * 审计层仅做非空校验、原样记录，不做取值白名单（各供应商取值域不同，白名单会丢真实值）。
 */
export function extractOpenAIReasoningEffortFromRequestBody(
  requestBody: unknown
): OpenAIReasoningEffortExtraction | null {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    return null;
  }

  const record = requestBody as Record<string, unknown>;

  const topLevel = normalizeOpenAIReasoningEffort(record.reasoning_effort);
  if (topLevel) {
    return { effort: topLevel, source: "reasoning_effort" };
  }

  const reasoning = record.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return null;
  }

  const nested = normalizeOpenAIReasoningEffort("effort" in reasoning ? reasoning.effort : null);
  if (!nested) {
    return null;
  }

  return { effort: nested, source: "reasoning.effort" };
}

/** 从使用记录审计中读取 OpenAI Chat Completions 的思考强度。 */
export function extractOpenAIReasoningEffortFromSpecialSettings(
  specialSettings: SpecialSetting[] | null | undefined
): OpenAIReasoningEffortExtraction | null {
  if (!Array.isArray(specialSettings)) {
    return null;
  }

  for (const setting of specialSettings) {
    if (setting.type !== "openai_reasoning_effort") {
      continue;
    }
    if (typeof setting.effort !== "string" || setting.effort.trim().length === 0) {
      continue;
    }
    return {
      effort: setting.effort,
      source: setting.source,
    };
  }

  return null;
}

/** OpenAI Chat Completions 使用记录中用于呈现请求值和实际转发值的思考强度信息。 */
export interface OpenAIReasoningEffortInfo {
  requestedEffort: string | null;
  effectiveEffort: string;
  isOverridden: boolean;
}

/**
 * 合并 OpenAI Chat Completions 客户端请求审计与供应商覆写审计。
 *
 * 客户端未发送 reasoning_effort 时仍可从覆写审计恢复实际转发值；
 * 多次覆写（切换供应商）以最后一次为准。
 */
export function extractOpenAIReasoningEffortInfo(
  specialSettings: SpecialSetting[] | null | undefined
): OpenAIReasoningEffortInfo | null {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) {
    return null;
  }

  const requestedEffort = extractOpenAIReasoningEffortFromSpecialSettings(specialSettings)?.effort;
  let hasEffortOverrideAudit = false;
  let initialOverrideBefore: string | null = null;
  let finalOverrideAfter: string | null = null;

  for (const setting of specialSettings) {
    if (
      setting.type !== "provider_parameter_override" ||
      setting.providerType !== "openai-compatible"
    ) {
      continue;
    }

    const effortChange = setting.changes?.find((change) => change.path === "reasoning_effort");
    if (!effortChange) {
      continue;
    }

    if (!hasEffortOverrideAudit) {
      initialOverrideBefore = normalizeOpenAIReasoningEffort(effortChange.before);
    }
    finalOverrideAfter = normalizeOpenAIReasoningEffort(effortChange.after);
    hasEffortOverrideAudit = true;
  }

  const originalEffort = requestedEffort ?? initialOverrideBefore;
  const effectiveEffort = finalOverrideAfter ?? originalEffort;
  if (!effectiveEffort) {
    return null;
  }

  return {
    requestedEffort: originalEffort,
    effectiveEffort,
    isOverridden: hasEffortOverrideAudit && originalEffort !== effectiveEffort,
  };
}
