import "server-only";
import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { clickhouseSyncState, keys, messageRequest, providers, users } from "@/drizzle/schema";
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
 * 读取下一批可发送的行。
 *
 * 选取条件只看行自身的状态，不依赖 id 或提交顺序：async INSERT 模式下各进程预留的 id
 * 可能在数小时后才被使用，任何按 id 前进的游标都会永久漏掉这些行。
 *
 * - clickhouse_synced_at IS NULL：尚未确认进入 ClickHouse
 * - 排除软删除行和 warmup 抢答行（与 Dashboard 聚合口径一致，也是清理围栏的"范围外"定义）
 * - created_at >= floor：启用同步之前的历史不回填
 * - updated_at <= settleCutoff：终态之后仍可能有 hedge 败者计费落库，静置后才发送
 * - 已终态，或已超过最长等待时间的孤儿行（进程崩溃后 status_code 永久为 NULL，按 0 发出）
 *
 * 按 (created_at, id) 排序，与部分索引 idx_message_request_clickhouse_unsynced 一致。
 */
export async function fetchUnsyncedBatch(params: {
  floor: Date;
  settleCutoff: Date;
  orphanCutoff: Date;
  limit: number;
}): Promise<SyncSourceRow[]> {
  const rows = await baseQuery()
    .where(
      and(
        isNull(messageRequest.clickhouseSyncedAt),
        isNull(messageRequest.deletedAt),
        EXCLUDE_WARMUP_CONDITION,
        gte(messageRequest.createdAt, params.floor),
        lte(messageRequest.updatedAt, params.settleCutoff),
        or(isNotNull(messageRequest.statusCode), lt(messageRequest.createdAt, params.orphanCutoff))
      )
    )
    .orderBy(asc(messageRequest.createdAt), asc(messageRequest.id))
    .limit(params.limit);

  return dedupeById(rows);
}

/** 单条标记语句的最大 id 数：限制单事务持有的行锁数量 */
const MARK_CHUNK_SIZE = 1000;

function returnedIds(result: unknown): number[] {
  if (!result || typeof result !== "object" || !(Symbol.iterator in result)) {
    return [];
  }
  return Array.from(result as Iterable<{ id: unknown }>, (row) => Number(row.id)).filter((id) =>
    Number.isSafeInteger(id)
  );
}

/**
 * 在 ClickHouse 确认写入之后标记行已同步，返回实际被标记的 id。
 *
 * - updated_at <= settleCutoff：与读取时同一个截止点。读取与标记之间被补写的行
 *   （updated_at 变成 NOW()）不会被标记，下一轮静置后带着新内容重新发送。
 *   不能用等值比较：JS Date 只有毫秒精度，PG 是微秒。
 * - ORDER BY id + FOR UPDATE SKIP LOCKED：与写缓冲的多行 UPDATE 按固定顺序加锁，
 *   避免死锁；正被补写锁住的行留给下一轮。
 * - 刻意不修改 updated_at：它是 ReplacingMergeTree 的版本列，重发相同内容必须得到相同版本。
 *   只更新 clickhouse_synced_at 也不会触发 message_request 上按列声明的触发器。
 *
 * 走 control lane（db），不占用串行化代理写入的 writer lane。
 */
export async function markSynced(
  ids: number[],
  params: { syncedAt: Date; settleCutoff: Date }
): Promise<number[]> {
  const marked: number[] = [];
  const syncedAt = params.syncedAt.toISOString();
  const settleCutoff = params.settleCutoff.toISOString();

  for (let offset = 0; offset < ids.length; offset += MARK_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + MARK_CHUNK_SIZE);
    const idList = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `
    );
    const result = await db.execute(sql`
      WITH target AS (
        SELECT id FROM message_request
        WHERE id IN (${idList})
          AND clickhouse_synced_at IS NULL
          AND updated_at <= ${settleCutoff}::timestamptz
        ORDER BY id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE message_request AS m
      SET clickhouse_synced_at = ${syncedAt}::timestamptz
      FROM target
      WHERE m.id = target.id
      RETURNING m.id
    `);
    marked.push(...returnedIds(result));
  }

  return marked;
}

/** 同步范围下界所在的行键（单行表） */
const FLOOR_KEY = "default";

/**
 * 读取已持久化的同步范围下界；尚未初始化时返回 null。
 */
export async function readClickHouseFloor(): Promise<Date | null> {
  const rows = await db
    .select({ floorAt: clickhouseSyncState.floorAt })
    .from(clickhouseSyncState)
    .where(eq(clickhouseSyncState.key, FLOOR_KEY))
    .limit(1);

  const floorAt = rows[0]?.floorAt;
  return floorAt instanceof Date && !Number.isNaN(floorAt.getTime()) ? floorAt : null;
}

/**
 * 仅在尚未初始化时写入下界（先到的 leader 胜出，之后不再自动修改），返回库里实际的值。
 */
export async function writeClickHouseFloorIfAbsent(floor: Date): Promise<Date> {
  await db
    .insert(clickhouseSyncState)
    .values({ key: FLOOR_KEY, floorAt: floor })
    .onConflictDoNothing({ target: clickhouseSyncState.key });

  return (await readClickHouseFloor()) ?? floor;
}
