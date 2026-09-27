/**
 * POST /api/internal/edge/{next,complete,heartbeat}
 *
 * 每个调用都在请求级锁内加载 EdgeRequestState、还原会话、推进状态并写回。
 * next / complete 按 (requestId, stepId, 事件) 幂等：远端因网络抖动重发时返回首次结果。
 */
import { getCachedSystemSettings } from "@/lib/config";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { Provider } from "@/types/provider";
import { sanitizeUrl } from "../proxy/errors";
import {
  buildThinkingSignatureRectifierAudit,
  CLIENT_ABORT_HEALTH_FALLBACK_THRESHOLD_MS,
  ProxyForwarder,
  persistSpecialSettings,
} from "../proxy/forwarder";
import {
  settleEdgeNonStreamCompletion,
  settleEdgeStreamCompletion,
} from "../proxy/response-handler";
import { ProxySession } from "../proxy/session";
import { setDeferredStreamingFinalization } from "../proxy/stream-finalization";
import type { ThinkingSignatureRectifierTrigger } from "../proxy/thinking-signature-rectifier";
import type {
  CompleteRequest,
  HeartbeatRequest,
  NextRequest,
  NextResponse,
  OpResults,
} from "./contract";
import {
  type EdgeRuntime,
  type EdgeStepOutcome,
  handleSerialFailure,
  releaseEdgeConcurrency,
} from "./coordinator";
import { attemptFailureToError, evaluateSuspectNonStreamBody } from "./failure-errors";
import {
  clearEdgeDeadline,
  type EdgeAttemptRecord,
  type EdgeRequestState,
  getIdempotentResponse,
  loadEdgeState,
  saveEdgeState,
  scheduleEdgeDeadline,
  setIdempotentResponse,
  touchEdgeState,
  withEdgeRequestLock,
} from "./state-store";

/** 已结算请求的状态保留时长（秒），用于幂等重放与迟到上报 */
const SETTLED_STATE_TTL_SECONDS = 600;

export class EdgeHandlerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code
  ) {
    super(message);
    this.name = "EdgeHandlerError";
  }
}

async function loadRuntime(requestId: number, edgeToken: string): Promise<EdgeRuntime> {
  const state = await loadEdgeState(requestId);
  if (!state) throw new EdgeHandlerError(404, "unknown_request");
  if (state.edgeToken !== edgeToken) throw new EdgeHandlerError(403, "token_mismatch");
  const settings = await getCachedSystemSettings();
  const session = ProxySession.fromEdgeSnapshot(state.session);
  return { state, session, settings };
}

async function persistRuntime(rt: EdgeRuntime): Promise<void> {
  rt.state.session = rt.session.toEdgeSnapshot();
  const env = getEnvConfig();
  if (rt.state.phase === "settled") {
    await clearEdgeDeadline(rt.state.requestId);
    await saveEdgeState(rt.state, SETTLED_STATE_TTL_SECONDS);
    return;
  }
  await saveEdgeState(rt.state, env.CCH_EDGE_STATE_TTL_SECONDS);
  await scheduleEdgeDeadline(rt.state.requestId, Date.now() + 3 * rt.state.heartbeatIntervalMs);
}

function findProvider(rt: EdgeRuntime, providerId: number): Provider {
  if (rt.session.provider?.id === providerId) return rt.session.provider;
  const snapshot = rt.state.session.providersSnapshot ?? [];
  const provider = snapshot.find((candidate) => candidate.id === providerId);
  if (!provider) throw new EdgeHandlerError(409, "provider_not_found");
  return provider;
}

/**
 * 远端执行内容型 op 后回报的结果：补齐与本地同形的审计项，并同步合成请求体。
 */
async function applyOpResults(
  rt: EdgeRuntime,
  attempt: EdgeAttemptRecord,
  opResults: OpResults | undefined
): Promise<void> {
  if (!opResults) return;
  const { state, session } = rt;
  let changed = false;

  if (opResults.billingHeader && !state.billingHeaderAudited) {
    state.billingHeaderAudited = true;
    session.addSpecialSetting({
      type: "billing_header_rectifier",
      scope: "request",
      hit: true,
      removedCount: opResults.billingHeader.removedCount,
      extractedValues: opResults.billingHeader.extractedValues,
    });
    changed = true;
  }

  const signature = opResults.thinkingSignature;
  const pendingIndex = state.pendingRectifierAudits.findIndex(
    (pending) => pending.stepId === attempt.stepId
  );
  if (signature && pendingIndex >= 0) {
    const pending = state.pendingRectifierAudits[pendingIndex];
    state.pendingRectifierAudits.splice(pendingIndex, 1);
    session.addSpecialSetting(
      buildThinkingSignatureRectifierAudit(
        {
          applied: signature.applied,
          removedThinkingBlocks: signature.removedThinkingBlocks,
          removedRedactedThinkingBlocks: signature.removedRedactedThinkingBlocks,
          removedSignatureFields: signature.removedSignatureFields,
        },
        {
          trigger: pending.trigger as ThinkingSignatureRectifierTrigger,
          provider: findProvider(rt, pending.providerId),
          attemptNumber: pending.attemptNumber,
          retryAttemptNumber: pending.retryAttemptNumber,
        }
      )
    );
    changed = true;
  }
  if (signature?.removedTopLevelThinking) {
    // 远端整流删除了顶层 thinking：同步合成体，后续供应商参数覆写基于同一状态
    delete (session.request.message as Record<string, unknown>).thinking;
  }

  if (changed) {
    await persistSpecialSettings(session);
  }
}

function stepOutcomeToNextResponse(rt: EdgeRuntime, outcome: EdgeStepOutcome): NextResponse {
  if (outcome.kind === "fail") {
    rt.state.phase = "settled";
    return { action: "fail", response: outcome.response };
  }
  return { action: "retry", step: outcome.step };
}

export async function handleEdgeNext(request: NextRequest): Promise<NextResponse> {
  const idempotencyScope = `next:${request.requestId}:${request.stepId}:${request.event.type}`;
  return withEdgeRequestLock(request.requestId, async () => {
    const cached = await getIdempotentResponse<NextResponse>(idempotencyScope);
    if (cached) return cached;

    const rt = await loadRuntime(request.requestId, request.edgeToken);
    if (rt.state.phase !== "executing") {
      throw new EdgeHandlerError(409, "request_not_executing");
    }
    const attempt = rt.state.attempts.find((candidate) => candidate.stepId === request.stepId);
    if (attempt?.status !== "inflight") {
      throw new EdgeHandlerError(409, "stale_step");
    }

    const event = request.event;
    let response: NextResponse;
    switch (event.type) {
      case "hedge_threshold":
        // 串行模式没有竞速：首字节超时由远端按 firstByteMs 作为 524 失败上报
        response = { action: "none" };
        break;
      case "suspect_2xx": {
        await applyOpResults(rt, attempt, event.opResults);
        const provider = findProvider(rt, attempt.providerId);
        const error = evaluateSuspectNonStreamBody(event.bodyText, event.bodyTruncated, provider);
        if (!error) {
          response = { action: "commit" };
          break;
        }
        response = stepOutcomeToNextResponse(
          rt,
          await handleSerialFailure(rt, {
            stepId: attempt.stepId,
            error,
            dispatched: true,
            firstByteSeen: true,
            healthElapsedMs: 0,
          })
        );
        break;
      }
      case "rectifier_not_applicable": {
        await applyOpResults(rt, attempt, event.opResults);
        const lastFailure = rt.state.lastFailure;
        if (!lastFailure) throw new EdgeHandlerError(409, "missing_rectifier_trigger");
        const provider = findProvider(rt, lastFailure.providerId);
        // 签名整流已记为本供应商重试过：同一错误再次进入决策表即按不可重试的客户端错误终止
        response = stepOutcomeToNextResponse(
          rt,
          await handleSerialFailure(rt, {
            stepId: attempt.stepId,
            error: attemptFailureToError(lastFailure.failure, provider),
            dispatched: false,
            firstByteSeen: false,
            healthElapsedMs: 0,
          })
        );
        break;
      }
      case "failure": {
        await applyOpResults(rt, attempt, event.opResults);
        const provider = findProvider(rt, attempt.providerId);
        rt.state.lastFailure = { providerId: provider.id, failure: event.failure };
        response = stepOutcomeToNextResponse(
          rt,
          await handleSerialFailure(rt, {
            stepId: attempt.stepId,
            error: attemptFailureToError(event.failure, provider),
            dispatched: event.dispatched,
            firstByteSeen: event.firstByteSeen,
            healthElapsedMs: event.timing.healthElapsedMs,
          })
        );
        break;
      }
    }

    await persistRuntime(rt);
    await setIdempotentResponse(
      idempotencyScope,
      response,
      getEnvConfig().CCH_EDGE_STATE_TTL_SECONDS
    );
    logger.debug("[EdgeNext] Processed event", {
      requestId: request.requestId,
      stepId: request.stepId,
      event: event.type,
      action: response.action,
    });
    return response;
  });
}

export async function handleEdgeComplete(
  request: CompleteRequest
): Promise<{ ok: true; alreadySettled: boolean }> {
  return withEdgeRequestLock(request.requestId, async () => {
    const rt = await loadRuntime(request.requestId, request.edgeToken);
    const { state, session } = rt;
    if (state.phase === "settled") return { ok: true, alreadySettled: true };

    const winner = request.winner;
    const attempt = state.attempts.find((candidate) => candidate.stepId === winner.stepId);
    if (attempt?.status !== "inflight") {
      throw new EdgeHandlerError(409, "stale_step");
    }
    const provider = findProvider(rt, attempt.providerId);
    session.setProvider(provider);
    attempt.status = "winner";
    state.phase = "completing";
    await saveEdgeState(state, getEnvConfig().CCH_EDGE_STATE_TTL_SECONDS);

    await applyOpResults(rt, attempt, winner.opResults);
    if (winner.fixer?.hit) {
      session.addSpecialSetting({
        type: "response_fixer",
        scope: "response",
        hit: true,
        fixersApplied: winner.fixer.fixersApplied,
        totalBytesProcessed: winner.fixer.totalBytesProcessed,
        processingTimeMs: winner.fixer.processingTimeMs,
      });
      await persistSpecialSettings(session);
    }

    const responseHeaders = new Headers(winner.responseHeaders);
    const endpointAudit = {
      endpointId: attempt.endpointId,
      endpointUrl: sanitizeUrl(attempt.baseUrl),
    };

    try {
      if (winner.isStreaming) {
        if (winner.timing.firstByteAtMs !== null) {
          session.recordFirstByte(winner.timing.firstByteAtMs);
        }
        if (winner.timing.firstTokenAtMs !== null) {
          session.recordTtft(winner.timing.firstTokenAtMs);
        }
        setDeferredStreamingFinalization(session, {
          ...(winner.gateCommit ? { streamGate: winner.gateCommit } : {}),
          providerId: provider.id,
          providerName: provider.name,
          providerPriority: provider.priority || 0,
          attemptNumber: attempt.attemptNumber,
          totalProvidersAttempted: attempt.totalProvidersAttempted,
          isFirstAttempt: attempt.totalProvidersAttempted === 1 && attempt.attemptNumber === 1,
          isFailoverSuccess: attempt.totalProvidersAttempted > 1,
          endpointId: attempt.endpointId,
          endpointUrl: endpointAudit.endpointUrl,
          upstreamStatusCode: winner.upstreamStatus,
          bindingIntent: session.isSessionBindingAllowed() ? undefined : "none",
          healthAttemptId: `legacy-serial-${attempt.totalProvidersAttempted}-${attempt.attemptNumber}`,
          // 健康归因只依赖"派发至今的有效耗时"，由远端测得后折算为本地单调时钟起点
          healthAttemptStartedAtMonotonic: performance.now() - winner.timing.healthElapsedMs,
          healthAttributionThresholdMs:
            provider.firstByteTimeoutStreamingMs > 0
              ? provider.firstByteTimeoutStreamingMs
              : CLIENT_ABORT_HEALTH_FALLBACK_THRESHOLD_MS,
          healthFirstByteSeen: winner.firstByteSeen,
          healthPausedDurationMs: 0,
          healthOutcomeSettled: false,
        });
        await settleEdgeStreamCompletion(session, {
          allContent: winner.compactSse,
          upstreamStatusCode: winner.upstreamStatus,
          streamEndedNormally: winner.streamEndedNormally,
          clientAborted: winner.clientAborted,
          abortReason: winner.abortReason ?? undefined,
          protocolObservation: winner.protocol
            ? {
                sawContent: winner.protocol.sawContent,
                sawTerminal: winner.protocol.sawTerminal,
                sawIncomplete: winner.protocol.sawIncomplete,
                observationIncomplete: winner.protocol.observationIncomplete,
                failure: winner.protocol.failure
                  ? {
                      afterContent: winner.protocol.failure.afterContent,
                      verdict: winner.protocol.failure.verdict,
                      eventName: winner.protocol.failure.eventName,
                      ...(winner.protocol.failure.sawMalformed
                        ? { sawMalformed: true as const }
                        : {}),
                    }
                  : null,
              }
            : null,
          firstByteSeen: winner.firstByteSeen,
          responseHeaders,
          sseEventCount: winner.sseEventCount,
        });
      } else {
        const entry = [...state.providerAttempts]
          .reverse()
          .find((candidate) => candidate.providerId === provider.id);
        if (winner.upstreamStatus >= 200 && winner.upstreamStatus < 300) {
          await ProxyForwarder.commitNonStreamSuccess({
            session,
            provider,
            activeEndpoint: { endpointId: attempt.endpointId, baseUrl: attempt.baseUrl },
            endpointAudit,
            attemptNumber: attempt.attemptNumber,
            totalProvidersAttempted: attempt.totalProvidersAttempted,
            shouldAccountCircuitBreaker: entry?.shouldAccountCircuitBreaker ?? true,
            response: { status: winner.upstreamStatus },
          });
        }
        await settleEdgeNonStreamCompletion(session, {
          responseText: winner.nonStreamBody?.text ?? "",
          statusCode: winner.upstreamStatus,
          responseHeaders,
        });
      }
    } finally {
      await releaseEdgeConcurrency(state);
      state.phase = "settled";
      await persistRuntime(rt);
    }

    logger.info("[EdgeComplete] Settled", {
      requestId: state.requestId,
      stepId: winner.stepId,
      providerId: provider.id,
      upstreamStatus: winner.upstreamStatus,
      streaming: winner.isStreaming,
    });
    return { ok: true, alreadySettled: false };
  });
}

export async function handleEdgeHeartbeat(
  request: HeartbeatRequest
): Promise<{ ok: true; deadlineMs: number }> {
  const state = await loadEdgeState(request.requestId);
  if (!state) throw new EdgeHandlerError(404, "unknown_request");
  if (state.edgeToken !== request.edgeToken) throw new EdgeHandlerError(403, "token_mismatch");
  if (state.phase === "settled") throw new EdgeHandlerError(409, "request_settled");
  const deadlineMs = Date.now() + 3 * state.heartbeatIntervalMs;
  await scheduleEdgeDeadline(state.requestId, deadlineMs);
  await touchEdgeState(state.requestId, getEnvConfig().CCH_EDGE_STATE_TTL_SECONDS);
  return { ok: true, deadlineMs };
}

export type { EdgeRequestState };
