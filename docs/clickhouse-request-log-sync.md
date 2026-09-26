# ClickHouse 请求日志同步

把请求日志增量同步到外部 ClickHouse，用于中期留存与分析：谁、在什么时候、从什么 IP、请求了什么模型，
以及对应的用量、耗时、状态和费用。

**只写不读**：Dashboard 的日志页、统计、排行榜全部仍然查 PostgreSQL。本功能不改变任何查询路径。

## 为什么这样设计

一条 `message_request` 记录的生命周期是碎片化的：guard 链末尾先 INSERT 一行空指标记录，随后是若干
fire-and-forget 的元数据补丁，费用由专门的函数绕过写缓冲直写，最后才是带 `status_code` 的终态补丁。
终态点分散在 `response-handler.ts`、`error-handler.ts`、各 guard 的拦截路径里，有七八处。

因此同步**不在代理热路径埋点**，而是由一个后台 worker 扫描 `message_request` 中尚未同步的行，
写入 ClickHouse 之后在行上打同步标记（`clickhouse_synced_at`）。
好处：

- 采集点只有一个。新增的拦截路径、未来的新字段都会自动覆盖，ClickHouse 的内容与 PostgreSQL 一致
- PostgreSQL 本身就是持久缓冲。ClickHouse 宕机时行保持未标记，恢复后自动追平，不需要额外的落盘队列
- 单 leader 大批量写入，正是 ClickHouse 偏好的写入方式
- 对请求延迟零影响

代价是数据有分钟级延迟（默认约 2.5 分钟静置 + 一个同步周期，可调）。

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
| `CLICKHOUSE_SYNC_SETTLE_MS` | 150000 | 终态静置：终态后再等这么久才发送 |
| `CLICKHOUSE_SYNC_MAX_PENDING_AGE_MS` | 3600000 | 未终态行的最长等待时间 |

前置条件：需要可用的 `REDIS_URL`，多副本部署靠 Redis leader lock 选出唯一同步者。
同步进度本身存在 PostgreSQL（行上的标记 + 单行表 `clickhouse_sync_state`），Redis 丢失不影响进度。

旧版本的 `CLICKHOUSE_SYNC_LAG_MS`、`CLICKHOUSE_SYNC_MAX_PENDING` 已移除，留在 `.env` 里会被忽略。

表结构在首次运行时自动创建（`CREATE TABLE IF NOT EXISTS` + 逐列 `ADD COLUMN IF NOT EXISTS`），
不需要手工建表。

## 同步语义

每一行的同步状态记录在它自己身上：

- `message_request.clickhouse_synced_at`：ClickHouse 确认写入这一行已静置的内容之后才设置
- `clickhouse_sync_state.floor_at`（单行表）：同步范围下界，`created_at` 早于它的行不同步、不回填

每一轮读取一批满足下列条件的行，写入 ClickHouse，然后给它们打标记：

- `clickhouse_synced_at IS NULL`、未软删除、不是 warmup 抢答行
- `created_at >= floor_at`
- `updated_at` 已经过了静置窗口
- 已终态（`status_code IS NOT NULL`），或者已超过 `MAX_PENDING_AGE_MS` 的孤儿行

按 `(created_at, id)` 排序，由部分索引 `idx_message_request_clickhouse_unsynced` 支撑；
稳态下这个索引只包含在途的行。

### 为什么不用 id 游标

旧版按 `id > cursor` 增量读取，并假设游标以下不会再出现新行，靠 5 分钟回看延迟规避 `serial`
的提交序空洞。`MESSAGE_REQUEST_INSERT_MODE=async` 打破了这个假设：每个进程一次预留 128 个 id，
真正有请求时才使用其中一个并打上 `created_at`。流量不均时，一个进程预留的低 id 可以闲置数小时，
其间其他进程的高 id 已经被同步、游标已经越过；这些低 id 行之后才写入，就永远不会被选中。
固定的回看延迟没有上界能覆盖"预留但未使用"的闲置时间，所以进度改为记录在行上，
选取条件不再依赖 id 或提交顺序。

### 静置与标记

一行"可发送"的条件是 `status_code IS NOT NULL`（仓库内统一的终态判定）且 `updated_at` 已经过了静置窗口。
静置是必要的：终态之后 hedge 竞速败者的计费仍会落库，上限是 `HEDGE_LOSER_DRAIN_TIMEOUT_MS`（默认 120 秒），
过早同步会取到中间值。默认静置 150 秒 = 120 秒 + 30 秒余量；静置短于这个值时 worker 启动会告警。

标记语句只标记 `updated_at` 仍不晚于本轮静置截止点的行，并按 id 顺序 `FOR UPDATE SKIP LOCKED`：

- 读取与标记之间被补写的行（`updated_at` 变成 `NOW()`）不会被标记，静置后带着新内容重新发送
- 正被补写锁住的行留给下一轮，不会与写缓冲的多行 UPDATE 互相死锁
- 标记不修改 `updated_at`（它是 ClickHouse 的版本列），也不触发 `message_request` 上按列声明的触发器

标记之后仍然落库的补写（超过静置窗口的迟到计费）不会再同步，这与旧版相同。

几个刻意的取舍：

- **投递语义是"至少一次"**。ClickHouse 写入成功之后才打标记，进程在两者之间被杀会导致重复。
  表引擎是 `ReplacingMergeTree(updated_at)`，排序键 `(created_at, id)`，重复行会在 merge 时折叠。
  查询时用 `FINAL` 或按 `id` 去重可以立刻看到收敛后的结果。
  如果 PostgreSQL 能读不能写（标记失败），worker 在进程内记住"已发送未标记"的行及其 `updated_at`，
  不会每轮重发同一批；内容变化过的行仍会重发。
- **孤儿行有兜底**。进程崩溃后 `status_code` 会永久为 NULL，PostgreSQL 侧没有清扫者。
  这类行等满 `MAX_PENDING_AGE_MS` 后按原样发出，`status_code` 落成 `0`。
  查询时可以用 `status_code = 0` 把它们识别出来。
  代价：万一这行后来真的终态了（例如超过一小时的流式请求），ClickHouse 里会留下 `0`。
- **不同步的内容**：`message_request.key`（API key 原文，**绝不外发**）、
  `routing_trace` / `provider_chain` / `cost_breakdown` 等大 jsonb 字段、`error_stack`。
  `routing_trace` 在终态后最长 7 天内仍可能被 outbox 补写，不适合这套静置模型。
- **排除 `blocked_by = 'warmup'`** 的抢答探测行，与 Dashboard 各类聚合口径保持一致。
- **用户名/密钥名/供应商名是快照**。ClickHouse 无法回 JOIN PostgreSQL，所以同步时一并写入名称。
  改名或删除之后，历史审计记录依然可读。三个维度表全部 LEFT JOIN，被拦截的行（`provider_id = 0`）
  和已删除的密钥都不会丢。

失败时的行为：ClickHouse 或 Redis 不可用，本周期直接放弃，行保持未标记，日志里每分钟最多一条告警。
代理请求永远不受影响。

### 同步范围下界

首个 leader 初始化 `floor_at`，之后不再自动修改：

- ClickHouse 已有数据：取其中最早的 `created_at`。这个范围内缺少标记的行会被（重新）发送
- ClickHouse 为空：`now - MAX_PENDING_AGE_MS`，不回填历史，但覆盖正在进行中的请求

之后 ClickHouse 的 TTL 过期或手工导入都不会移动下界。需要调整时手工修改该行。

## 与日志清理的联动

启用同步后，`cleanupLogs` 会自动加上同步围栏：只允许删除
**已打标记、已软删除、warmup，或 `created_at` 早于同步下界**的行。
尚未确认进入 ClickHouse 的范围内行无论 id 大小都不会被删除，可以放心把 `cleanupRetentionDays` 调短。

如果同步下界尚未初始化或读不出来，清理会直接中止并告警——宁可多留数据，也不删可能还没同步的行。
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
| `src/lib/clickhouse/source.ts` | PostgreSQL 侧查询：未同步行、同步标记、下界读写 |
| `src/lib/clickhouse/sync-state.ts` | 同步范围下界、清理围栏 |
| `src/lib/clickhouse/sync-worker.ts` | leader 选举与同步循环 |

启动在 `src/instrumentation.ts`（生产与开发两处调度块）；停止是 `src/lib/lifecycle/shutdown.ts` 的
步骤 7d，位于关闭数据库连接池之前。

进程内状态可以通过 `getClickHouseSyncStatus()` 读取（同步下界、已发送未标记数、累计发送量、最近错误）。

## 运维要点

- 同步进度在 PostgreSQL 里，Redis 被清不会造成缺口，也不会触发回看重扫。
- ClickHouse 表为空且没有下界时，从 `now - MAX_PENDING_AGE_MS` 开始，**不回填历史**。
  需要回填更早的历史，把 `clickhouse_sync_state.floor_at` 改早即可，缺少标记的行会被自动发送。
- `CLICKHOUSE_TTL_DAYS` 只在建表时生效。表已存在时不会自动 `MODIFY TTL`（那会触发数据分片重写），
  只会在日志里给出待执行的 `ALTER` 语句。
- 只有后台任务进程（`CCH_MULTICORE_BACKGROUND_OWNER != "0"`）会参与同步；
  跨副本再由 Redis leader lock 收敛到唯一一个。
- 迁移 `0128_clickhouse_sync_marker` 会在 `message_request` 上建部分索引，大表上会持有数秒 SHARE 锁。
  繁忙或多副本部署请先按迁移文件头部的语句 `CREATE INDEX CONCURRENTLY` 预建索引，再部署。

### 从 id 游标版本升级

升级后第一个 leader 会忽略 Redis 里旧的 `clickhouse_sync:state`（并删除它），以 ClickHouse 中最早的
`created_at` 作为下界，然后把范围内所有尚未打标记的行重新发送一遍。这一步就是对旧版漏同步行的幂等回填：

- 已在 ClickHouse 里的行会多出一条 `(created_at, id, updated_at)` 相同的副本，merge 时折叠
- 首次发送之后在 PostgreSQL 里又被更新过的行（包括后来终态的孤儿行）会被纠正
- 速度上限是每个周期 `SYNC_BATCH_SIZE × 20` 行（默认每 5 秒 10 万行），几十万行在数分钟内完成

完成后可以执行 `OPTIMIZE TABLE <db>.<table> FINAL` 提前折叠副本。
升级前请确认没有按旧版 `id <= 游标` 围栏运行的短保留期清理，它可能已经删掉部分漏同步的行，这些行无法恢复。

### 核对缺口

```sql
-- PostgreSQL：应当同步但尚未标记的行（稳态下应接近 0）
SELECT count(*) FROM message_request
WHERE clickhouse_synced_at IS NULL
  AND deleted_at IS NULL
  AND (blocked_by IS NULL OR blocked_by <> 'warmup')
  AND created_at >= (SELECT floor_at FROM clickhouse_sync_state)
  AND status_code IS NOT NULL
  AND updated_at < now() - interval '5 minutes';
```

```sql
-- ClickHouse：按 id 去重后的行数，与 PostgreSQL 范围内的行数对比
SELECT count() FROM cch_request_log FINAL WHERE created_at >= '<floor_at>';
```
