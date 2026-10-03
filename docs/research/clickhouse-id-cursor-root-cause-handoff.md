# ClickHouse 请求日志漏同步：根因分析 handoff

> 2026-09-26 调查；针对 CCH 0.9.5，工作树和线上 CPS、cch-prod-la 的 `.next/BUILD_ID` 均为 `E4CIgiz29Ypt-ij2pcbKj`。本文是给接手分析／修复的工程师的事实、复现与验收边界，不代表已经修复。

## 结论：先看 ID 预取与游标，不要先排查网络

`MESSAGE_REQUEST_INSERT_MODE=async` 时，每个应用进程向 PostgreSQL sequence **成批预取** `message_request.id`，稍后请求到达才使用其中一个 ID 并 INSERT。ClickHouse worker 却假设按 `id` 前进的游标之后不会再出现更小的新行。多进程流量不均时，高 ID 所属进程先写入并被同步，低 ID 所属进程可以闲置数小时后才使用早已预留的 ID；新行因此落在 `cursor` 以下，永远不被增量查询选中。5 分钟 `created_at` 延迟不能限制“预留但未使用”的 ID 会闲置多久。

这是**静默漏数**，不是同步器停机：Redis 的 `pending` 只含已经被查询到、但未终态或未静置的行，无法代表尚不存在的预留 ID。ClickHouse 连通且 CCH readiness 为 healthy 时仍会漏行。

### 线上证据（2026-09-26 约 15:40 UTC，只读）

| 实例 | INSERT 模式／并行度 | CH 表及已推进最高 ID | 后续 PG 行与结果 |
| --- | --- | --- | --- |
| CPS（原 38 的 CCH，PG 位于 38） | `async`；16 workers；每进程默认预取 128 ID | dslab `cch.cch_logs`，Redis `clickhouse_sync:state` 为 `{"cursor":651558,"pending":[]}`；CH 最后 `created_at` 为 10:00:59 UTC，`synced_at` 为 10:06 UTC | 至少 100 条在此后创建、已终态且静置、未软删／非 warmup 的 PG 行，其 ID 不大于游标。例：PG ID `651314`、HTTP 200，CH 按 ID 查询为 0 行。 |
| cch-prod-la | `async`；4 workers；每进程默认预取 128 ID | GCE `cch.cch_prod_la`，CH 最高 ID `287186`；最后 `created_at` 为 13:51:19 UTC、`synced_at` 为 13:56 UTC | 此后约 97 条已终态且静置的 PG 行的 ID 不大于 CH 最高 ID（其中一行是 CH 时间精度截断导致的边界重叠）；例：PG ID `286991`、HTTP 200，CH 按 ID 查询为 0 行。 |

CPS 从应用主机使用现有凭据直接查询 dslab ClickHouse 成功；两个实例的数据库序列 `cache_size=1`，**不是 PostgreSQL sequence cache 配错**。异步预取发生在应用层。ID 跨 worker 乱序的具体对应关系未记录 worker slot；上表的代码机制与实测 ID／时间关系吻合，不要把某个具体 ID 归到某个 worker 当作已观测事实。

另外 `cch-daily-la`、`cch.in.dslab.top` 也启用了异步 INSERT。它们的 CH 最新时间在推进，只能证明同步没整体停摆，**不能证明没有散落的低 ID 漏行**。`cch-3rd-la` 是现行 `cch-jp.zenkexi.com` 的 Cloudflare tunnel 源站；旧 `cch_jp` 表在 09-22 停止不属于此故障。ThinkPad CCH 未配置 ClickHouse。

## 必读源码：具体哪条不变量被破坏

1. `src/repository/message-insert-buffer.ts:73-151`：异步开关、`nextval(... ) FROM generate_series(1, chunkSize)`、每进程 `availableIds`、使用 ID 时才 `createdAt = new Date()`。默认 chunk 128 在 `src/lib/config/env.schema.ts:101-110`；`src/repository/message.ts:333-350` 优先走该缓冲，失败才同步 INSERT。
2. `src/repository/message-insert-buffer.ts:199-231`：真正提交发生在后续 multi-row flush，保留预先取得的 ID。缓冲 flush 很快也**不能解决闲置预留 ID**：行甚至尚未 enqueue。
3. `src/lib/clickhouse/source.ts:80-92`：只查 `id > cursor`，按 ID 升序；排除软删及 `blocked_by='warmup'`。
4. `src/lib/clickhouse/sync-worker.ts:89-154`：按 `createdAt` 做 5 分钟 lag，推进到看到的最大 ID；`pending` 只包含已看到但不可发送的行，写 CH 后才落 Redis 状态。
5. `src/lib/clickhouse/sync-state.ts:13-27,98-159`：Redis 游标与恢复策略；状态丢失时用 CH 最新时间往前回看 `MAX_PENDING_AGE_MS`（默认一小时），**不足以补数小时前漏掉的 ID**。
6. `src/lib/log-cleanup/service.ts:90-100,140-149`：清理仅以 `id <= fence` 保证“已同步”；该不变量目前为假，达到保留期后可能永久删掉尚未进 CH 的 PG 行。
7. `docs/clickhouse-request-log-sync.md:53-95`：现有设计文档声称 5 分钟 lag 可以避开 `serial` 的乱序空洞；该解释没有考虑应用进程预留 128 ID 且空闲任意时长的路径。
8. `tests/unit/lib/clickhouse/sync-worker.test.ts:163-215`：现有测试仅用已可见的顺序 ID，未模拟低 ID 在游标超过之后才 INSERT。

最小反例：进程 A 先预留 `1..128` 但没有请求；进程 B 预留 `129..256` 并写入 `129`；五分钟后同步器看到 `129`，将游标推进到 `129`，`pending=[]`；数小时后 A 首次请求才写入 `id=1, created_at=此时`。`fetchBatchAfter(129)` 不会看到它。增加固定 lag 或修改 PG sequence cache 都没有有限上界保证。

## 接手任务与安全边界

- **先确认缺口**：按源 PG 的 `id`、`created_at`、`status_code`、`updated_at`、`deleted_at`、`blocked_by` 与目标 CH 的 ID 作差集，窗口覆盖 CH 已越过的历史 ID，而不是只看两边最新时间／行数。CH 用 `ReplacingMergeTree(updated_at)`、排序键 `(created_at,id)`；普通 `count()` 在 merge 前可能含重投行，验收用按 `(created_at,id)` 去重或 `FINAL`。源查询必须继续排除软删和 warmup，且不得将 API key 原文发往 CH。
- **立即止血与补数是两件事**：暂切 `MESSAGE_REQUEST_INSERT_MODE=sync` 并重启所有受影响 worker，可以使后续请求由 DB 在 INSERT 时取 ID，但会增加请求写库延迟；还需要另行对 PG 仍保留的漏行做幂等回填。不要误称切模式即可修复既有缺口。
- **不要盲清或回退 Redis 游标**：一小时 watermark 恢复可能漏掉更旧行；重复导入需处理 CH 现有主键／版本语义。先保护 PG 留存，尤其不要运行会受错误 `fence` 放行的清理来消耗尚未回填的历史记录。
- **永久修复需恢复可证明的不变量**：可用数据库提交顺序安全的 outbox／逐行同步标记与确认，或一个有严格保留、重扫和去重语义且不依赖预留 ID 单调性的方案。不能仅把 lag 从 5 分钟调大、只记录已存在行的 `pending`、或只在某些 UA／实例上特判。同步进度与 `cleanupLogs` 的删除围栏须一起重新设计。
- **验收测试**：两进程预留并乱序消费 ID；游标越过后才出现的低 ID；跨多个周期和数小时闲置（用虚拟时钟）；重启／Redis 状态丢失；CH 插入成功但状态落盘前失败的重投；软删／warmup 排除；清理围栏不得覆盖任何尚未确认入 CH 的行。用这一反例测试证明旧实现会漏、新实现不漏；再比较线上 PG 与 CH 的可同步行差集，并观察至少两个同步周期的新请求。

本 handoff 未修改应用源码、线上 INSERT 模式、Redis 游标或历史 ClickHouse 数据。
