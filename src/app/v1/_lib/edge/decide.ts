/**
 * POST /api/internal/edge/decide
 *
 * 按本地 CHAT_PIPELINE 的顺序在 edge 会话（合成请求体 + 预计算摘要）上运行守卫链，
 * 通过后创建 message_request、占用并发计数，并返回第一个 ExecutionStep。
 * 资格判定都在计数型副作用之前完成，delegate 的请求交回本地代理时不会被重复计数。
 */
import { getCachedSystemSettings } from "@/lib/config";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { ProxyStatusTracker } from "@/lib/proxy-status-tracker";
import { sensitiveWordDetector } from "@/lib/sensitive-word-detector";
import { SessionTracker } from "@/lib/session-tracker";
import type { SystemSettings } from "@/types/system-config";
import { ProxyAuthenticator } from "../proxy/auth-guard";
import { ProxyClientGuard } from "../proxy/client-guard";
import { ProxyErrorHandler } from "../proxy/error-handler";
import { attachSessionIdToErrorResponse } from "../proxy/error-session-id";
import { detectFormatByEndpoint } from "../proxy/format-mapper";
import {
  buildRoutingTraceConfig,
  ProxyForwarder,
  resolveRoutingTraceSessionTtlSeconds,
} from "../proxy/forwarder";
import { ProxyMessageService } from "../proxy/message-service";
import { ProxyModelGuard } from "../proxy/model-guard";
import { ProxyProviderRequestFilter } from "../proxy/provider-request-filter";
import { ProxyProviderResolver } from "../proxy/provider-selector";
import { ProxyRateLimitGuard } from "../proxy/rate-limit-guard";
import { ProxyRequestFilter } from "../proxy/request-filter";
import type { ProxySession } from "../proxy/session";
import { ProxySessionGuard } from "../proxy/session-guard";
import { ProxyVersionGuard } from "../proxy/version-guard";
import { trackObservedSessionForRequest } from "../proxy-handler";
import type { DecideResponse, FailResponse, RequestDigest } from "./contract";
import {
  type EdgeRuntime,
  enterProvider,
  planNextSerialStep,
  releaseEdgeConcurrency,
} from "./coordinator";
import { createEdgeSessionFromDigest } from "./digest";
import { evaluateProviderEligibility, evaluateRequestEligibility } from "./eligibility";
import { responseToFailPayload } from "./error-shaping";
import {
  type EdgeRequestState,
  generateEdgeToken,
  getIdempotentResponse,
  isEdgeStateStoreAvailable,
  saveEdgeState,
  scheduleEdgeDeadline,
  setIdempotentResponse,
} from "./state-store";

const DECIDE_IDEMPOTENCY_TTL_SECONDS = 120;

class EdgeDelegate {
  constructor(readonly reason: string) {}
}

async function failFromResponse(session: ProxySession, response: Response): Promise<FailResponse> {
  return responseToFailPayload(await attachSessionIdToErrorResponse(session.sessionId, response));
}

async function hasBodyFilters(session: ProxySession, phase: "global" | "provider" | "final") {
  const { requestFilterEngine } = await import("@/lib/request-filter-engine");
  return requestFilterEngine.hasBodyFiltersForEdge(session, phase);
}

/**
 * 与本地 CHAT_PIPELINE 相同的守卫顺序（sensitive / probe / warmup / replayAttach 由资格判定
 * 替代：命中即 delegate）。返回 Response 表示守卫早退，EdgeDelegate 表示交回本地。
 */
async function runEdgeGuards(
  session: ProxySession,
  settings: SystemSettings
): Promise<Response | EdgeDelegate | null> {
  const authResponse = await ProxyAuthenticator.ensure(session);
  if (authResponse) return authResponse;
  const clientResponse = await ProxyClientGuard.ensure(session);
  if (clientResponse) return clientResponse;
  const modelResponse = await ProxyModelGuard.ensure(session);
  if (modelResponse) return modelResponse;
  const versionResponse = await ProxyVersionGuard.ensure(session);
  if (versionResponse) return versionResponse;

  await ProxySessionGuard.ensure(session);
  await ProxyRequestFilter.ensure(session);

  await ProxyRateLimitGuard.ensure(session);
  const providerResponse = await ProxyProviderResolver.ensure(session);
  if (providerResponse) return providerResponse;

  const provider = session.provider;
  if (!provider) return new EdgeDelegate("no_provider");
  await ProxyProviderRequestFilter.ensure(session);
  if (wouldUseLegacyHedge(session)) {
    // legacy hedge 竞速尚未在 edge 侧实现：交回本地，保持与本地完全一致的竞速语义
    ProxyForwarder.releaseProviderSessionRef(session, provider.id);
    return new EdgeDelegate("hedge_pending");
  }
  const providerEligibility = evaluateProviderEligibility({
    provider,
    requestedModel: session.request.model ?? "",
    settings,
    providerBodyFiltersConfigured:
      (await hasBodyFilters(session, "provider")) || (await hasBodyFilters(session, "final")),
  });
  if (!providerEligibility.eligible) {
    // 撤销本请求在 provider 守卫中占用的供应商会话引用，交回本地后会重新获取
    ProxyForwarder.releaseProviderSessionRef(session, provider.id);
    return new EdgeDelegate(providerEligibility.reason);
  }

  await ProxyMessageService.ensureContext(session);
  return null;
}

/** 与 ProxyForwarder.shouldUseStreamingHedge 相同的判定（discovery 已由资格判定排除） */
function wouldUseLegacyHedge(session: ProxySession): boolean {
  const endpointPolicy = session.getEndpointPolicy();
  return (
    !session.isStreamingHedgeDisabled() &&
    endpointPolicy.allowRetry &&
    endpointPolicy.allowProviderSwitch &&
    (session.request.message as Record<string, unknown>).stream === true &&
    (session.provider?.firstByteTimeoutStreamingMs ?? 0) > 0
  );
}

function resolveSystemSettingsForSession(session: ProxySession, settings: SystemSettings): void {
  session.setHighConcurrencyModeEnabled(settings.enableHighConcurrencyMode ?? false);
  session.setRawCrossProviderFallbackEnabled(
    settings.allowNonConversationEndpointProviderFallback ?? true
  );
  const format = detectFormatByEndpoint(session.requestUrl.pathname);
  if (format) session.setOriginalFormat(format);
}

export async function handleEdgeDecide(
  digest: RequestDigest,
  edgeId: string
): Promise<DecideResponse> {
  if (!isEdgeStateStoreAvailable()) {
    return { action: "delegate", reason: "state_store_unavailable" };
  }

  const idempotencyScope = `decide:${edgeId}:${digest.edgeRequestId}`;
  const cached = await getIdempotentResponse<DecideResponse>(idempotencyScope);
  if (cached) return cached;

  const response = await decideOnce(digest, edgeId);
  await setIdempotentResponse(idempotencyScope, response, DECIDE_IDEMPOTENCY_TTL_SECONDS);
  return response;
}

async function decideOnce(digest: RequestDigest, edgeId: string): Promise<DecideResponse> {
  const settings = await getCachedSystemSettings();
  const session = createEdgeSessionFromDigest(digest);

  const requestEligibility = evaluateRequestEligibility({
    digest,
    settings,
    headers: session.headers,
    sensitiveWordsConfigured: !sensitiveWordDetector.isEmpty(),
    globalBodyFiltersConfigured: await hasBodyFilters(session, "global"),
  });
  if (!requestEligibility.eligible) {
    return { action: "delegate", reason: requestEligibility.reason };
  }

  resolveSystemSettingsForSession(session, settings);

  let guardResult: Response | EdgeDelegate | null;
  try {
    guardResult = await runEdgeGuards(session, settings);
  } catch (error) {
    const response = await ProxyErrorHandler.handle(session, error as Error);
    return { action: "fail", response: await responseToFailPayload(response) };
  }
  if (guardResult instanceof EdgeDelegate) {
    return { action: "delegate", reason: guardResult.reason };
  }
  if (guardResult) {
    await trackObservedSessionForRequest(session);
    return { action: "fail", response: await failFromResponse(session, guardResult) };
  }

  const messageContext = session.messageContext;
  const provider = session.provider;
  if (!messageContext || !provider) {
    return { action: "delegate", reason: "missing_message_context" };
  }

  // 与本地处理器一致：守卫通过后记录可观测会话并占用并发计数
  const observedIdentity = await trackObservedSessionForRequest(session);
  const endpointPolicy = session.getEndpointPolicy();
  const concurrency = { sessionId: null as string | null, observedIdentity: null as string | null };
  if (session.sessionId && endpointPolicy.trackConcurrentRequests) {
    await SessionTracker.incrementConcurrentCount(session.sessionId);
    concurrency.sessionId = session.sessionId;
  }
  if (observedIdentity && endpointPolicy.trackConcurrentRequests) {
    await SessionTracker.incrementObservedConcurrentCount(observedIdentity);
    concurrency.observedIdentity = observedIdentity;
  }
  ProxyStatusTracker.getInstance().startRequest({
    userId: messageContext.user.id,
    userName: messageContext.user.name,
    requestId: messageContext.id,
    keyName: messageContext.key.name,
    providerId: provider.id,
    providerName: provider.name,
    model: session.request.model || "unknown",
  });
  session.recordForwardStart();

  const env = getEnvConfig();
  const singleUpstream =
    (session.isStreamingHedgeDisabled() && !session.isSessionBindingAllowed()) ||
    !endpointPolicy.allowRetry ||
    !endpointPolicy.allowProviderSwitch;
  session.initializeRoutingTrace({
    mode: singleUpstream ? "single_upstream" : "legacy_serial",
    discoveryEnabled: settings.discoveryEnabled === true,
    eligible: false,
    bypassReason: digest.topLevel.stream === true ? "disabled" : "non_streaming",
    startedAt: Date.now(),
    config: buildRoutingTraceConfig(settings, resolveRoutingTraceSessionTtlSeconds()),
  });

  const state: EdgeRequestState = {
    v: 1,
    requestId: messageContext.id,
    edgeToken: generateEdgeToken(),
    edgeId,
    phase: "executing",
    mode: "serial",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    heartbeatIntervalMs: env.CCH_EDGE_HEARTBEAT_INTERVAL_MS,
    session: session.toEdgeSnapshot(),
    body: {
      originalTopLevel: structuredClone(digest.topLevel) as Record<string, unknown>,
      hasPrivateParams: digest.hasPrivateParams,
      contentOps: [],
    },
    attempts: [],
    totalProvidersAttempted: 0,
    failedProviderIds: [],
    providerAttempts: [],
    hedge: null,
    pendingRectifierAudits: [],
    billingHeaderAudited: false,
    lastFailure: null,
    concurrency,
  };
  const rt: EdgeRuntime = { state, session, settings };

  let outcome: Awaited<ReturnType<typeof planNextSerialStep>>;
  try {
    await enterProvider(rt, provider);
    outcome = await planNextSerialStep(rt);
  } catch (error) {
    logger.error("[EdgeDecide] Failed to plan the first execution step", {
      requestId: state.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    const response = await ProxyErrorHandler.handle(session, error as Error);
    await releaseEdgeConcurrency(state);
    return { action: "fail", response: await responseToFailPayload(response) };
  }

  if (outcome.kind === "fail") {
    return { action: "fail", response: outcome.response };
  }

  state.session = session.toEdgeSnapshot();
  await saveEdgeState(state, env.CCH_EDGE_STATE_TTL_SECONDS);
  await scheduleEdgeDeadline(state.requestId, Date.now() + 3 * state.heartbeatIntervalMs);

  logger.info("[EdgeDecide] Execute", {
    requestId: state.requestId,
    edgeId,
    mode: state.mode,
    providerId: outcome.step.provider.id,
    stepId: outcome.step.stepId,
  });

  return {
    action: "execute",
    requestId: state.requestId,
    edgeToken: state.edgeToken,
    step: outcome.step,
  };
}
