/**
 * edge 请求的 legacy hedge 竞速编排。
 *
 * 对应本地 ProxyForwarder.sendStreamingWithHedge：远端并行执行各 attempt，本模块在事件驱动下
 * 复刻本地闭包里的状态机（启动、阈值触发、失败处理、胜者提交、输家计费），状态经
 * EdgeHedgeState 在调用之间持久化。单个 attempt 的失败归类与记账复用
 * ProxyForwarder.handleHedgeAttemptFailure，与本地共享同一决策表。
 */
import { getCircuitState, recordFailure } from "@/lib/circuit-breaker";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { isLocalCapacityError } from "@/lib/memory/governor";
import { RateLimitService } from "@/lib/rate-limit";
import { SessionManager } from "@/lib/session-manager";
import type { Provider } from "@/types/provider";
import type { RoutingTraceSummaryV1 } from "@/types/routing-trace";
import { ErrorCategory, ProxyError } from "../proxy/errors";
import {
  CLIENT_ABORT_HEALTH_FALLBACK_THRESHOLD_MS,
  clampLegacyHedgeMaxInFlight,
  ProxyForwarder,
  tryApplyEdgeReactiveRectifier,
} from "../proxy/forwarder";
import { finalizeHedgeLoserBilling } from "../proxy/response-handler";
import { ProxySession } from "../proxy/session";
import {
  type DeferredStreamingHedgeBindingAuthority,
  setDeferredStreamingFinalization,
} from "../proxy/stream-finalization";
import type { ExecutionStep, FailResponse, LoserResult, NextEvent, WinnerResult } from "./contract";
import { type EdgeRuntime, type EdgeStepOutcome, settleEdgeFailure } from "./coordinator";
import { attemptFailureToError } from "./failure-errors";
import type {
  EdgeErrorDescriptor,
  EdgeHedgeParticipant,
  EdgeHedgeState,
  EdgeRequestState,
} from "./state-store";
import { buildExecutionStep } from "./step-builder";

/** 与本地 HEDGE_TRACE_ROUND 一致：legacy hedge 是单轮并行 */
const HEDGE_TRACE_ROUND = 1;

export type EdgeHedgeOutcome =
  | { kind: "launch"; step: ExecutionStep }
  | { kind: "retry"; step: ExecutionStep }
  | { kind: "wait" }
  | { kind: "none" }
  | { kind: "fail"; response: FailResponse };

type LaunchResult = { kind: "launched"; step: ExecutionStep } | { kind: "none" };

class HedgeLaunchError extends Error {}

function hedgeState(state: EdgeRequestState): EdgeHedgeState {
  if (!state.hedge) throw new Error("edge request is not in hedge mode");
  return state.hedge;
}

function inflightParticipants(hedge: EdgeHedgeState): EdgeHedgeParticipant[] {
  return hedge.participants.filter((participant) => participant.status === "inflight");
}

export function findHedgeParticipant(
  state: EdgeRequestState,
  stepId: string
): EdgeHedgeParticipant | null {
  return state.hedge?.participants.find((participant) => participant.stepId === stepId) ?? null;
}

function setAttemptStatus(
  state: EdgeRequestState,
  stepId: string,
  status: EdgeRequestState["attempts"][number]["status"]
): void {
  const attempt = state.attempts.find((candidate) => candidate.stepId === stepId);
  if (attempt) attempt.status = status;
}

// ---------------------------------------------------------------------------
// 参与者会话：首个参与者复用原会话，其余参与者使用影子会话（快照持久化）
// ---------------------------------------------------------------------------

export function participantSession(
  rt: EdgeRuntime,
  participant: EdgeHedgeParticipant
): ProxySession {
  if (participant.useOriginalSession) return rt.session;
  rt.hedgeSessions ??= new Map();
  const cached = rt.hedgeSessions.get(participant.sequence);
  if (cached) return cached;
  if (!participant.shadow) throw new Error("hedge participant is missing its shadow session");
  const shadow = ProxySession.fromEdgeSnapshot(participant.shadow);
  rt.hedgeSessions.set(participant.sequence, shadow);
  return shadow;
}

/** 把本次调用内改动过的影子会话写回参与者快照 */
export function flushHedgeSessions(rt: EdgeRuntime): void {
  if (!rt.hedgeSessions || !rt.state.hedge) return;
  for (const participant of rt.state.hedge.participants) {
    const shadow = rt.hedgeSessions.get(participant.sequence);
    if (shadow) participant.shadow = shadow.toEdgeSnapshot();
  }
}

function participantProvider(_rt: EdgeRuntime, participant: EdgeHedgeParticipant): Provider {
  return participant.provider;
}

function endpointAudit(participant: EdgeHedgeParticipant) {
  return { endpointId: participant.endpointId, endpointUrl: participant.endpointUrl };
}

function getParticipantModelRedirect(rt: EdgeRuntime, participant: EdgeHedgeParticipant) {
  if (participant.modelRedirect !== undefined && participant.modelRedirect !== null) {
    return participant.modelRedirect;
  }
  const redirect = participantSession(rt, participant).getCurrentModelRedirect(
    participant.providerId
  );
  if (redirect) participant.modelRedirect = structuredClone(redirect);
  return participant.modelRedirect ?? undefined;
}

// ---------------------------------------------------------------------------
// lastError 的序列化与重建
// ---------------------------------------------------------------------------

function describeError(error: Error, providerId: number | null): EdgeErrorDescriptor {
  if (error instanceof ProxyError) {
    return {
      kind: "proxy",
      message: error.message,
      statusCode: error.statusCode,
      ...(error.upstreamError?.providerId != null
        ? { providerId: error.upstreamError.providerId }
        : providerId != null
          ? { providerId }
          : {}),
      ...(error.upstreamError?.providerName
        ? { providerName: error.upstreamError.providerName }
        : {}),
    };
  }
  return { kind: "proxy", message: error.message, statusCode: 503 };
}

function rebuildError(rt: EdgeRuntime, descriptor: EdgeErrorDescriptor | null): Error | null {
  if (!descriptor) return null;
  switch (descriptor.kind) {
    case "failure": {
      const provider = findProviderById(rt, descriptor.providerId);
      return provider ? attemptFailureToError(descriptor.failure, provider) : null;
    }
    case "proxy":
      return new ProxyError(descriptor.message, descriptor.statusCode, {
        body: "",
        ...(descriptor.providerId != null ? { providerId: descriptor.providerId } : {}),
        ...(descriptor.providerName ? { providerName: descriptor.providerName } : {}),
      });
    case "all_unavailable":
      return ProxyForwarder.buildAllProvidersUnavailableError(rebuildError(rt, descriptor.inner));
    case "client_abort":
      return new ProxyError("Request aborted by client", 499, undefined, true);
  }
}

function findProviderById(rt: EdgeRuntime, providerId: number): Provider | null {
  for (const participant of rt.state.hedge?.participants ?? []) {
    if (participant.providerId === providerId) return participantProvider(rt, participant);
  }
  if (rt.session.provider?.id === providerId) return rt.session.provider;
  return (
    rt.state.session.providersSnapshot?.find((candidate) => candidate.id === providerId) ?? null
  );
}

// ---------------------------------------------------------------------------
// routing trace（与本地 traceAttemptStarted / traceAttemptFinished / hedgeMetrics 对齐）
// ---------------------------------------------------------------------------

function traceProvider(provider: Provider) {
  return { id: provider.id, name: provider.name, priority: provider.priority || 0 };
}

function traceAttemptStarted(rt: EdgeRuntime, participant: EdgeHedgeParticipant): void {
  const hedge = hedgeState(rt.state);
  hedge.metrics.attempts += 1;
  hedge.metrics.active += 1;
  hedge.metrics.maxActive = Math.max(hedge.metrics.maxActive, hedge.metrics.active);
  participant.startedAtMs = Date.now();
  rt.session.appendRoutingTraceEvent({
    type: "attempt_started",
    attemptId: participant.attemptId,
    attemptKind: "normal",
    round: HEDGE_TRACE_ROUND,
    provider: traceProvider(participantProvider(rt, participant)),
    activeAttemptCount: inflightParticipants(hedge).length,
    configuredCap: hedge.maxInFlight,
  });
}

function traceAttemptFinished(
  rt: EdgeRuntime,
  participant: EdgeHedgeParticipant,
  context: {
    outcome: "winner" | "failed" | "cancelled" | "client_abort";
    cancellationKind?: string;
    statusCode?: number;
    reason?: string;
  }
): void {
  const hedge = hedgeState(rt.state);
  hedge.metrics.active = Math.max(0, hedge.metrics.active - 1);
  hedge.metrics.providerMs += Math.max(0, Date.now() - participant.startedAtMs);
  rt.session.appendRoutingTraceEvent({
    type: "attempt_finished",
    attemptId: participant.attemptId,
    attemptKind: "normal",
    round: HEDGE_TRACE_ROUND,
    provider: traceProvider(participantProvider(rt, participant)),
    outcome: context.outcome,
    ...(context.cancellationKind ? { cancellationKind: context.cancellationKind } : {}),
    ...(context.statusCode != null ? { statusCode: context.statusCode } : {}),
    ...(context.reason ? { reason: context.reason } : {}),
  });
}

function buildHedgeSummary(
  rt: EdgeRuntime,
  context: {
    outcome: "success" | "failed" | "client_abort";
    statusCode: number;
    winnerProviderId?: number;
  }
): RoutingTraceSummaryV1 {
  const hedge = hedgeState(rt.state);
  const elapsedMs = Math.max(0, Date.now() - rt.state.createdAtMs);
  return {
    outcome: context.outcome,
    statusCode: context.statusCode,
    durationMs: elapsedMs,
    ttftMs: context.outcome === "success" ? elapsedMs : null,
    attemptsPerRequest: hedge.metrics.attempts,
    maxActiveAttempts: hedge.metrics.maxActive,
    rounds: hedge.metrics.attempts > 0 ? HEDGE_TRACE_ROUND : 0,
    providerMs: hedge.metrics.providerMs,
    fallbackPromotions: 0,
    cancelFailures: 0,
    winnerOrigin: context.outcome === "success" ? "normal" : "none",
    winnerProviderId: context.winnerProviderId ?? null,
    winnerRound: context.outcome === "success" ? HEDGE_TRACE_ROUND : null,
  };
}

// ---------------------------------------------------------------------------
// 启动 / 竞速
// ---------------------------------------------------------------------------

export function initHedgeState(
  state: EdgeRequestState,
  params: { initialProvider: Provider; maxInFlight: number | null | undefined; billLosers: boolean }
): void {
  state.mode = "hedge";
  state.hedge = {
    launchedProviderIds: [],
    launchedProviderCount: 0,
    noMoreProviders: false,
    maxInFlight: clampLegacyHedgeMaxInFlight(params.maxInFlight),
    billLosers: params.billLosers,
    initialProviderId: params.initialProvider.id,
    participants: [],
    lastError: null,
    lastErrorCategory: null,
    metrics: { attempts: 0, active: 0, maxActive: 0, providerMs: 0 },
  };
}

async function buildParticipantStep(
  rt: EdgeRuntime,
  participant: EdgeHedgeParticipant
): Promise<ExecutionStep> {
  const { state } = rt;
  const hedge = hedgeState(state);
  const session = participantSession(rt, participant);
  const provider = participantProvider(rt, participant);
  const applyProviderOverrides = participant.applyProviderOverrides;
  participant.applyProviderOverrides = false;

  const stepId = `${state.requestId}:h${participant.sequence}:${participant.requestAttemptCount}`;
  const firstByteTimeoutMs =
    provider.firstByteTimeoutStreamingMs > 0 ? provider.firstByteTimeoutStreamingMs : 0;
  const step = await buildExecutionStep({
    session,
    body: participant.body ?? state.body,
    provider,
    endpoint: { endpointId: participant.endpointId, baseUrl: participant.baseUrl },
    stepId,
    attemptNumber: participant.requestAttemptCount,
    totalProvidersAttempted: hedge.launchedProviderCount,
    attemptKind: participant.sequence > 1 ? "hedge" : "normal",
    applyProviderOverrides,
    delayMs: 0,
    hedge: {
      thresholdMs: firstByteTimeoutMs,
      maxInFlight: hedge.maxInFlight,
      billLosers: participant.billAsLoser,
      loserDrainMs: getEnvConfig().HEDGE_LOSER_DRAIN_TIMEOUT_MS,
    },
    heartbeatIntervalMs: state.heartbeatIntervalMs,
    settings: rt.settings,
  });
  // 本地 runAttempt：并行上限 > 1 时首字节超时交给竞速阈值，不再单独判 524
  if (firstByteTimeoutMs > 0 && hedge.maxInFlight > 1) {
    step.timeouts.firstByteMs = 0;
  }

  participant.stepId = stepId;
  state.attempts.push({
    stepId,
    kind: step.attemptKind,
    providerId: provider.id,
    endpointId: participant.endpointId,
    baseUrl: participant.baseUrl,
    attemptNumber: participant.requestAttemptCount,
    totalProvidersAttempted: hedge.launchedProviderCount,
    sequence: participant.sequence,
    status: "inflight",
    isStreaming: step.isStreaming,
  });
  return step;
}

/** 本地 startAttempt：返回 null 表示该供应商无法发起（已记入失败） */
async function startAttempt(
  rt: EdgeRuntime,
  provider: Provider,
  useOriginalSession: boolean
): Promise<ExecutionStep | null> {
  const { state, session } = rt;
  const hedge = hedgeState(state);
  if (hedge.noMoreProviders || hedge.launchedProviderIds.includes(provider.id)) return null;
  hedge.launchedProviderIds.push(provider.id);

  if (!useOriginalSession && session.sessionId) {
    const checkResult = await RateLimitService.checkAndTrackProviderSession(
      provider.id,
      session.sessionId,
      provider.limitConcurrentSessions || 0
    );
    if (!checkResult.allowed) {
      ProxyForwarder.markProviderFailed(session, state.failedProviderIds, provider.id);
      session.addProviderToChain(provider, {
        reason: "concurrent_limit_failed",
        circuitState: getCircuitState(provider.id),
        attemptNumber: hedge.launchedProviderCount + 1,
        errorMessage: checkResult.reason || "并发限制已达到",
      });
      return null;
    }
    if (checkResult.referenced) {
      session.recordProviderSessionRef(provider.id, { retainOnSuccess: checkResult.tracked });
    }
  }

  let endpoint: { endpointId: number | null; baseUrl: string; endpointUrl: string };
  try {
    endpoint = await ProxyForwarder.resolveStreamingHedgeEndpoint(session, provider);
  } catch (endpointError) {
    hedge.lastError = describeError(endpointError as Error, provider.id);
    hedge.lastErrorCategory = null;
    ProxyForwarder.markProviderFailed(session, state.failedProviderIds, provider.id);
    return null;
  }

  hedge.launchedProviderCount += 1;
  const attemptSession = useOriginalSession
    ? session
    : ProxyForwarder.createStreamingShadowSession(session, provider);
  attemptSession.setProvider(provider);

  const participant: EdgeHedgeParticipant = {
    sequence: hedge.launchedProviderCount,
    providerId: provider.id,
    provider,
    endpointId: endpoint.endpointId,
    baseUrl: endpoint.baseUrl,
    endpointUrl: endpoint.endpointUrl,
    attemptId: `legacy-hedge-${hedge.launchedProviderCount}-1`,
    stepId: "",
    requestAttemptCount: 1,
    applyProviderOverrides: true,
    reactiveRectifierRetryState: {
      thinkingSignatureRetried: false,
      thinkingBudgetRetried: false,
      thinkingEffortConflictRetried: false,
      geminiFunctionIdRetried: false,
    },
    status: "inflight",
    thresholdTriggered: false,
    saturationRecorded: false,
    useOriginalSession,
    shadow: null,
    body: useOriginalSession ? null : structuredClone(state.body),
    // 只有存在可回写的请求行时才保活输家计费（与本地 billAsLoser 一致）
    billAsLoser: hedge.billLosers && session.messageContext?.id != null,
    startedAtMs: Date.now(),
  };
  hedge.participants.push(participant);
  if (!useOriginalSession) {
    rt.hedgeSessions ??= new Map();
    rt.hedgeSessions.set(participant.sequence, attemptSession);
  }
  traceAttemptStarted(rt, participant);

  if (hedge.launchedProviderCount > 1) {
    session.addProviderToChain(provider, {
      ...endpointAudit(participant),
      reason: "hedge_launched",
      attemptNumber: participant.sequence,
      circuitState: getCircuitState(provider.id),
    });
  }

  return buildParticipantStep(rt, participant);
}

/** 本地 launchAlternative：每次事件至多发起一个新参与者 */
async function launchAlternative(rt: EdgeRuntime): Promise<LaunchResult> {
  const { state, session } = rt;
  const hedge = hedgeState(state);
  if (hedge.noMoreProviders) return { kind: "none" };
  if (inflightParticipants(hedge).length >= hedge.maxInFlight) return { kind: "none" };

  try {
    while (!hedge.noMoreProviders) {
      const alternative = await ProxyForwarder.selectAlternative(
        session,
        Array.from(hedge.launchedProviderIds)
      );
      if (!alternative) {
        hedge.noMoreProviders = true;
        return { kind: "none" };
      }
      const step = await startAttempt(rt, alternative, false);
      if (step) return { kind: "launched", step };
    }
  } catch (error) {
    logger.error("[EdgeHedge] Failed to launch alternative provider", {
      requestId: state.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    hedge.lastError = { kind: "all_unavailable", inner: hedge.lastError };
    hedge.lastErrorCategory = null;
    hedge.noMoreProviders = true;
    abortAllParticipants(rt, null, "hedge_launch_failed");
    throw new HedgeLaunchError("hedge launch failed");
  }
  return { kind: "none" };
}

/** 本地 abortAttempt / abortAllAttempts（非胜者原因）：远端随 fail 响应取消全部在途 attempt */
function abortAllParticipants(
  rt: EdgeRuntime,
  winner: EdgeHedgeParticipant | null,
  reason: string
): void {
  const hedge = hedgeState(rt.state);
  for (const participant of inflightParticipants(hedge)) {
    if (winner && participant === winner) continue;
    participant.status = reason === "hedge_loser" ? "loser" : "failed";
    setAttemptStatus(rt.state, participant.stepId, participant.status);
    traceAttemptFinished(rt, participant, {
      outcome: reason === "client_abort" ? "client_abort" : "cancelled",
      cancellationKind: reason,
    });
  }
}

async function settleHedgeFailure(rt: EdgeRuntime, error: Error): Promise<EdgeHedgeOutcome> {
  const { state, session } = rt;
  const hedge = hedgeState(state);
  const attempted = new Set(hedge.launchedProviderIds);
  if (session.provider?.id != null) attempted.add(session.provider.id);
  if (!isLocalCapacityError(error)) {
    await ProxyForwarder.clearSessionProviderBindings(session, attempted);
  }
  session.setRoutingTraceSummary(
    buildHedgeSummary(rt, {
      outcome: hedge.lastErrorCategory === ErrorCategory.CLIENT_ABORT ? "client_abort" : "failed",
      statusCode: isLocalCapacityError(error)
        ? 429
        : error instanceof ProxyError
          ? error.statusCode
          : 500,
    })
  );
  return { kind: "fail", response: await settleEdgeFailure(rt, error) };
}

async function finishIfExhausted(rt: EdgeRuntime): Promise<EdgeHedgeOutcome | null> {
  const hedge = hedgeState(rt.state);
  if (!hedge.noMoreProviders || inflightParticipants(hedge).length > 0) return null;
  const lastError = rebuildError(rt, hedge.lastError);
  const lastErrorCategory = hedge.lastErrorCategory as ErrorCategory | null;
  return settleHedgeFailure(
    rt,
    ProxyForwarder.resolveHedgeTerminalError(lastError, lastErrorCategory)
  );
}

async function launchOrFinish(rt: EdgeRuntime): Promise<EdgeHedgeOutcome> {
  let launched: LaunchResult;
  try {
    launched = await launchAlternative(rt);
  } catch (error) {
    if (!(error instanceof HedgeLaunchError)) throw error;
    return (await finishIfExhausted(rt)) ?? { kind: "wait" };
  }
  if (launched.kind === "launched") return { kind: "launch", step: launched.step };
  return (await finishIfExhausted(rt)) ?? { kind: "wait" };
}

/**
 * decide 阶段：以原会话发起首个参与者；首个供应商无法发起时立即寻找备选。
 */
export async function startHedge(
  rt: EdgeRuntime,
  initialProvider: Provider
): Promise<EdgeStepOutcome> {
  const initial = await startAttempt(rt, initialProvider, true);
  if (initial) return { kind: "step", step: initial };
  const outcome = await launchOrFinish(rt);
  if (outcome.kind === "launch") return { kind: "step", step: outcome.step };
  if (outcome.kind === "fail") return { kind: "fail", response: outcome.response };
  // 没有在途参与者却也未耗尽（理论上不可达）：按全部不可用终结
  const fallback = await settleHedgeFailure(
    rt,
    ProxyForwarder.buildAllProvidersUnavailableError(
      rebuildError(rt, hedgeState(rt.state).lastError)
    )
  );
  if (fallback.kind !== "fail") throw new Error("unexpected hedge start outcome");
  return { kind: "fail", response: fallback.response };
}

// ---------------------------------------------------------------------------
// next 事件
// ---------------------------------------------------------------------------

/** 本地 triggerAttemptThreshold */
export async function handleHedgeThreshold(
  rt: EdgeRuntime,
  participant: EdgeHedgeParticipant
): Promise<EdgeHedgeOutcome> {
  const { session } = rt;
  const hedge = hedgeState(rt.state);
  if (participant.status !== "inflight" || participant.thresholdTriggered) return { kind: "none" };
  participant.thresholdTriggered = true;
  const provider = participantProvider(rt, participant);

  const active = inflightParticipants(hedge).length;
  if (active >= hedge.maxInFlight && !participant.saturationRecorded) {
    participant.saturationRecorded = true;
    const elapsedMs = Math.max(0, Date.now() - participant.startedAtMs);
    session.appendRoutingTraceEvent({
      type: "hedge_slot_saturated",
      attemptId: participant.attemptId,
      provider: traceProvider(provider),
      outcome: "slot_saturated",
      reason: "hedge_threshold",
      activeAttemptCount: active,
      configuredCap: hedge.maxInFlight,
      durationMs: elapsedMs,
      elapsedMs,
    });
  }
  session.addProviderToChain(provider, {
    ...endpointAudit(participant),
    reason: "hedge_triggered",
    attemptNumber: participant.sequence,
    circuitState: getCircuitState(provider.id),
  });

  try {
    const launched = await launchAlternative(rt);
    return launched.kind === "launched"
      ? { kind: "launch", step: launched.step }
      : { kind: "none" };
  } catch (error) {
    if (!(error instanceof HedgeLaunchError)) throw error;
    return (await finishIfExhausted(rt)) ?? { kind: "none" };
  }
}

/** 本地 handleAttemptFailure */
export async function handleHedgeFailure(
  rt: EdgeRuntime,
  participant: EdgeHedgeParticipant,
  params: { error: Error; errorDescriptor: EdgeErrorDescriptor }
): Promise<EdgeHedgeOutcome> {
  const { state, session } = rt;
  const hedge = hedgeState(state);
  if (participant.status !== "inflight") return { kind: "wait" };
  const { error } = params;
  hedge.lastError = params.errorDescriptor;

  const provider = participantProvider(rt, participant);
  const decision = await ProxyForwarder.handleHedgeAttemptFailure({
    session,
    attemptSession: participantSession(rt, participant),
    provider,
    endpointAudit: endpointAudit(participant),
    sequence: participant.sequence,
    requestAttemptCount: participant.requestAttemptCount,
    reactiveRectifierRetryState: participant.reactiveRectifierRetryState,
    failedProviderIds: state.failedProviderIds,
    rawCrossProviderFallbackEnabled: session.isRawCrossProviderFallbackEnabled(),
    error,
    getModelRedirect: () => getParticipantModelRedirect(rt, participant),
    applyReactiveRectifier: tryApplyEdgeReactiveRectifier,
    beforeTerminalAccounting: () => {
      participant.status = "failed";
      setAttemptStatus(state, participant.stepId, "failed");
    },
  });
  hedge.lastErrorCategory = decision.errorCategory;

  switch (decision.action) {
    case "client_abort":
      participant.status = "failed";
      setAttemptStatus(state, participant.stepId, "failed");
      traceAttemptFinished(rt, participant, {
        outcome: "client_abort",
        cancellationKind: "client_abort",
      });
      abortAllParticipants(rt, null, "client_abort");
      return settleHedgeFailure(rt, decision.terminalError);
    case "local_capacity":
      participant.status = "failed";
      setAttemptStatus(state, participant.stepId, "failed");
      abortAllParticipants(rt, null, "local_capacity_exceeded");
      return settleHedgeFailure(rt, error);
    case "db_overload":
      participant.status = "failed";
      setAttemptStatus(state, participant.stepId, "failed");
      abortAllParticipants(rt, null, "database_pool_overload");
      return settleHedgeFailure(rt, error);
    case "rectifier_retry": {
      traceAttemptFinished(rt, participant, {
        outcome: "failed",
        ...(decision.statusCode != null ? { statusCode: decision.statusCode } : {}),
        reason: "reactive_rectifier_retry",
      });
      setAttemptStatus(state, participant.stepId, "failed");
      participant.requestAttemptCount += 1;
      participant.attemptId = `legacy-hedge-${participant.sequence}-${participant.requestAttemptCount}`;
      participant.saturationRecorded = false;
      participant.thresholdTriggered = false;
      traceAttemptStarted(rt, participant);
      if (decision.rectifierType === "thinking_signature_rectifier") {
        const body = participant.body ?? state.body;
        body.contentOps.push({ op: "apply_thinking_signature_rectifier" });
        state.pendingRectifierAudits.push({
          stepId: `${state.requestId}:h${participant.sequence}:${participant.requestAttemptCount}`,
          trigger: decision.rectifierTrigger,
          providerId: provider.id,
          attemptNumber: participant.requestAttemptCount - 1,
          retryAttemptNumber: participant.requestAttemptCount,
        });
      }
      return { kind: "retry", step: await buildParticipantStep(rt, participant) };
    }
    case "failed":
      traceAttemptFinished(rt, participant, {
        outcome: "failed",
        ...(decision.statusCode != null ? { statusCode: decision.statusCode } : {}),
        reason: ErrorCategory[decision.errorCategory]?.toLowerCase(),
      });
      if (decision.nonRetryable) {
        abortAllParticipants(rt, null, "client_error_non_retryable");
        return settleHedgeFailure(rt, error);
      }
      return launchOrFinish(rt);
  }
}

/**
 * 客户端在提交前断开（本地 clientAbort 监听器）：逐个在途参与者做首字节健康归因，
 * 其余记 client_abort，然后以 499 结束。
 */
export async function handleHedgeClientAbort(
  rt: EdgeRuntime,
  event: Extract<NextEvent, { type: "failure" }>,
  reporterStepId: string
): Promise<EdgeHedgeOutcome> {
  const { state, session } = rt;
  const hedge = hedgeState(state);
  hedge.noMoreProviders = true;
  hedge.lastError = { kind: "client_abort" };
  hedge.lastErrorCategory = ErrorCategory.CLIENT_ABORT;

  const timings = new Map<
    string,
    { dispatched: boolean; firstByteSeen: boolean; elapsed: number }
  >();
  timings.set(reporterStepId, {
    dispatched: event.dispatched,
    firstByteSeen: event.firstByteSeen,
    elapsed: event.timing.healthElapsedMs,
  });
  for (const peer of event.peers ?? []) {
    timings.set(peer.stepId, {
      dispatched: peer.dispatched,
      firstByteSeen: peer.firstByteSeen,
      elapsed: peer.healthElapsedMs,
    });
  }

  const attributed: EdgeHedgeParticipant[] = [];
  for (const participant of inflightParticipants(hedge)) {
    const provider = participantProvider(rt, participant);
    const timing = timings.get(participant.stepId);
    const threshold =
      provider.firstByteTimeoutStreamingMs > 0
        ? provider.firstByteTimeoutStreamingMs
        : CLIENT_ABORT_HEALTH_FALLBACK_THRESHOLD_MS;
    if (timing?.dispatched && !timing.firstByteSeen && timing.elapsed >= threshold) {
      const elapsedMs = Math.round(timing.elapsed);
      session.appendRoutingTraceEvent({
        type: "client_abort_no_first_byte",
        attemptId: participant.attemptId,
        provider: traceProvider(provider),
        outcome: "provider_failure",
        cancellationKind: "client_abort",
        reason: "external_client_abort",
        effectiveThresholdMs: threshold,
        circuitAccountingApplied: true,
        availabilityAccountingApplied: true,
        durationMs: elapsedMs,
        elapsedMs,
      });
      void recordFailure(
        provider.id,
        new ProxyError(
          "Client aborted while provider was waiting for the first byte",
          499,
          undefined,
          true
        )
      ).catch((healthError) => {
        logger.warn("[EdgeHedge] Failed to account client abort provider health", {
          error: healthError instanceof Error ? healthError.message : String(healthError),
          providerId: provider.id,
        });
      });
      attributed.push(participant);
      continue;
    }
    session.addProviderToChain(provider, {
      ...endpointAudit(participant),
      reason: "client_abort",
      attemptNumber: participant.sequence,
      errorMessage: "Client aborted request",
      modelRedirect: getParticipantModelRedirect(rt, participant),
    });
  }
  for (const participant of attributed) {
    const provider = participantProvider(rt, participant);
    session.addProviderToChain(provider, {
      ...endpointAudit(participant),
      reason: "client_abort_no_first_byte",
      attemptNumber: participant.sequence,
      errorMessage: "Client aborted before provider first byte threshold",
      circuitState: getCircuitState(provider.id),
      modelRedirect: getParticipantModelRedirect(rt, participant),
    });
  }
  abortAllParticipants(rt, null, "client_abort");
  return (
    (await finishIfExhausted(rt)) ?? {
      kind: "fail",
      response: await settleEdgeFailure(
        rt,
        new ProxyError("Request aborted by client", 499, undefined, true)
      ),
    }
  );
}

// ---------------------------------------------------------------------------
// 胜者提交与输家计费（complete）
// ---------------------------------------------------------------------------

/**
 * 本地 commitWinner：在 complete 时（远端已提交并结束胜者流）按本地顺序补齐胜者记账，
 * 返回需要在胜者结算之后执行的输家计费任务。
 */
export function commitHedgeWinner(
  rt: EdgeRuntime,
  participant: EdgeHedgeParticipant,
  winner: WinnerResult,
  losers: LoserResult[]
): { runLoserBilling: () => Promise<void> } {
  const { state, session } = rt;
  const hedge = hedgeState(state);
  const provider = participantProvider(rt, participant);
  const winnerSession = participantSession(rt, participant);

  participant.status = "winner";
  setAttemptStatus(state, participant.stepId, "winner");
  traceAttemptFinished(rt, participant, { outcome: "winner", statusCode: winner.upstreamStatus });
  session.appendRoutingTraceEvent({
    type: "winner_committed",
    attemptId: participant.attemptId,
    attemptKind: "normal",
    round: HEDGE_TRACE_ROUND,
    provider: traceProvider(provider),
    statusCode: winner.upstreamStatus,
  });
  session.setRoutingTraceSummary(
    buildHedgeSummary(rt, {
      outcome: "success",
      statusCode: winner.upstreamStatus,
      winnerProviderId: provider.id,
    })
  );

  const others = inflightParticipants(hedge).filter((candidate) => candidate !== participant);
  for (const other of others) getParticipantModelRedirect(rt, other);

  const billingSnapshots = new Map<
    number,
    Parameters<typeof finalizeHedgeLoserBilling>[0]["billingContext"]
  >();
  if (!participant.useOriginalSession) {
    for (const other of others) {
      if (other.useOriginalSession && other.billAsLoser) {
        const loserRequest = session.request.message as Record<string, unknown>;
        billingSnapshots.set(other.sequence, {
          originalModel: session.getOriginalModel(),
          redirectedModel: session.getCurrentModel(),
          requestedServiceTier:
            typeof loserRequest.service_tier === "string" ? loserRequest.service_tier : null,
          context1mApplied: session.getContext1mApplied(),
          groupCostMultiplier: session.getGroupCostMultiplier(),
        });
      }
    }
    ProxyForwarder.syncWinningAttemptSession(session, winnerSession);
  }
  session.setProvider(provider);

  const isActualHedgeWin = hedge.launchedProviderCount > 1;
  session.addProviderToChain(provider, {
    ...endpointAudit(participant),
    reason: isActualHedgeWin ? "hedge_winner" : "request_success",
    attemptNumber: participant.sequence,
    statusCode: winner.upstreamStatus,
    modelRedirect: getParticipantModelRedirect(rt, participant),
    streamGate: winner.gateCommit ?? undefined,
  });

  const loserResults = new Map(losers.map((loser) => [loser.stepId, loser]));
  const billingTasks: Array<() => Promise<void>> = [];
  for (const other of others) {
    other.status = "loser";
    setAttemptStatus(state, other.stepId, "loser");
    traceAttemptFinished(rt, other, { outcome: "cancelled", cancellationKind: "hedge_loser" });
    const otherProvider = participantProvider(rt, other);
    const result = loserResults.get(other.stepId);
    if (other.billAsLoser) {
      session.addProviderToChain(otherProvider, {
        ...endpointAudit(other),
        reason: "hedge_loser_billed",
        attemptNumber: other.sequence,
        statusCode: result && result.upstreamStatus > 0 ? result.upstreamStatus : undefined,
        modelRedirect: getParticipantModelRedirect(rt, other),
      });
      ProxyForwarder.markProviderFailed(session, state.failedProviderIds, otherProvider.id);
      const messageContext = session.messageContext;
      if (result && result.upstreamStatus > 0 && messageContext) {
        const loserSession = participantSession(rt, other);
        const billingContext = billingSnapshots.get(other.sequence);
        billingTasks.push(async () => {
          await finalizeHedgeLoserBilling({
            messageRequestId: messageContext.id,
            messageRequestCreatedAtMs: messageContext.createdAt.getTime(),
            loserSession,
            provider: otherProvider,
            attemptNumber: other.sequence,
            upstreamStatusCode: result.upstreamStatus,
            allContent: result.meteringText,
            drainComplete: result.drainComplete,
            billingContext,
          });
        });
      }
      continue;
    }
    session.addProviderToChain(otherProvider, {
      ...endpointAudit(other),
      reason: "hedge_loser_cancelled",
      attemptNumber: other.sequence,
      modelRedirect: getParticipantModelRedirect(rt, other),
    });
    ProxyForwarder.markProviderFailed(session, state.failedProviderIds, otherProvider.id);
  }

  let hedgeBindingAuthorityPromise: Promise<DeferredStreamingHedgeBindingAuthority> | undefined;
  const sessionId = session.sessionId;
  if (sessionId && isActualHedgeWin && session.isSessionBindingAllowed()) {
    hedgeBindingAuthorityPromise = (async () => {
      const bindingResult = await SessionManager.updateSessionBindingSmart(
        sessionId,
        provider.id,
        provider.priority || 0,
        hedge.launchedProviderCount === 1 && provider.id === hedge.initialProviderId,
        provider.id !== hedge.initialProviderId,
        session.authState?.key?.id ?? null,
        isActualHedgeWin
      );
      if (session.shouldTrackSessionObservability()) {
        void SessionManager.updateSessionProvider(sessionId, {
          providerId: provider.id,
          providerName: provider.name,
        }).catch((observabilityError) => {
          logger.error("[EdgeHedge] Failed to update observable session provider", {
            error: observabilityError,
          });
        });
      }
      return {
        snapshot: bindingResult.bindingSnapshot ?? null,
        legacyClearAllowed: bindingResult.legacyBindingUpdated === true,
      };
    })().catch((bindingError) => {
      logger.error("[EdgeHedge] Failed to update session binding for hedge winner", {
        error: bindingError,
      });
      return { snapshot: null, legacyClearAllowed: false };
    });
  }

  setDeferredStreamingFinalization(session, {
    providerId: provider.id,
    providerName: provider.name,
    providerPriority: provider.priority || 0,
    attemptNumber: participant.sequence,
    totalProvidersAttempted: hedge.launchedProviderCount,
    isFirstAttempt: hedge.launchedProviderCount === 1 && provider.id === hedge.initialProviderId,
    isFailoverSuccess: provider.id !== hedge.initialProviderId,
    endpointId: participant.endpointId,
    endpointUrl: participant.endpointUrl,
    upstreamStatusCode: winner.upstreamStatus,
    isHedgeWinner: isActualHedgeWin,
    billHedgeLosers: hedge.billLosers,
    bindingIntent: session.isSessionBindingAllowed() ? undefined : "none",
    hedgeBindingAuthorityPromise,
  });

  return {
    runLoserBilling: async () => {
      for (const task of billingTasks) {
        await task().catch((billingError) => {
          logger.debug("[EdgeHedge] Hedge loser billing failed", {
            requestId: state.requestId,
            error: billingError instanceof Error ? billingError.message : String(billingError),
          });
        });
      }
    },
  };
}
