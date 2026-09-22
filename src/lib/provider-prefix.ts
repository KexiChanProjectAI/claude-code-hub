/**
 * 供应商前缀（provider prefix）
 *
 * 配置了前缀的供应商只接受以该前缀开头的模型 ID（大小写不敏感）。
 * 例如前缀 "openai/"：请求 "openai/gpt-5.6-luna" 命中，"gpt-5.6-luna" 不命中。
 * 命中后前缀会被剥离，allowedModels / modelRedirects 以及上游请求都使用裸模型名。
 */

/** 规范化后前缀的最大长度（与数据库 varchar(64) 一致） */
export const PROVIDER_PREFIX_MAX_LENGTH = 64;

/**
 * 规范化前缀：去除首尾空白，去除末尾所有 "/"，再追加一个 "/"。
 * 结果为空时返回 null（表示未配置前缀）。
 */
export function normalizeProviderPrefix(input: string | null | undefined): string | null {
  if (input == null) {
    return null;
  }

  const trimmed = input.trim().replace(/\/+$/, "").trimEnd();
  if (!trimmed) {
    return null;
  }

  return `${trimmed}/`;
}

/**
 * 判断模型是否命中前缀。未配置前缀时恒为 true。
 * 模型名恰好等于前缀（剥离后为空）视为不命中。
 */
export function matchesProviderPrefix(model: string, prefix: string | null | undefined): boolean {
  if (!prefix) {
    return true;
  }

  return model.length > prefix.length && model.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * 剥离前缀；未配置前缀或未命中时原样返回。剩余部分保留原始大小写。
 */
export function stripProviderPrefix(model: string, prefix: string | null | undefined): string {
  if (!prefix || !matchesProviderPrefix(model, prefix)) {
    return model;
  }

  return model.slice(prefix.length);
}

/**
 * 为模型 ID 加上前缀（用于模型列表展示）。总是直接拼接，保证列表 ID 剥离后精确还原。
 */
export function applyProviderPrefix(model: string, prefix: string | null | undefined): string {
  if (!prefix) {
    return model;
  }

  return `${prefix}${model}`;
}
