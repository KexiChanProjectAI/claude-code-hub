/**
 * RequestDigest 与合成请求体。
 *
 * - buildRequestDigest：由完整请求体计算摘要的 TS 参考实现。Go 执行器在远端做同样的计算，
 *   共享 fixture 以本实现的输出为准；
 * - createEdgeSessionFromDigest：由摘要构建 edge 会话（合成体 + 预计算提示）。
 */
import { SessionManager } from "@/lib/session-manager";
import { extractInitialMessageTextHash } from "../codex/session-completer";
import { computeFingerprintChain, MAX_AFFINITY_WINDOW } from "../proxy/affinity/fingerprint";
import { detectFormatByEndpoint } from "../proxy/format-mapper";
import { isRemoteCompactionV2Request } from "../proxy/remote-compaction";
import { rectifyResponseInput } from "../proxy/response-input-rectifier";
import { ProxySession } from "../proxy/session";
import {
  EDGE_SCHEMA_VERSION,
  EDGE_TOP_LEVEL_KEYS,
  type EdgeClientFormat,
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
  const format = resolveEdgeClientFormat(params.path);
  // Response Input Rectifier 在守卫链之前运行：内容相关的摘要按规范化后的请求体计算
  const body = structuredClone(params.body);
  const responseInputRectify =
    format === "response"
      ? (() => {
          const result = rectifyResponseInput(body);
          return { action: result.action, originalType: result.originalType };
        })()
      : null;

  const topLevel: RequestDigest["topLevel"] = {};
  for (const key of EDGE_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(body, key)) topLevel[key] = body[key];
  }

  // 探测/预热判定与消息读取直接复用会话上的实现，以完整请求体计算
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
    format,
    headers: params.headers,
    clientIp: params.clientIp,
    bodyBytes: params.bodyBytes,
    bodyParseError: null,
    topLevel,
    messagesCount: Array.isArray(body.messages) ? body.messages.length : null,
    inputCount: Array.isArray(body.input) ? body.input.length : null,
    responseInputRectify,
    isRemoteCompactionV2: isRemoteCompactionV2Request(
      new URL(params.path, "http://edge.local").pathname,
      params.body
    ),
    codexInitialTextHash: Array.isArray(body.input) ? extractInitialMessageTextHash(body) : null,
    systemKind: resolveSystemKind(body.system),
    hasPrivateParams: hasPrivateKeys(body),
    isProbe: probe.isProbeRequest(),
    isWarmup: probe.isWarmupRequest(),
    messagesHash: SessionManager.calculateMessagesHash(probe.getMessages()),
    fingerprint: computeFingerprintChain(body, format, MAX_AFFINITY_WINDOW),
  };
}

/** 与 detectFormatByEndpoint 一致；edge 不支持的路径按 claude 处理（资格判定会交回本地） */
export function resolveEdgeClientFormat(path: string): EdgeClientFormat {
  const format = detectFormatByEndpoint(new URL(path, "http://edge.local").pathname);
  return format === "response" || format === "openai" ? format : "claude";
}

/**
 * 合成请求体：只含摘要携带的顶层字段 + 与原请求等长的占位 messages。
 */
export function buildSyntheticMessage(digest: RequestDigest): Record<string, unknown> {
  const message: Record<string, unknown> = structuredClone(digest.topLevel);
  if (digest.messagesCount !== null) {
    message.messages = Array.from({ length: digest.messagesCount }, () => ({}));
  }
  if (digest.inputCount !== null) {
    message.input = Array.from({ length: digest.inputCount }, () => ({}));
  }
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
      codexInitialTextHash: digest.codexInitialTextHash,
    },
  });
}
