import {
  computeFingerprintChain,
  DEFAULT_AFFINITY_WINDOW,
  type FingerprintChain,
  MAX_AFFINITY_WINDOW,
} from "./affinity/fingerprint";
import type { ProxySession } from "./session";

/**
 * edge 执行器在远端对完整请求体预先计算的摘要信息。
 *
 * edge 路径下 ProxySession 只持有合成请求体（顶层字段 + 空 messages），凡是需要读取
 * 消息内容的判定（会话内容哈希、亲和指纹、探测/预热识别）都必须改用这里的预计算值，
 * 否则会基于合成体得到错误结果。
 */
export interface EdgeDigestHints {
  /** SessionManager.calculateMessagesHash 同算法结果；null 表示无法计算 */
  messagesHash: string | null;
  /** computeFingerprintChain 同算法结果（按 MAX_AFFINITY_WINDOW 截断）；null 表示 fail-open */
  fingerprint: FingerprintChain | null;
  isProbe: boolean;
  isWarmup: boolean;
  /** Codex 会话补全指纹用的首轮消息文本哈希（extractInitialMessageTextHash 同算法） */
  codexInitialTextHash?: string | null;
}

type SessionWithEdgeHints = { edgeDigestHints?: EdgeDigestHints | null };

export function getEdgeDigestHints(session: unknown): EdgeDigestHints | null {
  if (!session || typeof session !== "object") return null;
  return (session as SessionWithEdgeHints).edgeDigestHints ?? null;
}

/**
 * 与 computeFingerprintChain 内部截断一致：仅保留最深的 window 个边界，sys 永远保留。
 */
export function truncateFingerprintChain(
  chain: FingerprintChain | null,
  window: number
): FingerprintChain | null {
  if (!chain) return null;
  const normalized =
    !Number.isFinite(window) || window <= 0
      ? DEFAULT_AFFINITY_WINDOW
      : Math.min(Math.floor(window), MAX_AFFINITY_WINDOW);
  if (chain.tail.length <= normalized) return chain;
  return { sys: chain.sys, tail: chain.tail.slice(chain.tail.length - normalized) };
}

/**
 * 计算会话的亲和指纹链：edge 会话使用预计算值，本地会话按请求体实时计算。
 */
export function computeSessionFingerprintChain(
  session: Pick<ProxySession, "request" | "originalFormat">,
  window: number
): FingerprintChain | null {
  const hints = getEdgeDigestHints(session);
  if (hints) return truncateFingerprintChain(hints.fingerprint, window);
  return computeFingerprintChain(
    session.request.message as Record<string, unknown>,
    session.originalFormat,
    window
  );
}
