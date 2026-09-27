/**
 * 把远端上报的 attempt 失败还原为本地转发会抛出的同一种错误对象，
 * 使错误分类、反应式整流、熔断与决策链逻辑与本地路径完全一致。
 */
import { LocalCapacityError } from "@/lib/memory/governor";
import {
  detectUpstreamErrorFromSseOrJsonText,
  inferUpstreamErrorStatusCodeFromText,
} from "@/lib/utils/upstream-error-detection";
import type { Provider } from "@/types/provider";
import { createTransportError, EmptyResponseError, ProxyError } from "../proxy/errors";
import {
  buildFirstValidContentTimeoutError,
  buildProviderResponseTimeoutError,
  buildStreamingIdleTimeoutError,
} from "../proxy/forwarder";
import { mapProviderTypeToFamily } from "../proxy/stream-gate/frame-classifier";
import { StreamPrecommitError } from "../proxy/stream-gate/stream-content-gate";
import type { AttemptFailure } from "./contract";

export function attemptFailureToError(failure: AttemptFailure, provider: Provider): Error {
  switch (failure.kind) {
    case "upstream_status":
      return ProxyError.fromUpstreamSnapshot(
        {
          status: failure.status,
          statusText: failure.statusText,
          headers: new Headers(failure.headers),
          bodyText: failure.bodyText,
        },
        provider
      );
    case "transport":
      return createTransportError(failure.code, failure.message);
    case "timeout":
      switch (failure.timeoutType) {
        case "streaming_first_byte":
          return buildProviderResponseTimeoutError(
            provider,
            "streaming_first_byte",
            provider.firstByteTimeoutStreamingMs
          );
        case "non_streaming_total":
          return buildProviderResponseTimeoutError(
            provider,
            "non_streaming_total",
            provider.requestTimeoutNonStreamingMs
          );
        case "streaming_idle":
          return buildStreamingIdleTimeoutError(provider);
        case "streaming_first_valid_content":
          return buildFirstValidContentTimeoutError(provider);
      }
      break;
    case "gate":
      return new StreamPrecommitError(failure.reason, {
        family: mapProviderTypeToFamily(provider.providerType) ?? "anthropic",
        providerId: provider.id,
        providerName: provider.name,
        frameData: failure.frameData || undefined,
        inferenceText: failure.inferenceText || undefined,
        framesSeen: failure.framesSeen,
        bufferedBytes: failure.bufferedBytes,
        echoExcludedBytes: failure.echoExcludedBytes,
        terminalBeforeContent: failure.terminalBeforeContent,
      });
    case "empty_response":
      return new EmptyResponseError(provider.id, provider.name, failure.reason);
    case "client_abort":
      return new ProxyError("Request aborted by client", 499, undefined, true);
    case "local_capacity":
      return new LocalCapacityError();
    case "invalid_step":
      // 版本不匹配等执行器侧问题：按系统错误走换端点/换供应商路径
      return new Error(`EDGE_INVALID_STEP: ${failure.message}`);
  }
  return new Error("EDGE_UNKNOWN_FAILURE");
}

const STRONG_FAKE_200_CODES = new Set([
  "FAKE_200_HTML_BODY",
  "FAKE_200_JSON_ERROR_NON_EMPTY",
  "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
  "FAKE_200_OPENAI_RESPONSE_FAILED",
]);

/**
 * 远端对非流式 2xx 正文命中本地假 200 预检后上报的复核（与转发器提交前的强信号判定一致）。
 * 返回 null 表示正文可以提交给客户端。
 */
export function evaluateSuspectNonStreamBody(
  bodyText: string,
  bodyTruncated: boolean,
  provider: Provider
): Error | null {
  const detected = detectUpstreamErrorFromSseOrJsonText(bodyText, {
    maxJsonCharsForMessageCheck: 0,
  });
  if (detected.isError && detected.code === "FAKE_200_EMPTY_BODY") {
    return new EmptyResponseError(provider.id, provider.name, "empty_body");
  }
  if (!detected.isError || !STRONG_FAKE_200_CODES.has(detected.code)) {
    return null;
  }
  const inferredStatus = inferUpstreamErrorStatusCodeFromText(bodyText);
  const inferredStatusCode = inferredStatus?.statusCode;
  return new ProxyError(detected.code, inferredStatusCode ?? 502, {
    body: detected.detail ?? "",
    providerId: provider.id,
    providerName: provider.name,
    rawBody: bodyText,
    rawBodyTruncated: bodyTruncated,
    isSyntheticFake200: true,
    statusCodeInferred: inferredStatusCode !== undefined,
    statusCodeInferenceMatcherId: inferredStatus?.matcherId,
  });
}
