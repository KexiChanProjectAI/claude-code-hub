/**
 * edge 请求 watchdog：远端在截止时间内既没有心跳也没有 next / complete 上报时，
 * 按失败结算 message_request 并释放并发计数，避免执行器宕机留下悬挂请求。
 *
 * 仅在后台任务所属 worker 上运行；同一请求的结算由请求级锁 + phase 状态保证只发生一次。
 */
import { logger } from "@/lib/logger";
import { ProxyErrorHandler } from "../proxy/error-handler";
import { ProxyError } from "../proxy/errors";
import { ProxySession } from "../proxy/session";
import { releaseEdgeConcurrency } from "./coordinator";
import {
  clearEdgeDeadline,
  EdgeStateLockTimeoutError,
  listDueEdgeDeadlines,
  loadEdgeState,
  saveEdgeState,
  scheduleEdgeDeadline,
  withEdgeRequestLock,
} from "./state-store";

/** complete 正在结算的请求给出的额外宽限：结算包含计费与终态写库，可能较慢 */
const COMPLETING_GRACE_MS = 60_000;
const SETTLED_STATE_TTL_SECONDS = 600;
const TICK_BATCH_LIMIT = 100;

export const EDGE_REPORT_TIMEOUT_MESSAGE = "EDGE_REPORT_TIMEOUT";

export async function runEdgeWatchdogTick(nowMs: number = Date.now()): Promise<number> {
  const dueRequestIds = await listDueEdgeDeadlines(nowMs, TICK_BATCH_LIMIT);
  let settled = 0;

  for (const requestId of dueRequestIds) {
    try {
      const didSettle = await withEdgeRequestLock(requestId, async () => {
        const state = await loadEdgeState(requestId);
        if (!state || state.phase === "settled") {
          await clearEdgeDeadline(requestId);
          return false;
        }
        if (state.phase === "completing" && nowMs - state.updatedAtMs < COMPLETING_GRACE_MS) {
          await scheduleEdgeDeadline(requestId, state.updatedAtMs + COMPLETING_GRACE_MS);
          return false;
        }

        const session = ProxySession.fromEdgeSnapshot(state.session);
        const error = new ProxyError(
          `${EDGE_REPORT_TIMEOUT_MESSAGE}: edge executor stopped reporting`,
          502
        );
        try {
          await ProxyErrorHandler.handle(session, error);
        } finally {
          await releaseEdgeConcurrency(state);
          state.phase = "settled";
          state.session = session.toEdgeSnapshot();
          await saveEdgeState(state, SETTLED_STATE_TTL_SECONDS);
          await clearEdgeDeadline(requestId);
        }
        logger.warn("[EdgeWatchdog] Settled request after missing edge reports", {
          requestId,
          edgeId: state.edgeId,
          phase: state.phase,
        });
        return true;
      });
      if (didSettle) settled += 1;
    } catch (error) {
      if (error instanceof EdgeStateLockTimeoutError) continue;
      logger.error("[EdgeWatchdog] Failed to settle overdue edge request", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return settled;
}
