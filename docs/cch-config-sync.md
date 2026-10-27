# CCH 供应商与模型配置同步

脚本：`scripts/sync-cch-config.ts`。从源 PostgreSQL 数据库读取一致性快照，在目标数据库的一个事务内覆盖配置，并支持 JSON 条件覆写规则。

管理 REST API 会脱敏代理凭据、自定义请求头等字段，无法用于无损复制。本脚本直接使用 DSN，复制完整凭据；不会把凭据或配置行打印出来。

## 使用

前提：Bun、仓库已安装依赖、两端已应用相同配置表 schema。需要源数据库的读取权限；目标数据库需要查询、写入、表锁及配置表序列的使用权限。表固定使用 `public` schema。

两端 DSN 可从各实例的 `.env` 中获得。数据库仅绑定 localhost 时，先建立 SSH 隧道，再使用对应的本地端口；不需要开放数据库的公网访问。

```bash
export CCH_SOURCE_DSN='postgresql://source_user:password@source-db:5432/cch'
export CCH_TARGET_DSN='postgresql://target_user:password@target-db:5432/cch'

# 无 --overwrite 时只预览，不写入目标。
bun scripts/sync-cch-config.ts --rules scripts/sync-cch-config.example.json

# 显式预览；即使同时传 --overwrite，--dry-run 仍优先。
bun scripts/sync-cch-config.ts --rules scripts/sync-cch-config.example.json --dry-run

# 停止目标 CCH 并备份目标数据库后，执行覆盖。
bun scripts/sync-cch-config.ts --rules scripts/sync-cch-config.example.json --overwrite

# 不需要条件覆写时，可省略 --rules。
bun scripts/sync-cch-config.ts --overwrite
```

覆盖完成后启动或重启目标 CCH。直接写数据库不会发布应用缓存失效消息，因此必须重启目标的所有 worker / 副本。脚本不会替你停止服务、备份数据库或操作 Redis。

输出是每张表的源记录数及目标**覆盖前**的记录数，不包含字段 diff 或敏感数据。dry-run 检查连接、schema、规则字段和匹配行的 URL 改写；它不尝试写入，所以不保证覆写后的值满足目标数据库的全部约束。真正覆盖时任意写入失败都会回滚全部配置变更，退出码为 1。成功或预览完成退出码为 0。

支持 `--help` 和 `--lang zh-CN|zh-TW|en|ja|ru`，默认 `zh-CN`。

## 同步范围与覆盖语义

| 表 | 行为 |
|---|---|
| `providers` | 复制所有未软删除的供应商，包括禁用项、完整 key / New API token / 自定义请求头、模型白名单、模型重定向、前缀、限流、优先级、代理及参数覆写等全部字段 |
| `provider_endpoints` | 复制所有未软删除的端点池配置，包括禁用项；不复制测活快照 |
| `provider_vendors` | 按 `website_domain` 覆盖同名实体，新增缺失实体并重映射两张表的外键 |
| `provider_groups` | 完全替换分组名称、倍率、描述等配置 |
| `model_prices` | 完全替换全部价格记录，保留 cloud / litellm / manual 来源、原始 JSON 及时间精度，包括同模型多条价格记录 |
| `cloud_pricing_catalog` | 完全替换云端价格目录元数据 |

默认没有保留策略时，目标独有的活动供应商和端点会软删除；分组、模型价格及价格目录中目标独有的记录会移除。供应商与端点使用新的目标 ID，而非复用源 ID，因此不会将旧用量错误关联到新供应商。原有目标供应商、端点及其历史记录保留；旧 vendor 实体也保留，以满足历史外键约束。重复同步会再次软删除旧活动项并生成新的 ID，不是保留 ID 的增量同步。通过 `--policy` 保留的供应商及其 vendor / 端点池不执行上述替换。

不复制源实例的用户、用户密钥、用量、会话、熔断状态、额度探测快照、测活历史、系统设置或请求过滤器。`total_cost_reset_at` 和端点的 `last_probe*` 字段在新配置中置空。供应商限额配置会复制，但源供应商已用额度不会复制，新目标供应商从自身用量开始计费。

**注意目标端 ID 绑定：** 如果目标已有按供应商 ID 配置的请求过滤器，覆盖后它们仍引用旧 ID，不会自动绑定新供应商。脚本不迁移这些独立配置；有这种配置时，需要在启用目标服务前重新绑定。源端的请求过滤器也不在同步范围内。

改写 URL 不会自动重新聚类 vendor，分组关系沿用源配置。需要改 vendor 域名时，可另加 `provider_vendors` 的 `website_domain` 覆写规则。多条端点被改写成同一 vendor / 类型 / URL，或多个 vendor 被改成同一域名时，数据库约束可能拒绝同步，事务会回滚。

## 目标供应商保留策略

`--policy` 接收一个策略文件，可指定保留的目标供应商名称和最后执行的覆写规则。供应商名称区分大小写、按完整名称匹配；重复名称去重。白名单中任何名称在目标缺失或已软删除时，dry-run 和覆盖都拒绝执行，避免拼写错误导致误删除。

仓库的 `scripts/sync-cch1-policy.json` 已配置：

```json
{
  "preserveProviders": ["cc官key", "openai 官key"],
  "rules": [
    {
      "tables": ["providers"],
      "set": { "proxy_fallback_to_direct": false }
    }
  ]
}
```

```bash
bun scripts/sync-cch-config.ts --policy scripts/sync-cch1-policy.json --dry-run
```

- 白名单供应商不更新、不软删除，保留目标原有 ID、key、URL、代理、fallback、限额、时间戳等全部字段。即使源端出现同名供应商，或普通规则将源记录改成白名单名称，也不会覆盖目标。
- 白名单供应商的 vendor 记录，以及同 vendor / provider_type 的整个端点池保留原状。源端对应 vendor 的元数据和对应池的端点不会覆盖它们；共享该池的非白名单供应商也会使用保留下来的目标池。
- `--rules` 先执行，策略中的 `rules` 最后执行。上述 cch1 策略强制所有参与同步的供应商禁用直连回退，即使普通规则之前设为 true；白名单两项完全不受覆写规则影响。
- 分组、模型价格和价格目录仍按全局同步范围覆盖，不因为供应商白名单而排除。请求过滤器仍不迁移；白名单原 ID 不变，因此它们原有的 ID 绑定不被本脚本改变。
- 输出的 `providers.preserved` 是实际保留的目标供应商数量；`providers.source` 排除被白名单跳过的源记录。

该策略**不包含** cch1 原有带认证代理 URL 或本地 sub2api key。执行生产覆盖时，仍需通过 `--rules` 传入目标专用的私有规则，保留完整代理凭据、本地 API 地址和本地 key；不要把脱敏后的裸代理地址当作真实配置。策略文件也不会自动启用定期同步。

## 条件覆写规则

规则文件是 JSON 数组，字段名使用数据库的 **snake_case**。规则按数组顺序执行；后续条件读取前面已改写的值。每条规则作用于 `tables` 列出的表；省略 `when` 表示无条件覆写。

```json
[
  {
    "tables": ["providers", "provider_endpoints"],
    "when": {
      "field": "url.host",
      "op": "eq",
      "value": "api.old.example:8443"
    },
    "set": {
      "url.host": "api.new.example:9443"
    }
  },
  {
    "tables": ["providers"],
    "when": {
      "field": "url.host",
      "op": "not_like",
      "value": "internal.example%"
    },
    "set": {
      "proxy_url": "socks5://127.0.0.1:1080",
      "proxy_fallback_to_direct": false
    }
  }
]
```

第一条规则同时修改供应商 API URL 和端点池 URL，避免转发仍命中旧端点。第二条规则为不匹配 `internal.example%` 的供应商设置代理。

- `eq` / `ne`：严格值比较，区分字符串、数字、布尔值；适合 host、名称、供应商类型、启用状态等标量字段。
- `like` / `not_like`：大小写敏感的 SQL 风格通配匹配；`%` 匹配任意数量字符，`_` 匹配一个字符，其余字符按字面匹配。没有 SQL 的反斜杠转义语法。NULL、缺失字段和非字符串字段均不匹配这两种操作符。
- `url.host`：虚拟字段，对应 URL 的 `hostname[:port]`，含非默认端口。覆写值必须是规范化的 `hostname[:port]`（IPv6 如 `[::1]:9000`），不能包含协议、路径、query 或认证信息。保留原协议、路径、query、fragment、认证信息；新 host 不含端口时移除原端口。默认端口按 URL 标准省略。
- `set` 可设置任意已有且非受保护的数据库配置字段；值可以是字符串、数字、布尔值、对象、数组或 `null`。
- 点路径可覆写 JSON 内部字段，例如 `price_data.input_cost_per_token` 或 `custom_headers.X-Region`。未涉及的 JSON 字段保留；NULL JSON 对象按需创建。直接设置根字段则替换整个值。
- ID、vendor 外键、创建/更新时间、软删除标记、额度重置时间及测活状态不能用于规则；未知字段或对非 JSON 字段的点路径会拒绝执行。

例如，将某种供应商的代理清空并修改模型价格：

```json
[
  {
    "tables": ["providers"],
    "when": { "field": "provider_type", "op": "eq", "value": "codex" },
    "set": { "proxy_url": null }
  },
  {
    "tables": ["model_prices"],
    "when": { "field": "model_name", "op": "eq", "value": "gpt-model" },
    "set": { "price_data.input_cost_per_token": 0.000001 }
  }
]
```

该价格规则作用于该模型的每条价格记录，而不是仅修改最新记录。

## 验证

纯规则单元测试，无需数据库：

```bash
bunx vitest run --config tests/configs/cch-config-sync.config.mts tests/unit/cch-config-sync.test.ts --configLoader bundle
```

完整 PostgreSQL 回归与覆盖率检查：

```bash
CCH_CONFIG_SYNC_TEST_DSN='postgresql://test_user:password@127.0.0.1:5432/cch_config_test' \
  bunx vitest run --config tests/configs/cch-config-sync.config.mts --coverage --configLoader bundle
```

测试入口 DSN 的数据库名必须含 `test`，测试账户须有 `CREATEDB` 权限。测试自行创建并删除两份独立数据库，不清空入口数据库。覆盖率阈值为 80%；未配置该 DSN 时数据库测试跳过。

## cch1 对等同步

`syncer/` 是独立的 Go 程序，供 cch（`100.64.1.38`）和 cch1（`100.64.1.57`）定期同步。源程序只读取本机 CCH 数据库，把一份规范 JSON 快照以 zstd 放在 `100.64.1.38:23180`；目标程序不连接源数据库，每 60 秒拉取一次，摘要未变时不解码配置行，只有期望配置变化时才写入目标数据库。

目标沿用 `scripts/sync-cch1-policy.json`：`cc官key` 和 `openai 官key` 及其 vendor、端点池保持原 ID 和全部字段；其他同步供应商最终强制 `proxy_fallback_to_direct=false`。外部供应商的 `proxy_url` 使用目标现有唯一完整代理，本地 `127.0.0.1:52841` 供应商使用目标现有唯一 sub2api key 且不走代理。这两个值由目标程序从现有行发现，不写入仓库。

已匹配的供应商按 `name + provider_type` 原地更新，因此重复同步不会更换 ID，也不会重置目标累计额度锚点或端点测活快照。源端消失的非白名单供应商和端点才软删除。提交后向目标 Redis 发布 provider、endpoint、group 和 model-price 缓存失效消息，不重启 CCH。用户、密钥、用量、系统设置和请求过滤器不在同步范围内。

源或目标不可达、schema 不一致、白名单缺失、本地 key 或代理不唯一时，本轮不写数据库，下一分钟再检查。部署单元在 `syncer/deploy/`。
