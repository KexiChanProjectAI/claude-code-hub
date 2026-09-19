import "server-only";
import type { ClickHouseConfig } from "@/lib/clickhouse/config";

/**
 * ClickHouse HTTP 客户端（基于全局 fetch，不引入 SDK 依赖）。
 *
 * 生产运行时是 Node 22 + Next standalone 产物，新增运行时依赖需要额外保证被打进
 * standalone 输出；而我们只需要 ClickHouse HTTP 接口的两个能力（执行语句、
 * JSONEachRow 批量写入），原生 fetch 足够。
 */

const ERROR_BODY_MAX_LENGTH = 2000;

export class ClickHouseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ClickHouseError";
    this.status = status;
  }
}

function buildHeaders(config: ClickHouseConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-ClickHouse-User": config.user,
  };
  // 空密码时不发送 Key 头：部分部署对空值敏感
  if (config.password) {
    headers["X-ClickHouse-Key"] = config.password;
  }
  return headers;
}

async function post(
  config: ClickHouseConfig,
  params: Record<string, string>,
  body: string
): Promise<string> {
  const search = new URLSearchParams({ database: config.database, ...params });
  const url = `${config.url}/?${search.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(config),
      body,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    // 网络失败/超时：包装成统一错误类型，status 0 表示"没拿到 HTTP 响应"
    const message = error instanceof Error ? error.message : String(error);
    throw new ClickHouseError(`ClickHouse request failed: ${message}`, 0);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new ClickHouseError(
      `ClickHouse responded ${response.status}: ${text.slice(0, ERROR_BODY_MAX_LENGTH)}`,
      response.status
    );
  }

  return text;
}

/**
 * 执行一条不关心返回内容的语句（DDL 等）。
 */
export async function exec(config: ClickHouseConfig, query: string): Promise<void> {
  await post(config, {}, query);
}

/**
 * 执行查询并按 JSONEachRow 解析结果。
 */
export async function queryJson<T>(config: ClickHouseConfig, query: string): Promise<T[]> {
  const text = await post(config, { default_format: "JSONEachRow" }, query);
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * 批量写入：INSERT ... FORMAT JSONEachRow。
 *
 * 不设置 input_format_skip_unknown_fields：宁可写入失败并告警，也不要在表结构
 * 落后于代码时静默丢列（表结构升级由 ensureSchema 的 ADD COLUMN 负责）。
 */
export async function insertJsonEachRow(
  config: ClickHouseConfig,
  qualifiedTable: string,
  rows: ReadonlyArray<Record<string, unknown>>
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const body = rows.map((row) => JSON.stringify(row)).join("\n");

  await post(
    config,
    {
      query: `INSERT INTO ${qualifiedTable} FORMAT JSONEachRow`,
      // 时间字段以带时区的 ISO 字符串发送，需要 best_effort 解析
      date_time_input_format: "best_effort",
    },
    body
  );
}
