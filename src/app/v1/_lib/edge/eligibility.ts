/**
 * edge 执行资格判定。
 *
 * 不满足条件的请求返回 delegate，由远端把原始请求整体反代回本地 /v1 代理处理。
 * 判定分两段，且都必须发生在任何计数型副作用（限流计数、供应商并发占位、message_request
 * 建行）之前，保证交回本地时不会重复计数：
 * - 请求级：只读摘要与系统设置（在会话守卫之前）；
 * - 供应商级：需要已选中的供应商（在 provider 守卫之后、messageContext 之前）。
 */
import type { Provider, ProviderType } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";
import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "../proxy/endpoint-paths";
import { resolveEndpointPolicy } from "../proxy/endpoint-policy";
import { isFakeStreamingEligible } from "../proxy/fake-streaming/eligibility";
import { detectFormatByEndpoint } from "../proxy/format-mapper";
import { isWebsocketClientRequest } from "../responses-ws/eligibility";
import type { EdgeClientFormat, RequestDigest } from "./contract";

export type EdgeEligibility = { eligible: true } | { eligible: false; reason: string };

/** 各客户端格式在 edge 上可执行的端点（规范化路径） */
export const EDGE_FORMAT_PATHS: Record<EdgeClientFormat, string> = {
  claude: V1_ENDPOINT_PATHS.MESSAGES,
  response: V1_ENDPOINT_PATHS.RESPONSES,
  openai: V1_ENDPOINT_PATHS.CHAT_COMPLETIONS,
};

/** 同格式透传：客户端格式到可执行的供应商类型（与 provider-selector 的格式约束一致） */
export const EDGE_FORMAT_PROVIDER_TYPES: Record<EdgeClientFormat, readonly ProviderType[]> = {
  claude: ["claude", "claude-auth"],
  response: ["codex"],
  openai: ["openai-compatible"],
};

const ELIGIBLE: EdgeEligibility = { eligible: true };

function reject(reason: string): EdgeEligibility {
  return { eligible: false, reason };
}

export function evaluateRequestEligibility(params: {
  digest: RequestDigest;
  settings: SystemSettings;
  headers: Headers;
  sensitiveWordsConfigured: boolean;
  globalBodyFiltersConfigured: boolean;
}): EdgeEligibility {
  const { digest, settings } = params;
  if (!settings.edgeExecutionEnabled) return reject("edge_disabled");
  if (digest.method.toUpperCase() !== "POST") return reject("unsupported_method");

  const pathname = new URL(digest.path, "http://edge.local").pathname;
  const expectedPath = EDGE_FORMAT_PATHS[digest.format];
  if (normalizeEndpointPath(pathname) !== expectedPath) {
    return reject("unsupported_endpoint");
  }
  if (resolveEndpointPolicy(pathname).kind !== "default") return reject("unsupported_endpoint");
  if (detectFormatByEndpoint(pathname) !== digest.format) return reject("unsupported_format");
  if (digest.bodyParseError !== null) return reject("body_parse_error");
  // Remote Compaction v2 在本地走 raw passthrough 策略
  if (digest.isRemoteCompactionV2) return reject("remote_compaction");
  if (
    digest.responseInputRectify &&
    digest.responseInputRectify.action !== "passthrough" &&
    !(settings.enableResponseInputRectifier ?? true)
  ) {
    // 摘要按规范化后的 input 计算；整流关闭时本地会基于原始 input 判定，只能交回本地
    return reject("response_input_rectifier_disabled");
  }
  if (isWebsocketClientRequest(params.headers)) return reject("websocket");
  if (digest.isProbe) return reject("probe_request");
  if (digest.isWarmup && settings.interceptAnthropicWarmupRequests) {
    return reject("warmup_intercept");
  }
  if (params.sensitiveWordsConfigured) return reject("sensitive_words_configured");
  if (params.globalBodyFiltersConfigured) return reject("request_filter_body_ops");
  if (digest.topLevel.stream === true && settings.discoveryEnabled === true) {
    return reject("discovery_enabled");
  }
  return ELIGIBLE;
}

export function evaluateProviderEligibility(params: {
  provider: Provider;
  format: EdgeClientFormat;
  requestedModel: string;
  settings: SystemSettings;
  providerBodyFiltersConfigured: boolean;
}): EdgeEligibility {
  const { provider, settings } = params;
  if (!EDGE_FORMAT_PROVIDER_TYPES[params.format].includes(provider.providerType)) {
    return reject("provider_type");
  }
  if (
    provider.providerType === "codex" &&
    provider.codexImageGenerationPreference &&
    provider.codexImageGenerationPreference !== "inherit"
  ) {
    // 图片生成偏好会改写 tools / tool_choice / input 内的嵌套工具，控制面无法以 op 表达
    return reject("codex_image_generation_preference");
  }
  if (params.providerBodyFiltersConfigured) return reject("provider_request_filter_body_ops");
  if (
    isFakeStreamingEligible(
      params.requestedModel,
      provider.groupTag,
      settings.fakeStreamingWhitelist
    )
  ) {
    return reject("fake_streaming");
  }
  return ELIGIBLE;
}
