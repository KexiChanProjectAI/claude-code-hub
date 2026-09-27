/**
 * 为 edge 执行器构建单次 attempt 的 ExecutionStep。
 *
 * 逐步复刻 ProxyForwarder.doForwardPrepared 标准分支（claude / claude-auth / codex /
 * openai-compatible）上的准备流程，
 * 但把"作用于请求体"的改写转换为 body op 日志交给远端执行：
 * - 只改写顶层字段的步骤（模型重定向、供应商参数覆写、会话守卫的 metadata 补全、
 *   反应式 budget/effort 整流）照常在合成请求体上执行，最终以顶层字段 diff 下发；
 * - 依赖消息内容的步骤（billing header 整流、cache_control TTL、thinking signature 整流）
 *   以内容型 op 追加到持久日志，按本地的应用顺序重放；
 * - 发送时才执行的步骤（私有参数过滤、metadata.user_id 注入）每步单独附加在末尾。
 *
 * 由此远端执行 "原始请求体 + bodyOps" 得到的正文与本地转发完全一致。
 */
import { applyAnthropicProviderOverridesWithAudit } from "@/lib/anthropic/provider-overrides";
import { applyCodexProviderOverridesWithAudit } from "@/lib/codex/provider-overrides";
import { getCachedSystemSettings, isHttp2Enabled } from "@/lib/config";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { Provider } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";
import { HeaderProcessor } from "../headers";
import { sanitizeUrl } from "../proxy/errors";
import {
  applyClaudeMetadataUserIdInjectionWithAudit,
  filterPrivateParameters,
  getReasoningEffortOverrideRules,
  ProxyForwarder,
  persistSpecialSettings,
  resolveCacheTtlPreference,
} from "../proxy/forwarder";
import { ModelRedirector } from "../proxy/model-redirector";
import { ensureOpenAIChatStreamUsageOption } from "../proxy/openai-chat-usage-options";
import { DEFAULT_RESPONSE_FIXER_CONFIG } from "../proxy/response-fixer";
import { isCodexResponsesStreamRequest } from "../proxy/response-handler";
import type { ProxySession } from "../proxy/session";
import {
  resolveStreamGateCaps,
  resolveStreamGateMode,
} from "../proxy/stream-gate/stream-content-gate";
import { buildProxyUrl } from "../url";
import {
  type BodyOp,
  EDGE_MUTABLE_TOP_LEVEL_KEYS,
  type EdgeClientFormat,
  type ExecutionStep,
  type HeaderPairs,
} from "./contract";

/** 构建 compact SSE / 失败正文等上报载荷的上限 */
export const EDGE_REPORTING_LIMITS = {
  maxCompactBytes: 256 * 1024,
  maxHeadBytes: 1024 * 1024,
  maxNonStreamBodyBytes: 8 * 1024 * 1024,
  maxErrorBodyBytes: 64 * 1024,
} as const;

/** 与 response-handler CLIENT_ABORT_DRAIN_MAX_MS 一致 */
export const EDGE_CLIENT_ABORT_DRAIN_MS = 60_000;

/**
 * 请求体相关的 edge 状态（随 EdgeRequestState 持久化）。
 * 合成体的当前值即 session.request.message，本结构只保存重放所需的其余信息。
 */
export interface EdgeBodyState {
  /** 远端请求体中实际存在的可改写顶层字段原值（diff 基线） */
  originalTopLevel: Record<string, unknown>;
  hasPrivateParams: boolean;
  /** 按本地应用顺序累积的内容型 op（跨 attempt、跨供应商持久） */
  contentOps: BodyOp[];
}

export interface BuildStepParams {
  session: ProxySession;
  body: EdgeBodyState;
  provider: Provider;
  endpoint: { endpointId: number | null; baseUrl: string };
  stepId: string;
  attemptNumber: number;
  totalProvidersAttempted: number;
  attemptKind: ExecutionStep["attemptKind"];
  /** 仅每个供应商的首次 attempt 应用供应商参数覆写（与本地 applyProviderOverrides 一致） */
  applyProviderOverrides: boolean;
  delayMs: number;
  hedge: ExecutionStep["hedge"];
  heartbeatIntervalMs: number;
  settings?: SystemSettings;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 顶层可改写字段的 diff：原值 -> 合成体当前值。
 */
export function diffTopLevelOps(
  original: Record<string, unknown>,
  current: Record<string, unknown>
): BodyOp[] {
  const ops: BodyOp[] = [];
  for (const key of EDGE_MUTABLE_TOP_LEVEL_KEYS) {
    const hadKey = Object.hasOwn(original, key);
    const hasKey = Object.hasOwn(current, key);
    if (!hasKey) {
      if (hadKey) ops.push({ op: "delete_top_level", key });
      continue;
    }
    if (!hadKey || !jsonEqual(original[key], current[key])) {
      ops.push({ op: "set_top_level", key, value: structuredClone(current[key]) });
    }
  }
  return ops;
}

function appendContentOp(body: EdgeBodyState, op: BodyOp): void {
  const last = body.contentOps[body.contentOps.length - 1];
  if (last && jsonEqual(last, op)) return;
  body.contentOps.push(op);
}

/** 按名称稳定排序（与 Node Headers 的迭代顺序一致，不随运行时的 Headers 实现变化） */
function headersToPairs(headers: Headers): HeaderPairs {
  const pairs: HeaderPairs = [];
  headers.forEach((value, name) => {
    pairs.push([name.toLowerCase(), value]);
  });
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function resolveEdgeProviderType(provider: Provider): ExecutionStep["provider"]["type"] {
  switch (provider.providerType) {
    case "claude-auth":
    case "codex":
    case "openai-compatible":
      return provider.providerType;
    default:
      return "claude";
  }
}

function resolveStepClientFormat(session: ProxySession): EdgeClientFormat {
  const format = session.originalFormat;
  return format === "response" || format === "openai" ? format : "claude";
}

export async function buildExecutionStep(params: BuildStepParams): Promise<ExecutionStep> {
  const { session, body, provider, endpoint } = params;
  const settings = params.settings ?? (await getCachedSystemSettings());
  const endpointPolicy = session.getEndpointPolicy();
  session.setProvider(provider);

  // 1. cache TTL（key 偏好优先）与 1M 上下文标记
  const resolvedCacheTtl = resolveCacheTtlPreference(
    session.authState?.key?.cacheTtlPreference,
    provider.cacheTtlPreference
  );
  session.setCacheTtlResolved(resolvedCacheTtl);
  const isAnthropicProvider =
    provider.providerType === "claude" || provider.providerType === "claude-auth";
  if (isAnthropicProvider && session.clientRequestsContext1m()) {
    session.setContext1mApplied(true);
  }

  if (!endpointPolicy.bypassForwarderPreprocessing) {
    // 2. 模型重定向（直接作用于合成体的 model）
    ModelRedirector.apply(session, provider);

    // 3. Codex 供应商参数覆写（仅本供应商首次 attempt；只改写顶层字段，图片生成偏好已由资格判定排除）
    if (params.applyProviderOverrides && provider.providerType === "codex") {
      const { request: overridden, audit } = applyCodexProviderOverridesWithAudit(
        provider,
        session.request.message as Record<string, unknown>,
        {
          originalModel: session.getRawIntakeModel(),
          executionModel: session.getCurrentModel(),
          originalReasoningEffort: session.getRawResponsesReasoningEffort(),
          reasoningEffortOverrideRules: getReasoningEffortOverrideRules(provider),
        }
      );
      session.request.message = overridden;
      if (audit) {
        session.addSpecialSetting(audit);
        await persistSpecialSettings(session);
      }
    }
  }

  if (!endpointPolicy.bypassForwarderPreprocessing && isAnthropicProvider) {
    // 4. billing header 整流（内容型，幂等）
    if (settings.enableBillingHeaderRectifier ?? true) {
      if (!body.contentOps.some((op) => op.op === "remove_system_billing_header")) {
        appendContentOp(body, { op: "remove_system_billing_header" });
      }
    }

    // 5. Anthropic 供应商参数覆写（仅本供应商首次 attempt）
    if (params.applyProviderOverrides) {
      const { request: overridden, audit } = applyAnthropicProviderOverridesWithAudit(
        provider,
        session.request.message as Record<string, unknown>,
        {
          originalModel: session.getRawIntakeModel(),
          executionModel: session.getCurrentModel(),
          originalReasoningEffort: session.getRawMessagesReasoningEffort(),
          reasoningEffortOverrideRules: getReasoningEffortOverrideRules(provider),
        }
      );
      session.request.message = overridden;
      if (audit) {
        session.addSpecialSetting(audit);
        await persistSpecialSettings(session);
      }
    }

    // 6. cache_control TTL 覆写（内容型）
    if (resolvedCacheTtl) {
      appendContentOp(body, { op: "set_cache_control_ttl", ttl: resolvedCacheTtl });
    }
  }

  // 7. 出站请求头与 URL
  const headers = ProxyForwarder.buildHeaders(session, provider, endpoint.baseUrl);
  const url = buildProxyUrl(endpoint.baseUrl, session.requestUrl);
  headers.set("host", HeaderProcessor.extractHost(url));

  // 8. 发送时步骤：私有参数过滤 -> metadata.user_id 注入 -> Chat 流式 usage 选项（不写回合成体）
  const sendTimeOps: BodyOp[] = [];
  if (body.hasPrivateParams) {
    sendTimeOps.push({ op: "strip_private_params" });
  }
  const filtered = filterPrivateParameters(session.request.message) as Record<string, unknown>;
  const injection = isAnthropicProvider
    ? applyClaudeMetadataUserIdInjectionWithAudit(
        filtered,
        session,
        settings.enableClaudeMetadataUserIdInjection ?? true
      )
    : null;
  if (injection) {
    session.addSpecialSetting(injection.audit);
    await persistSpecialSettings(session);
    if (
      injection.message !== filtered &&
      !jsonEqual(injection.message.metadata, filtered.metadata)
    ) {
      sendTimeOps.push({
        op: "set_top_level",
        key: "metadata",
        value: structuredClone(injection.message.metadata),
      });
    }
  }

  // 9. final 阶段请求过滤器：资格预检已保证只含请求头操作
  if (!endpointPolicy.bypassRequestFilters) {
    const { requestFilterEngine } = await import("@/lib/request-filter-engine");
    await requestFilterEngine.applyFinal(
      session,
      structuredClone(session.request.message as Record<string, unknown>),
      headers
    );
  }

  // 10. OpenAI Chat 流式请求补齐 stream_options.include_usage（作用于过滤后的发送体）
  const usageProbe = structuredClone(filtered);
  if (
    ensureOpenAIChatStreamUsageOption(
      usageProbe,
      provider.providerType,
      session.requestUrl.pathname
    )
  ) {
    sendTimeOps.push({
      op: "set_top_level",
      key: "stream_options",
      value: structuredClone(usageProbe.stream_options),
    });
  }

  // 远端会重新序列化正文，入站 content-encoding 不再适用
  headers.delete("content-encoding");

  const bodyOps = [
    ...body.contentOps,
    ...diffTopLevelOps(body.originalTopLevel, session.request.message as Record<string, unknown>),
    ...sendTimeOps,
  ];

  const env = getEnvConfig();
  const caps = resolveStreamGateCaps();
  const isStreaming = (session.request.message as Record<string, unknown>).stream === true;

  logger.debug("[EdgeStepBuilder] Built execution step", {
    stepId: params.stepId,
    providerId: provider.id,
    endpointId: endpoint.endpointId,
    attemptNumber: params.attemptNumber,
    bodyOpCount: bodyOps.length,
  });

  return {
    stepId: params.stepId,
    attemptNumber: params.attemptNumber,
    totalProvidersAttempted: params.totalProvidersAttempted,
    attemptKind: params.attemptKind,
    provider: {
      id: provider.id,
      name: provider.name,
      priority: provider.priority || 0,
      type: resolveEdgeProviderType(provider),
    },
    clientFormat: resolveStepClientFormat(session),
    forceStreamHandling: isCodexResponsesStreamRequest(session),
    endpoint: { id: endpoint.endpointId, url: sanitizeUrl(endpoint.baseUrl) },
    method: session.method,
    url,
    headers: headersToPairs(headers),
    bodyOps,
    delayMs: params.delayMs,
    isStreaming,
    timeouts: {
      connectMs: env.FETCH_CONNECT_TIMEOUT,
      firstByteMs:
        provider.firstByteTimeoutStreamingMs > 0 ? provider.firstByteTimeoutStreamingMs : 0,
      nonStreamTotalMs:
        provider.requestTimeoutNonStreamingMs > 0 ? provider.requestTimeoutNonStreamingMs : 0,
      idleMs: provider.streamingIdleTimeoutMs > 0 ? provider.streamingIdleTimeoutMs : 0,
      headersMs: env.FETCH_HEADERS_TIMEOUT,
      bodyMs: env.FETCH_BODY_TIMEOUT,
    },
    transport: {
      proxyUrl: provider.proxyUrl ?? null,
      proxyFallbackToDirect: provider.proxyFallbackToDirect ?? false,
      http2: await isHttp2Enabled(),
    },
    gate: {
      mode: resolveStreamGateMode(),
      highConcurrency: session.isHighConcurrencyModeEnabled(),
      idleMs: provider.streamingIdleTimeoutMs > 0 ? provider.streamingIdleTimeoutMs : 0,
      eventCap: caps.prebufferEventCap,
      byteCap: caps.prebufferByteCap,
      captureCommitMarker: !session.isHighConcurrencyModeEnabled(),
    },
    fixer: {
      enabled: settings.enableResponseFixer ?? true,
      ...(settings.responseFixerConfig ?? DEFAULT_RESPONSE_FIXER_CONFIG),
    },
    hedge: params.hedge,
    reporting: {
      ...EDGE_REPORTING_LIMITS,
      heartbeatIntervalMs: params.heartbeatIntervalMs,
    },
    clientAbortDrainMs: EDGE_CLIENT_ABORT_DRAIN_MS,
  };
}
