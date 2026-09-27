/**
 * edge 执行资格判定。
 *
 * 不满足条件的请求返回 delegate，由远端把原始请求整体反代回本地 /v1 代理处理。
 * 判定分两段，且都必须发生在任何计数型副作用（限流计数、供应商并发占位、message_request
 * 建行）之前，保证交回本地时不会重复计数：
 * - 请求级：只读摘要与系统设置（在会话守卫之前）；
 * - 供应商级：需要已选中的供应商（在 provider 守卫之后、messageContext 之前）。
 */
import type { Provider } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";
import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "../proxy/endpoint-paths";
import { resolveEndpointPolicy } from "../proxy/endpoint-policy";
import { isFakeStreamingEligible } from "../proxy/fake-streaming/eligibility";
import { detectFormatByEndpoint } from "../proxy/format-mapper";
import { isWebsocketClientRequest } from "../responses-ws/eligibility";
import type { RequestDigest } from "./contract";

export type EdgeEligibility = { eligible: true } | { eligible: false; reason: string };

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
  if (normalizeEndpointPath(pathname) !== V1_ENDPOINT_PATHS.MESSAGES) {
    return reject("unsupported_endpoint");
  }
  if (resolveEndpointPolicy(pathname).kind !== "default") return reject("unsupported_endpoint");
  if (detectFormatByEndpoint(pathname) !== "claude") return reject("unsupported_format");
  if (digest.bodyParseError !== null) return reject("body_parse_error");
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
  requestedModel: string;
  settings: SystemSettings;
  providerBodyFiltersConfigured: boolean;
}): EdgeEligibility {
  const { provider, settings } = params;
  if (provider.providerType !== "claude" && provider.providerType !== "claude-auth") {
    return reject("provider_type");
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
