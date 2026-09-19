import "server-only";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { keys, messageRequest, providers, users } from "@/drizzle/schema";
import type { SyncSourceRow } from "@/lib/clickhouse/row-mapper";
import { EXCLUDE_WARMUP_CONDITION } from "@/repository/_shared/message-request-conditions";

/**
 * 同步源查询：从 message_request 读取待同步的行。
 *
 * 用 Drizzle query builder 而非裸 SQL，是为了拿到列类型映射
 * （bigint -> number、numeric -> string、timestamptz -> Date）；
 * 裸 db.execute 会把 int8/numeric 一律返回字符串。
 */

/**
 * SELECT 列表：显式列举，确保 message_request.key（API key 原文）永远不会被读出来。
 *
 * users/keys/providers 一律 LEFT JOIN：被拦截的行 provider_id 为 0，
 * 而已删除的用户/密钥仍然需要保留名称快照供审计使用。
 */
const SELECT_COLUMNS = {
  id: messageRequest.id,
  createdAt: messageRequest.createdAt,
  updatedAt: messageRequest.updatedAt,
  userId: messageRequest.userId,
  userName: users.name,
  keyId: keys.id,
  keyName: keys.name,
  clientIp: messageRequest.clientIp,
  userAgent: messageRequest.userAgent,
  model: messageRequest.model,
  originalModel: messageRequest.originalModel,
  actualResponseModel: messageRequest.actualResponseModel,
  providerId: messageRequest.providerId,
  providerName: providers.name,
  endpoint: messageRequest.endpoint,
  apiType: messageRequest.apiType,
  sessionId: messageRequest.sessionId,
  requestSequence: messageRequest.requestSequence,
  isReplay: messageRequest.isReplay,
  statusCode: messageRequest.statusCode,
  blockedBy: messageRequest.blockedBy,
  durationMs: messageRequest.durationMs,
  ttftMs: messageRequest.ttftMs,
  inputTokens: messageRequest.inputTokens,
  outputTokens: messageRequest.outputTokens,
  cacheReadInputTokens: messageRequest.cacheReadInputTokens,
  cacheCreationInputTokens: messageRequest.cacheCreationInputTokens,
  costUsd: messageRequest.costUsd,
  errorMessage: messageRequest.errorMessage,
} as const;

function baseQuery() {
  return db
    .select(SELECT_COLUMNS)
    .from(messageRequest)
    .leftJoin(users, eq(messageRequest.userId, users.id))
    .leftJoin(keys, eq(messageRequest.key, keys.key))
    .leftJoin(providers, eq(messageRequest.providerId, providers.id));
}

/**
 * keys 是按 key 原文而非主键 JOIN 的，理论上存在一对多的可能；
 * 按 id 去重保证一行请求只产出一条 ClickHouse 记录。
 */
function dedupeById(rows: SyncSourceRow[]): SyncSourceRow[] {
  const seen = new Set<number>();
  const result: SyncSourceRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    result.push(row);
  }
  return result;
}

/**
 * 按 id 游标读取下一批。排除软删除行和 warmup 抢答行（与 Dashboard 聚合口径一致）。
 */
export async function fetchBatchAfter(cursor: number, limit: number): Promise<SyncSourceRow[]> {
  const rows = await baseQuery()
    .where(
      and(gt(messageRequest.id, cursor), isNull(messageRequest.deletedAt), EXCLUDE_WARMUP_CONDITION)
    )
    .orderBy(asc(messageRequest.id))
    .limit(limit);

  return dedupeById(rows);
}

/** 单条 IN 查询的最大 id 数：pending 可以很长，不能撞上 Postgres 的绑定参数上限 */
const ID_LOOKUP_CHUNK_SIZE = 1000;

/**
 * 复查 pending 行的当前状态。返回结果可能少于入参（行已被删除）。
 */
export async function fetchByIds(ids: number[]): Promise<SyncSourceRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const rows: SyncSourceRow[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + ID_LOOKUP_CHUNK_SIZE);
    const chunkRows = await baseQuery()
      .where(and(inArray(messageRequest.id, chunk), isNull(messageRequest.deletedAt)))
      .orderBy(asc(messageRequest.id));
    rows.push(...chunkRows);
  }

  return dedupeById(rows);
}

/**
 * 当前最大 id：首次启用时作为游标起点（不回填历史）。
 */
export async function getMaxId(): Promise<number> {
  const rows = await db
    .select({ maxId: sql<number>`COALESCE(MAX(${messageRequest.id}), 0)::int` })
    .from(messageRequest);

  return Number(rows[0]?.maxId ?? 0);
}

/**
 * 恢复用游标：给定时间点之后最早一行的 id 减一。
 * 同步状态丢失时据此重扫一个回看窗口，重复写入由 ReplacingMergeTree 合并。
 */
export async function findCursorBefore(since: Date): Promise<number> {
  const rows = await db
    .select({ minId: sql<number>`COALESCE(MIN(${messageRequest.id}), 0)::int` })
    .from(messageRequest)
    .where(sql`${messageRequest.createdAt} >= ${since}`);

  const minId = Number(rows[0]?.minId ?? 0);
  return minId > 0 ? minId - 1 : 0;
}
