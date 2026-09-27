/**
 * edge 请求的逐步编排（串行路径）。
 *
 * 等价于 ProxyForwarder.sendInternal 的串行循环，只是把"发起 fetch"换成"下发 ExecutionStep"，
 * 把 catch 块换成远端上报的失败事件；每步之间的全部状态保存在 EdgeRequestState 中。
 * 失败决策直接复用 ProxyForwarder.handleSerialAttemptFailure，保证与本地决策表一致。
 */
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { SessionTracker } from "@/lib/session-tracker";
import { isVendorTypeCircuitOpen } from "@/lib/vendor-type-circuit-breaker";
import type { Provider } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";
import { ProxyErrorHandler } from "../proxy/error-handler";
import { sanitizeUrl } from "../proxy/errors";
import {
  buildEndpointAttemptKey,
  clampRetryAttempts,
  MAX_PROVIDER_SWITCHES,
  ProxyForwarder,
  resolveMaxAttemptsForProvider,
  tryApplyEdgeReactiveRectifier,
} from "../proxy/forwarder";
import type { ProxySession } from "../proxy/session";
import type { ExecutionStep, FailResponse } from "./contract";
import { responseToFailPayload } from "./error-shaping";
import type { EdgeProviderAttemptState, EdgeRequestState } from "./state-store";
import { buildExecutionStep } from "./step-builder";

export interface EdgeRuntime {
  state: EdgeRequestState;
  session: ProxySession;
  settings: SystemSettings;
  /** 本次调用内还原的最近一次失败错误（供全部耗尽时构造 503 文案） */
  lastError?: Error | null;
}

export type EdgeStepOutcome =
  | { kind: "step"; step: ExecutionStep }
  | { kind: "fail"; response: FailResponse };

export function buildStepId(
  requestId: number,
  totalProvidersAttempted: number,
  attemptNumber: number,
  suffix = ""
): string {
  return `${requestId}:${totalProvidersAttempted}:${attemptNumber}${suffix}`;
}

function currentProviderState(rt: EdgeRuntime): EdgeProviderAttemptState | null {
  const providerId = rt.session.provider?.id;
  if (providerId == null) return null;
  for (let index = rt.state.providerAttempts.length - 1; index >= 0; index -= 1) {
    const entry = rt.state.providerAttempts[index];
    if (entry.providerId === providerId) return entry;
  }
  return null;
}

/**
 * 进入一个新供应商：解析端点候选、检查 vendor-type 熔断（与本地外层循环头部一致）。
 * 返回 null 表示该供应商不可用且已记入失败列表。
 */
export async function enterProvider(
  rt: EdgeRuntime,
  provider: Provider
): Promise<EdgeProviderAttemptState | null> {
  const { state, session } = rt;
  state.totalProvidersAttempted += 1;
  session.setProvider(provider);

  const env = getEnvConfig();
  const rawCrossProviderFallbackEnabled = session.isRawCrossProviderFallbackEnabled();
  let maxAttemptsPerProvider = resolveMaxAttemptsForProvider(
    provider,
    clampRetryAttempts(env.MAX_RETRY_ATTEMPTS_DEFAULT)
  );
  if (rawCrossProviderFallbackEnabled) {
    maxAttemptsPerProvider = 1;
  }
  const endpointPolicy = session.getEndpointPolicy();
  const shouldSkipRawRetryAndProviderSwitch =
    !endpointPolicy.allowRetry && !rawCrossProviderFallbackEnabled;

  const resolved = await ProxyForwarder.resolveSerialEndpointCandidates({
    session,
    provider,
    maxAttemptsPerProvider,
    shouldSkipRawRetryAndProviderSwitch,
    failedProviderIds: state.failedProviderIds,
  });
  if (resolved.blocked) return null;

  if (
    !resolved.isMcpRequest &&
    provider.providerVendorId &&
    (await isVendorTypeCircuitOpen(provider.providerVendorId, provider.providerType))
  ) {
    logger.warn("[EdgeCoordinator] Vendor-type circuit is open, skipping provider", {
      providerId: provider.id,
      vendorId: provider.providerVendorId,
      providerType: provider.providerType,
    });
    ProxyForwarder.markProviderFailed(session, state.failedProviderIds, provider.id);
    return null;
  }

  const entry: EdgeProviderAttemptState = {
    providerId: provider.id,
    attemptCount: 0,
    maxAttemptsPerProvider,
    currentEndpointIndex: 0,
    endpointCandidates: resolved.endpointCandidates,
    timedOutEndpointKeys: [],
    reactiveRectifierRetryState: {
      thinkingSignatureRetried: false,
      thinkingBudgetRetried: false,
      thinkingEffortConflictRetried: false,
      geminiFunctionIdRetried: false,
    },
    applyProviderOverrides: true,
    isMcpRequest: resolved.isMcpRequest,
    shouldAccountCircuitBreaker: resolved.shouldAccountCircuitBreaker,
  };
  state.providerAttempts.push(entry);
  return entry;
}

async function buildSerialStep(
  rt: EdgeRuntime,
  entry: EdgeProviderAttemptState,
  delayMs: number
): Promise<ExecutionStep> {
  const { state, session } = rt;
  const provider = session.provider;
  if (!provider) throw new Error("edge session is missing provider");
  entry.attemptCount += 1;
  const endpointIndex =
    entry.endpointCandidates.length > 0
      ? Math.min(entry.currentEndpointIndex, entry.endpointCandidates.length - 1)
      : 0;
  const endpoint = entry.endpointCandidates[endpointIndex];
  const applyProviderOverrides = entry.applyProviderOverrides;
  entry.applyProviderOverrides = false;

  const stepId = buildStepId(state.requestId, state.totalProvidersAttempted, entry.attemptCount);
  const step = await buildExecutionStep({
    session,
    body: state.body,
    provider,
    endpoint,
    stepId,
    attemptNumber: entry.attemptCount,
    totalProvidersAttempted: state.totalProvidersAttempted,
    attemptKind: "normal",
    applyProviderOverrides,
    delayMs,
    hedge: null,
    heartbeatIntervalMs: state.heartbeatIntervalMs,
    settings: rt.settings,
  });
  state.attempts.push({
    stepId,
    kind: "normal",
    providerId: provider.id,
    endpointId: endpoint.endpointId,
    baseUrl: endpoint.baseUrl,
    attemptNumber: entry.attemptCount,
    totalProvidersAttempted: state.totalProvidersAttempted,
    sequence: state.totalProvidersAttempted,
    status: "inflight",
    isStreaming: step.isStreaming,
  });
  return step;
}

/**
 * 终态失败：走本地同一个错误处理器（写终态行、结束追踪、错误覆写、会话 ID 后缀），
 * 并释放 decide 时占用的并发计数。
 */
export async function settleEdgeFailure(rt: EdgeRuntime, error: Error): Promise<FailResponse> {
  const response = await ProxyErrorHandler.handle(rt.session, error);
  await releaseEdgeConcurrency(rt.state);
  rt.state.phase = "settled";
  return responseToFailPayload(response);
}

export async function releaseEdgeConcurrency(state: EdgeRequestState): Promise<void> {
  const { sessionId, observedIdentity } = state.concurrency;
  state.concurrency = { sessionId: null, observedIdentity: null };
  if (sessionId) {
    await SessionTracker.decrementConcurrentCount(sessionId).catch((error) => {
      logger.warn("[EdgeCoordinator] Failed to release concurrent count", { error });
    });
  }
  if (observedIdentity) {
    await SessionTracker.decrementObservedConcurrentCount(observedIdentity).catch((error) => {
      logger.warn("[EdgeCoordinator] Failed to release observed concurrent count", { error });
    });
  }
}

/**
 * 找到下一个可发起的 attempt：当前供应商仍有额度则继续，否则切换供应商；
 * 全部耗尽时返回终态 503（与本地 "All providers failed" 一致）。
 */
export async function planNextSerialStep(rt: EdgeRuntime, delayMs = 0): Promise<EdgeStepOutcome> {
  const { state, session } = rt;
  let entry = currentProviderState(rt);

  while (state.totalProvidersAttempted <= MAX_PROVIDER_SWITCHES) {
    if (entry && entry.attemptCount < entry.maxAttemptsPerProvider) {
      return { kind: "step", step: await buildSerialStep(rt, entry, delayMs) };
    }
    if (state.totalProvidersAttempted >= MAX_PROVIDER_SWITCHES) break;

    const alternative = await ProxyForwarder.selectAlternative(session, state.failedProviderIds);
    if (!alternative) break;
    entry = await enterProvider(rt, alternative);
    delayMs = 0;
  }

  if (state.totalProvidersAttempted >= MAX_PROVIDER_SWITCHES) {
    logger.error("[EdgeCoordinator] Exceeded max provider switches (safety limit)", {
      requestId: state.requestId,
      totalProvidersAttempted: state.totalProvidersAttempted,
    });
  }
  const attempted = new Set(state.failedProviderIds);
  if (session.provider?.id != null) attempted.add(session.provider.id);
  await ProxyForwarder.clearSessionProviderBindings(session, attempted);
  const lastError = rt.lastError ?? null;
  return {
    kind: "fail",
    response: await settleEdgeFailure(
      rt,
      ProxyForwarder.buildAllProvidersUnavailableError(lastError)
    ),
  };
}

/**
 * 处理串行 attempt 的失败（等价于本地 catch 块 + 循环控制）。
 */
export async function handleSerialFailure(
  rt: EdgeRuntime,
  params: {
    stepId: string;
    error: Error;
    dispatched: boolean;
    firstByteSeen: boolean;
    healthElapsedMs: number;
  }
): Promise<EdgeStepOutcome> {
  const { state, session } = rt;
  const attempt = state.attempts.find((candidate) => candidate.stepId === params.stepId);
  const entry = currentProviderState(rt);
  const provider = session.provider;
  if (!attempt || !entry || !provider) {
    throw new Error(`edge attempt ${params.stepId} does not match the current provider`);
  }
  attempt.status = "failed";
  rt.lastError = params.error;

  const endpointIndex = Math.min(
    entry.currentEndpointIndex,
    Math.max(0, entry.endpointCandidates.length - 1)
  );
  const activeEndpoint = entry.endpointCandidates[endpointIndex];
  const timedOutEndpointKeys = new Set(entry.timedOutEndpointKeys);
  const endpointPolicy = session.getEndpointPolicy();
  const rawCrossProviderFallbackEnabled = session.isRawCrossProviderFallbackEnabled();

  const decision = await ProxyForwarder.handleSerialAttemptFailure({
    session,
    provider,
    error: params.error,
    activeEndpoint,
    endpointAudit: {
      endpointId: activeEndpoint.endpointId,
      endpointUrl: sanitizeUrl(activeEndpoint.baseUrl),
    },
    endpointPolicy,
    attemptCount: entry.attemptCount,
    maxAttemptsPerProvider: entry.maxAttemptsPerProvider,
    totalProvidersAttempted: state.totalProvidersAttempted,
    rawCrossProviderFallbackEnabled,
    shouldSkipRawRetryAndProviderSwitch:
      !endpointPolicy.allowRetry && !rawCrossProviderFallbackEnabled,
    shouldAccountCircuitBreaker: entry.shouldAccountCircuitBreaker,
    isMcpRequest: entry.isMcpRequest,
    endpointCandidateKeys: new Set(
      entry.endpointCandidates.map((candidate) =>
        buildEndpointAttemptKey(candidate.endpointId, candidate.baseUrl)
      )
    ),
    timedOutEndpointKeys,
    failedProviderIds: state.failedProviderIds,
    reactiveRectifierRetryState: entry.reactiveRectifierRetryState,
    currentEndpointIndex: entry.currentEndpointIndex,
    endpointCandidateCount: entry.endpointCandidates.length,
    attemptDispatched: params.dispatched,
    attemptFirstByteSeen: params.firstByteSeen,
    getAttemptElapsedMs: () => params.healthElapsedMs,
    applyReactiveRectifier: tryApplyEdgeReactiveRectifier,
  });
  entry.timedOutEndpointKeys = Array.from(timedOutEndpointKeys);

  if (decision.action === "throw") {
    return { kind: "fail", response: await settleEdgeFailure(rt, decision.error) };
  }
  if (decision.action === "switch_provider") {
    entry.attemptCount = entry.maxAttemptsPerProvider;
    return planNextSerialStep(rt);
  }

  entry.maxAttemptsPerProvider = decision.maxAttemptsPerProvider;
  if (decision.advanceEndpoint) {
    entry.currentEndpointIndex += 1;
  }
  if (decision.rectifierType === "thinking_signature_rectifier") {
    state.body.contentOps.push({ op: "apply_thinking_signature_rectifier" });
    state.pendingRectifierAudits.push({
      stepId: buildStepId(state.requestId, state.totalProvidersAttempted, entry.attemptCount + 1),
      trigger: decision.rectifierTrigger ?? "",
      providerId: provider.id,
      attemptNumber: entry.attemptCount,
      retryAttemptNumber: entry.attemptCount + 1,
    });
  }
  return planNextSerialStep(rt, decision.delayMs);
}
