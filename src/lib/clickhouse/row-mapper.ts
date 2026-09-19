import { isIP } from "node:net";

/**
 * 从 PostgreSQL 读到的一行（已 LEFT JOIN 出用户/密钥/供应商名称）。
 *
 * 刻意不包含 message_request.key：那是 API key 原文，绝不外发到 ClickHouse。
 */
export interface SyncSourceRow {
  id: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  userId: number;
  userName: string | null;
  keyId: number | null;
  keyName: string | null;
  clientIp: string | null;
  userAgent: string | null;
  model: string | null;
  originalModel: string | null;
  actualResponseModel: string | null;
  providerId: number;
  providerName: string | null;
  endpoint: string | null;
  apiType: string | null;
  sessionId: string | null;
  requestSequence: number | null;
  isReplay: boolean;
  statusCode: number | null;
  blockedBy: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: string | null;
  errorMessage: string | null;
}

const USER_AGENT_MAX_LENGTH = 512;
const ERROR_MESSAGE_MAX_LENGTH = 4096;
const SESSION_ID_MAX_LENGTH = 64;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** ClickHouse IPv6 列的零值，用于"IP 未知" */
const UNKNOWN_IP = "::";

/**
 * 归一化为 IPv6 字面量：IPv4 转成 IPv4-mapped 形式，非法/空值落到 "::"。
 * 统一成一种表示后，ClickHouse 侧按 CIDR 过滤才不会漏。
 */
export function normalizeIpForClickHouse(value: string | null | undefined): string {
  if (!value) {
    return UNKNOWN_IP;
  }
  const trimmed = value.trim();
  const version = isIP(trimmed);
  if (version === 4) {
    return `::ffff:${trimmed}`;
  }
  if (version === 6) {
    return trimmed;
  }
  return UNKNOWN_IP;
}

function text(value: string | null | undefined, maxLength?: number): string {
  if (!value) {
    return "";
  }
  return maxLength === undefined ? value : value.slice(0, maxLength);
}

function uint(value: number | null | undefined, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), max);
}

/**
 * numeric 列由 pg 驱动返回字符串，全程不经过 JS number，避免精度损失。
 */
function decimal(value: string | null | undefined): string {
  if (!value) {
    return "0";
  }
  const trimmed = value.trim();
  return DECIMAL_PATTERN.test(trimmed) ? trimmed : "0";
}

function timestamp(value: Date | null | undefined): string {
  if (!value || Number.isNaN(value.getTime())) {
    return new Date(0).toISOString();
  }
  return value.toISOString();
}

/**
 * PG 行 -> ClickHouse 行（JSONEachRow 的一条记录）。
 * 纯函数，无 I/O：所有空值折叠成列类型的零值，因为目标列都不是 Nullable。
 */
export function toClickHouseRow(row: SyncSourceRow): Record<string, unknown> {
  return {
    id: uint(row.id),
    created_at: timestamp(row.createdAt),
    updated_at: timestamp(row.updatedAt),
    user_id: uint(row.userId),
    user_name: text(row.userName),
    key_id: uint(row.keyId),
    key_name: text(row.keyName),
    client_ip: normalizeIpForClickHouse(row.clientIp),
    user_agent: text(row.userAgent, USER_AGENT_MAX_LENGTH),
    model: text(row.model),
    original_model: text(row.originalModel),
    actual_response_model: text(row.actualResponseModel),
    provider_id: uint(row.providerId),
    provider_name: text(row.providerName),
    endpoint: text(row.endpoint),
    api_type: text(row.apiType),
    session_id: text(row.sessionId, SESSION_ID_MAX_LENGTH),
    request_sequence: uint(row.requestSequence),
    is_replay: row.isReplay ? 1 : 0,
    status_code: uint(row.statusCode, 65535),
    blocked_by: text(row.blockedBy),
    duration_ms: uint(row.durationMs, 4294967295),
    ttft_ms: uint(row.ttftMs, 4294967295),
    input_tokens: uint(row.inputTokens),
    output_tokens: uint(row.outputTokens),
    cache_read_input_tokens: uint(row.cacheReadInputTokens),
    cache_creation_input_tokens: uint(row.cacheCreationInputTokens),
    cost_usd: decimal(row.costUsd),
    error_message: text(row.errorMessage, ERROR_MESSAGE_MAX_LENGTH),
  };
}
