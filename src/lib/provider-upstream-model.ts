import {
  findMatchingProviderModelRedirectRule,
  resolveProviderModelRedirectTarget,
} from "@/lib/provider-model-redirects";
import { matchesProviderPrefix, stripProviderPrefix } from "@/lib/provider-prefix";
import type { Provider, ProviderModelRedirectRule } from "@/types/provider";

export interface UpstreamModelResolution {
  /** 实际发往上游的模型名（先剥离前缀，再应用重定向规则） */
  model: string;
  /** 剥离前缀后、应用重定向前的模型名 */
  strippedModel: string;
  /** 是否剥离了供应商前缀 */
  prefixStripped: boolean;
  /** 命中的重定向规则（基于剥离后的模型名匹配） */
  matchedRule: ProviderModelRedirectRule | null;
}

/**
 * 计算某供应商下请求模型对应的上游模型名。
 *
 * 顺序：供应商前缀剥离 -> modelRedirects 规则（规则以裸模型名编写）。
 */
export function resolveUpstreamModel(
  provider: Pick<Provider, "modelRedirects"> & { providerPrefix?: string | null },
  originalModel: string
): UpstreamModelResolution {
  const prefix = provider.providerPrefix ?? null;
  const prefixStripped = !!prefix && matchesProviderPrefix(originalModel, prefix);
  const strippedModel = prefixStripped ? stripProviderPrefix(originalModel, prefix) : originalModel;
  const matchedRule = findMatchingProviderModelRedirectRule(strippedModel, provider.modelRedirects);
  const model = matchedRule
    ? resolveProviderModelRedirectTarget(strippedModel, matchedRule)
    : strippedModel;

  return { model, strippedModel, prefixStripped, matchedRule };
}
