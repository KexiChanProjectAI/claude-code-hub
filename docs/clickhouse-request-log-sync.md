# ClickHouse 请求日志同步

把请求日志增量同步到外部 ClickHouse，用于中期留存与分析：谁、在什么时候、从什么 IP、请求了什么模型，
以及对应的用量、耗时、状态和费用。

**只写不读**：Dashboard 的日志页、统计、排行榜全部仍然查 PostgreSQL。本功能不改变任何查询路径。

## 为什么这样设计

一条 `message_request` 记录的生命周期是碎片化的：guard 链末尾先 INSERT 一行空指标记录，随后是若干
fire-and-forget 的元数据补丁，费用由专门的函数绕过写缓冲直写，最后才是带 `status_code` 的终态补丁。
终态点分散在 `response-handler.ts`、`error-handler.ts`、各 guard 的拦截路径里，有七八处。

因此同步**不在代理热路径埋点**，而是由一个后台 worker 按主键游标增量读取 `message_request`。
好处：

- 采集点只有一个。新增的拦截路径、未来的新字段都会自动覆盖，ClickHouse 的内容与 PostgreSQL 一致
- PostgreSQL 本身就是持久缓冲。ClickHouse 宕机时游标不前进，恢复后自动追平，不需要额外的落盘队列
- 单 leader 大批量写入，正是 ClickHouse 偏好的写入方式
- 对请求延迟零影响

代价是数据有分钟级延迟（默认约 5 分钟，可调）。

## 配置

设置 `CLICKHOUSE_URL` 即启用，其余变量都有默认值。完整列表见 `.env.example`。

```bash
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=secret
CLICKHOUSE_DATABASE=default
CLICKHOUSE_TABLE=cch_request_log
CLICKHOUSE_TTL_DAYS=180          # 可选；留空则不设 TTL
```

时序相关的可调项：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `CLICKHOUSE_SYNC_INTERVAL_MS` | 5000 | 同步周期 |
| `CLICKHOUSE_SYNC_BATCH_SIZE` | 5000 | 单批最大行数 |
| `CLICKHOUSE_SYNC_LAG_MS` | 300000 | 回看延迟：只处理这么久以前创建的行 |
| `CLICKHOUSE_SYNC_SETTLE_MS` | 150000 | 终态静置：终态后再等这么久才发送 |
| `CLICKHOUSE_SYNC_MAX_PENDING_AGE_MS` | 3600000 | 未终态行的最长等待时间 |
| `CLICKHOUSE_SYNC_MAX_PENDING` | 20000 | pending 上限（背压阈值） |

前置条件：需要可用的 `REDIS_URL`。同步进度存在 Redis，多副本部署也靠 Redis leader lock 选出唯一同步者。

表结构在首次运行时自动创建（`CREATE TABLE IF NOT EXISTS` + 逐列 `ADD COLUMN IF NOT EXISTS`），
不需要手工建表。

## 同步语义

进度存在 Redis 的 `clickhouse_sync:state`，形如 `{ cursor, pending }`。

- `cursor`：已扫描过的最大 `message_request.id`
- `pending`：游标已越过、但当时还不可发送的行

每个周期做两件事：**复查 pending**，然后**按游标扫新行**。

一行"可发送"的条件是 `status_code IS NOT NULL`（仓库内统一的终态判定）且 `updated_at` 已经过了静置窗口。
静置是必要的：终态之后 hedge 竞速败者的计费仍会落库，上限是 `HEDGE_LOSER_DRAIN_TIMEOUT_MS`（默认 120 秒），
过早同步会取到中间值。默认静置 150 秒 = 120 秒 + 30 秒余量。

回看延迟解决另一个问题：`id` 是 `serial`，分配顺序不等于提交顺序，刚创建的区间可能还有更小的 id 尚未提交。
只处理 `LAG` 之前创建的行就能避开这些空洞。因为 `LAG`(5 分钟) > `SETTLE`(150 秒)，
绝大多数请求在游标到达时已经可发送，`pending` 里只会留下长流式请求。

几个刻意的取舍：

- **投递语义是"至少一次"**。ClickHouse 写入成功之后才持久化进度，进程在两者之间被杀会导致重复。
  表引擎是 `ReplacingMergeTree(updated_at)`，排序键 `(created_at, id)`，重复行会在 merge 时折叠。
  查询时用 `FINAL` 或按 `id` 去重可以立刻看到收敛后的结果。
- **孤儿行有兜底**。进程崩溃后 `status_code` 会永久为 NULL，PostgreSQL 侧没有清扫者。
  这类行不能让游标永久卡住，所以等满 `MAX_PENDING_AGE_MS` 后按原样发出，`status_code` 落成 `0`。
  查询时可以用 `status_code = 0` 把它们识别出来。
  代价：万一这行后来真的终态了（例如超过一小时的流式请求），ClickHouse 里会留下 `0`。
- **不同步的内容**：`message_request.key`（API key 原文，**绝不外发**）、
  `routing_trace` / `provider_chain` / `cost_breakdown` 等大 jsonb 字段、`error_stack`。
  `routing_trace` 在终态后最长 7 天内仍可能被 outbox 补写，不适合这套静置模型。
- **排除 `blocked_by = 'warmup'`** 的抢答探测行，与 Dashboard 各类聚合口径保持一致。
- **用户名/密钥名/供应商名是快照**。ClickHouse 无法回 JOIN PostgreSQL，所以同步时一并写入名称。
  改名或删除之后，历史审计记录依然可读。三个维度表全部 LEFT JOIN，被拦截的行（`provider_id = 0`）
  和已删除的密钥都不会丢。

失败时的行为：ClickHouse 或 Redis 不可用，本周期直接放弃，游标不动，日志里每分钟最多一条告警。
代理请求永远不受影响。

## 与日志清理的联动

启用同步后，`cleanupLogs` 会自动加上 `id <= 同步围栏` 的条件，围栏取 `min(cursor, min(pending) - 1)`。
因此**尚未同步出去的行不会被删除**，可以放心把 `cleanupRetentionDays` 调短。

如果同步进度读不出来（Redis 不可用），清理会直接中止并告警——宁可多留数据，也不删可能还没同步的行。
这意味着 ClickHouse 长期宕机时，PostgreSQL 会相应地多留数据。

缩短保留期之前请注意：Dashboard 的日志页和会话页读 `message_request`，可见历史会随之缩短；
排行榜、概览、配额走 `usage_ledger`，不受影响。

## 查询示例

```sql
-- 某个 IP 最近的请求
SELECT created_at, user_name, key_name, model, status_code, cost_usd
FROM cch_request_log
WHERE client_ip = toIPv6('::ffff:203.0.113.9')
  AND created_at > now() - INTERVAL 7 DAY
ORDER BY created_at DESC
LIMIT 100;

-- 按用户和模型的用量
SELECT user_name, model, count() AS requests,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       round(sum(cost_usd), 4) AS cost
FROM cch_request_log FINAL
WHERE created_at >= toStartOfMonth(now()) AND status_code = 200
GROUP BY user_name, model
ORDER BY cost DESC;

-- 一个用户用过哪些 IP
SELECT client_ip, count() AS requests, min(created_at) AS first_seen, max(created_at) AS last_seen
FROM cch_request_log
WHERE user_name = 'alice' AND created_at > now() - INTERVAL 30 DAY
GROUP BY client_ip
ORDER BY last_seen DESC;
```

`client_ip` 是 `IPv6` 列，IPv4 以 IPv4-mapped 形式（`::ffff:a.b.c.d`）存储，未知 IP 是 `::`。
统一成一种表示之后按 CIDR 过滤才不会漏：

```sql
WHERE isIPAddressInRange(toString(client_ip), '::ffff:10.0.0.0/104')
```

## 实现位置

| 文件 | 职责 |
| --- | --- |
| `src/lib/clickhouse/config.ts` | 读 env，`isClickHouseSyncEnabled()` |
| `src/lib/clickhouse/client.ts` | 基于 `fetch` 的 HTTP 客户端（无 SDK 依赖） |
| `src/lib/clickhouse/schema.ts` | DDL 生成与 `ensureSchema()` |
| `src/lib/clickhouse/row-mapper.ts` | PostgreSQL 行 -> ClickHouse 行（纯函数） |
| `src/lib/clickhouse/source.ts` | PostgreSQL 侧查询 |
| `src/lib/clickhouse/sync-state.ts` | Redis 进度、恢复逻辑、清理围栏 |
| `src/lib/clickhouse/sync-worker.ts` | leader 选举与同步循环 |

启动在 `src/instrumentation.ts`（生产与开发两处调度块）；停止是 `src/lib/lifecycle/shutdown.ts` 的
步骤 7d，位于关闭数据库连接池之前。

进程内状态可以通过 `getClickHouseSyncStatus()` 读取（游标、pending 数、累计发送量、最近错误）。

## 运维要点

- 同步进度丢失（Redis 被清）不会造成数据缺口：worker 会读取 ClickHouse 的最新 `created_at`，
  往前回看一个 `MAX_PENDING_AGE_MS` 窗口重扫，重复由 `ReplacingMergeTree` 收敛。
- ClickHouse 表为空且没有进度时，游标从当前最大 id 开始，**不回填历史**。
  需要回填历史请手工导出导入。
- `CLICKHOUSE_TTL_DAYS` 只在建表时生效。表已存在时不会自动 `MODIFY TTL`（那会触发数据分片重写），
  只会在日志里给出待执行的 `ALTER` 语句。
- 只有后台任务进程（`CCH_MULTICORE_BACKGROUND_OWNER != "0"`）会参与同步；
  跨副本再由 Redis leader lock 收敛到唯一一个。
