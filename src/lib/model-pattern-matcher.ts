import { resolveProviderPatternRegex } from "@/lib/provider-pattern-regex";
import type { ProviderModelRedirectMatchType } from "@/types/provider";

/**
 * 统一的大小写不敏感模型名匹配器。
 *
 * 供应商白名单（allowedModels）与模型重定向（modelRedirects）都经由这里匹配，
 * 因此客户端请求模型名与配置模式之间的比较完全不区分大小写
 * （例如 `xunfei/Kimi-K2.5` 与 `xunfei/kimi-k2.5` 视为同一模型）。
 */
export function matchesPattern(
  model: string,
  matchType: ProviderModelRedirectMatchType,
  pattern: string
): boolean {
  switch (matchType) {
    case "exact":
      return model.toLowerCase() === pattern.toLowerCase();
    case "prefix":
      return model.toLowerCase().startsWith(pattern.toLowerCase());
    case "suffix":
      return model.toLowerCase().endsWith(pattern.toLowerCase());
    case "contains":
      return model.toLowerCase().includes(pattern.toLowerCase());
    case "regex": {
      // 不隐式补 ^/$，需要全字符串匹配时请显式写成 ^pattern$。
      // 解析失败时尝试把 `*`/`?` 当 glob 通配符，兼容旧版输入习惯。
      // regex 统一带 i 标志编译（见 provider-pattern-regex），同样大小写不敏感。
      const compiled = resolveProviderPatternRegex(pattern);
      return compiled ? compiled.regex.test(model) : false;
    }
    default:
      return false;
  }
}
