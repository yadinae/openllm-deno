# P0：签名目录同步 + auto 只路由有免费性证据的模型

## 背景
- 移植版 `auto` 原来抓 provider `/models` 整表（893 条），**0 条有价格**，531 条无任何免费性证据却被当免费（`nvidia 81 个免费`、`electronhub 631 个免费`）。
- 原版 FreeLLMAPI 目录来自 **签名目录**（`https://api.freellmapi.co/v1/latest`），上游已策展好免费档，**目录本身就是免费性保证**，无需再造判定算法。
- 2026-10-20 实测：目录端点**匿名可达**，返回 395 条模型（33 平台），**无 signature 字段**，无需 Ed25519 验签。

## 实施

### 1. 数据库
- `models` 表加 `in_catalog INTEGER NOT NULL DEFAULT 0` + `idx_models_in_catalog` 索引

### 2. 同步服务 (`services/catalog-sync.ts`)
- `fetchSignedCatalog()`：30s 超时拉取 `https://api.freellmapi.co/v1/latest`
- `syncSignedCatalog()`：
  - upsert 395 条模型到 `models` 表，设 `in_catalog=1`，保留 `enabled`（运营者选择优先）
  - 目录缺席的 `in_catalog=1` 行退为 `0`（自动退役，防止过期模型继续被 auto 路由）
  - 记录 `catalog_version`、`catalog_synced_at`、`catalog_sync_error` 到 settings
- 兼容层：保留 `routes/premium.ts` 依赖的旧导出（`syncCatalog`、`getSyncState` 等），读写同一 settings 键

### 3. 调度
- `main.ts`：`Deno.cron("catalog-sync", "30 4 * * *")` 每天 04:30 UTC（配额重置后）
- 启动 15s 后首次同步（不阻塞冷启动）

### 4. 手动端点 (`routes/dashboard.ts`)
- `POST /api/catalog/sync`：手动触发
- `GET /api/catalog/sync/status`：查看版本/时间/错误

### 5. 路由闸门 (`services/router.ts`)
- `loadRoutableModels()` 查询加 `AND in_catalog = 1`
- 只有某平台 catalog 为空时，才回退到名称标记/运行时检测的免费判定
- 文档注释明确：`in_catalog` 是**唯一** free-tier 证据来源

## 验证结果

### 同步
```
POST /api/catalog/sync → ok: true, version=2026.10.19.35633f, upserted=395, retired=0
GET /api/catalog/sync/status → { version: "2026.10.19.35633f", syncedAt: "2026-10-20T05:45:41.139Z" }
```

### auto 路由（6/6 命中目录内免费模型）
```
model=openai/gpt-oss-120b  free=True  (6 次全部命中，模型在 signed catalog 内)
reason: bandit-top1 FREE (latency:403ms cost:$0.001/1k quality:0.89 reliability:1)
```

### 显式请求仍可用（绕过 catalog 闸门）
```
model=nvidia/01-ai/yi-large → "Authorization failed"  (真实上游错误，非 unknown error)
```

### 线上指标
- 目录模型：395（33 平台，全部 free-tier）
- 移植版原目录：893（531 条无证据）→ **auto 候选从 893 降到 395，假阳性清零**
- 测试基线：59 passed / 41 failed（与修改前一致，全部为本地无 DB 的环境性失败）

## 部署
- Revision: `74fanfcn98ym` (production: https://openllm.yadinae.deno.net)
- Cron 自动每天 04:30 UTC；管理员也可随时 POST `/api/catalog/sync`

## 关键设计决策
1. **不搬 Ed25519 验签**：当前 monthly tier 无 signature 字段，验签逻辑死代码
2. **不再造免费判定算法**：上游目录已是权威证据，目录成员即免费，重复造轮子只会再制造冲突判据
3. **显式请求放行**：catalog 只管 `auto`/`fusion`；用户指名道姓的模型仍走原逻辑，返回真实上游错误
4. **退役机制**：目录缺席的模型自动 `in_catalog=0`，防止过期/下架模型继续被路由
5. **兼容层分离**：premium.ts 的 license 逻辑不动，只读写同名 settings 键，避免破坏现有付费流程

## 后续可选
- 增量同步（`since` 参数，目录支持 304）
- embedding/transcription/search/decision 模型同步（目录已提供，当前只同步 chat models）
- `/api/models` 响应加 `in_catalog` 字段供前端展示