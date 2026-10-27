# Session 请求正文 Redis 去重与二进制 zstd

## 背景

每个代理请求原本向 Redis 写入五份请求正文，TTL 均为 `SESSION_TTL`：

| key 后缀 | 内容 |
|---|---|
| `requestBody` | 补全后的客户端正文 |
| `messages` | 上述正文的 messages 数组 |
| `snapshot:request:before:body` | 补全前的客户端正文 |
| `snapshot:request:before:messages` | 补全前正文的 messages 数组 |
| `snapshot:request:after:body` | 最终发往上游的正文 |

2026-10 在线上实例抽样：同一请求五个 key 各约 512 KiB，两份 body 与两份 messages 字节完全一致，
after 仅比 before 多 56 字节。长时间运行的 agent 会话每轮重发完整上下文，5 MiB 上下文每轮占 25 MiB。
另外所有正文以 zstd 等级 3 压缩后再 base64 编码，额外膨胀 33%。

## 数据布局

每个 `(sessionId, requestSequence)` 一个 Hash，并登记到 session 级 ZSET（按过期时间剪枝，供终止时清理）：

```text
session:{sessionId}:req:{sequence}:request-bodies:v1
session:{sessionId}:request-body-bundles:v1
```

字段：

```text
schema=1
layout=dedup
next=<下一个正文序号>
present:legacy|before|after=1   视图存在（正文可能因超限缺失）
ref:legacy|before|after=<N>     指向 body:N
body:N=<原始 zstd 帧或短正文的 UTF-8 字节>
hash:N=<脱敏后 JSON 的 sha256>
bytes:N=<未压缩 UTF-8 字节数>
dict:N=<基准正文序号>           body:N 以 body:<dict> 解压后的内容为 zstd 字典
```

messages 视图不再存储：读取时按 `ProxySession.getMessages()` 的优先级
（`messages` -> `input` -> `contents` -> `request.contents`）从正文派生。Gemini 正文因此带上
`redactGeminiContents` 的脱敏结果，而不是通用数组脱敏，更准确。

## 写入协议

1. Session guard 调用 `storeSessionRequestBodyBundleBase` 一次：`body:0` 为补全后正文（legacy 视图），
   补全前正文与之相同时 `ref:before=0`，否则作为 `body:1` 以 `body:0` 为字典压缩。
   Lua 原子删除五个旧 key 与旧 Hash，再写入新 Hash、TTL 与索引。返回 `body:0` 的压缩帧，挂在
   `ProxySession.requestBodyBundleBase` 上。
2. Forwarder 写 after 快照时调用 `storeSessionRequestBodyBundleAfter`：哈希等于已有正文时只写
   `ref:after`；否则解压基准帧作字典，追加新正文。重试或对冲多次写 after 时，上一份只被 after 引用的
   正文会被删除，不会累积。基准正文已不在 Hash 中时 Lua 返回 0，TS 改存独立帧重写。
3. 脱敏与体积上限与旧 writer 一致：按未压缩 UTF-8 字节判定，超限视图只记 `present`。

## 字典压缩参数

`windowLog = ceil(log2(字典 + 输入))`（上限 27），`hashLog = min(windowLog, 22)`，等级取
`SESSION_PAYLOAD_ZSTD_LEVEL`。默认 `hashLog` 只能索引字典的一小部分，几乎没有收益。不开启长距离匹配：
在含重复片段的正文上它会把 172 字节的差异放大到约 16 KiB。实测（等级 1，Node 24）：

| 基准正文 | 独立压缩 | 字典压缩 | 耗时 |
|---|---|---|---|
| 1.33 MiB（高重复） | 121 KiB | 192 B | 17 ms |
| 2.45 MiB（随机内容） | 1.2 MiB | 301 B | 32 ms |
| 4.90 MiB（随机内容） | 2.4 MiB | 541 B | 52 ms |

压缩走 zlib 异步 API（libuv 线程池）。进程启动后首次使用时探测 `dictionary` 选项是否生效
（带字典压缩、不带字典解压必须失败），不支持的运行时退回独立压缩。

## 二进制编码

所有 Redis 留存正文（请求 bundle、旧请求 key、response bundle 与旧 response key）改为原始 zstd 帧，
读取端按首字节识别三种格式：zstd 魔数 `28 B5 2F FD`、旧版 `\x1fzst1:` base64 信封、明文。
ioredis 没有 `evalBuffer`，读 Lua 通过 `callBuffer("EVAL", ...)` 拿到 Buffer，见
`src/lib/redis/eval-buffer.ts`。

## 读取与兼容

读取端先查 Hash；Hash 不存在时回退旧 key。flag 关闭时 writer 回到旧的五个 key，新 reader 两种布局
都能读。部署是单机原子切换，混合版本只会让切换瞬间在途请求的详情视图缺失。

## 终止

full `terminateSession()` 的删除 Lua 同时读取请求 bundle 索引，删除每个 bundle 与其五个旧 key。

## 验证

- `bun run test:coverage:session-request-body-dedup`
- `REDIS_URL=... bunx vitest run --config tests/configs/integration.config.mts tests/integration/session-request-body-dedup-redis.test.ts`
