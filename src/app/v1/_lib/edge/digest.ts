/**
 * RequestDigest 与合成请求体。
 *
 * - buildRequestDigest：由完整请求体计算摘要的 TS 参考实现。Go 执行器在远端做同样的计算，
 *   共享 fixture 以本实现的输出为准；
 * - createEdgeSessionFromDigest：由摘要构建 edge 会话（合成体 + 预计算提示）。
 */
import { SessionManager } from "@/lib/session-manager";
import { computeFingerprintChain, MAX_AFFINITY_WINDOW } from "../proxy/affinity/fingerprint";
import { ProxySession } from "../proxy/session";
import {
  EDGE_SCHEMA_VERSION,
  EDGE_TOP_LEVEL_KEYS,
  type HeaderPairs,
  type RequestDigest,
} from "./contract";

function hasPrivateKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateKeys);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("_") || hasPrivateKeys(child)) return true;
  }
  return false;
}

function resolveSystemKind(system: unknown): RequestDigest["systemKind"] {
  if (system === undefined) return "absent";
  if (typeof system === "string") return "string";
  if (Array.isArray(system)) return "array";
  return "other";
}

function headerPairsToHeaders(pairs: HeaderPairs): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    headers.append(name, value);
  }
  return headers;
}

export function buildRequestDigest(params: {
  edgeId: string;
  edgeRequestId: string;
  receivedAtMs: number;
  method: string;
  path: string;
  headers: HeaderPairs;
  clientIp: string | null;
  body: Record<string, unknown>;
  bodyBytes: number;
}): RequestDigest {
  const { body } = params;
  const topLevel: RequestDigest["topLevel"] = {};
  for (const key of EDGE_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(body, key)) topLevel[key] = body[key];
  }

  // 探测/预热判定直接复用会话上的实现，以完整请求体计算
  const probe = ProxySession.fromEdgeDigest({
    receivedAtMs: params.receivedAtMs,
    method: params.method,
    requestUrl: new URL(params.path, "http://edge.local"),
    headers: headerPairsToHeaders(params.headers),
    syntheticMessage: body,
    hints: { messagesHash: null, fingerprint: null, isProbe: false, isWarmup: false },
  });
  probe.edgeDigestHints = null;

  return {
    schemaVersion: EDGE_SCHEMA_VERSION,
    edgeId: params.edgeId,
    edgeRequestId: params.edgeRequestId,
    receivedAtMs: params.receivedAtMs,
    method: params.method,
    path: params.path,
    headers: params.headers,
    clientIp: params.clientIp,
    bodyBytes: params.bodyBytes,
    bodyParseError: null,
    topLevel,
    messagesCount: Array.isArray(body.messages) ? body.messages.length : 0,
    systemKind: resolveSystemKind(body.system),
    hasPrivateParams: hasPrivateKeys(body),
    isProbe: probe.isProbeRequest(),
    isWarmup: probe.isWarmupRequest(),
    messagesHash: SessionManager.calculateMessagesHash(body.messages),
    fingerprint: computeFingerprintChain(body, "claude", MAX_AFFINITY_WINDOW),
  };
}

/**
 * 合成请求体：只含摘要携带的顶层字段 + 与原请求等长的占位 messages。
 */
export function buildSyntheticMessage(digest: RequestDigest): Record<string, unknown> {
  const message: Record<string, unknown> = structuredClone(digest.topLevel);
  message.messages = Array.from({ length: digest.messagesCount }, () => ({}));
  return message;
}

export function createEdgeSessionFromDigest(digest: RequestDigest): ProxySession {
  return ProxySession.fromEdgeDigest({
    receivedAtMs: digest.receivedAtMs,
    method: digest.method,
    requestUrl: new URL(digest.path, "http://edge.local"),
    headers: headerPairsToHeaders(digest.headers),
    syntheticMessage: buildSyntheticMessage(digest),
    hints: {
      messagesHash: digest.messagesHash,
      fingerprint: digest.fingerprint,
      isProbe: digest.isProbe,
      isWarmup: digest.isWarmup,
    },
  });
}
