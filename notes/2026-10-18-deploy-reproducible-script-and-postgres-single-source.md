# 可复现部署脚本 + Postgres 单一真源（loadDb 降级）

## 问题

上一篇（`2026-10-18-deploy-warmup-boot-failed-gitignore-and-schema-drift.md`）确认：
`deno deploy` 尊重 `.gitignore`，导致 `db/data.json`、`dist/` 不上传；顶层
`await loadDb("db/data.json")` 在 Deploy 上 ENOENT 直接 boot 失败。当时的即时绕过是
“从无 `.gitignore` 的暂存目录部署”。需要把两件事都落地：

1. **可复现的部署脚本/清单**，让裸 `deno deploy .` 不再能误用、密钥不出本机；
2. **`loadDb` 文件缺失时降级为 no-op**，让 Postgres 成为单一真源。

## 权衡

- **部署脚本**：改 `.gitignore` 用 `!` 反选会把含密钥的 `db/data.json` 纳入 git 跟踪
  （泄露），否决；`--ignore` 只能追加忽略，否决。选择**白名单暂存**：只拷
  `main.ts deno.json deno.lock db/ routes/ services/ providers/ shared/ dist/`，
  跳过 `.env/.git/node_modules/*.bak/*.log`。暂存目录无 `.gitignore`，`deno deploy` 全量上传。
- **降级**：`loadDb` 捕获异常后置 `_data = emptyDb()`、`_encKey = null`，并让 `getDb()`
  在未加载时惰性返回空骨架（不再 throw，避免 middleware 把 `/health` 变 500）。
- **加密密钥存哪**：`settings` 表被公开的 `GET /api/settings` 原样返回，存这里等于泄露。
  经查该端点本就泄露 `admin_password_hash`/`admin_password_salt`/`session_token`
  （无鉴权即可读）。故**新建 `app_secrets` 表**放 `__encryption_key`，与 `settings` 隔离。
- **catalog 归属**：`/v1/models` 的 378 条来自 **setting `catalog_applied_json`**（515KB 字符串），
  它只在 `data.json` 里，PG 没有；若只做文件降级，no-seed 部署会让 `/v1/models` 从 378 掉到 1。
  因此必须把 setting 也迁进 PG，并在启动时把 PG settings 镜像回 `getDb().settings`
  （`routes/models.ts` 读的是内存 `db.settings`）。
- **顺带修泄露**：迁移会把 `unified_api_key`（代码里根本没被读过的真实密钥）也搬进 PG，
  于是必须给 `GET /api/settings` 与 `/settings/stats` 加脱敏白名单
  （`session_token`/`admin_password_hash`/`admin_password_salt`/`unified_api_key`/`__*`）。

## 结论

实现：

- `db/mod.ts`：`loadDb` 失败降级为空骨架并记日志；新增 `emptyDb()`、`setEncryptionKey()`、
  `hasEncryptionKey()`；`getDb()` 惰性兜底。
- `db/pg.ts`：新增 `app_secrets` 表与 `getSecret()/setSecret()`。（此前的去 FK 修改同文件。）
- `main.ts`：密钥来源优先级 **`app_secrets` → `data.json` → `ENCRYPTION_KEY` env**，命中即回写
  `app_secrets`；把 `data.json` 独有的 settings 增量迁入 PG，再把 PG settings 读回内存。
- `routes/api.ts`：`publicSettings()` 脱敏 `GET /settings` 与 `/settings/stats`；
  `/api/health/detailed` 增加 `encryptionKeyLoaded` 布尔诊断（非敏感）。
- `scripts/deploy.ts` + `deno.json` 的 `tasks.deploy`：`deno task deploy`，
  支持 `--no-seed`、`--preview`、`--dry-run`、`--org/--app/--token`，
  token 默认读 `DENO_DEPLOY_TOKEN`，日志里打码。

**验证（线上实测）**：

- `deno task deploy --dry-run`：默认 95 文件（含 `db/data.json`），`--no-seed` 94 文件
  （`db/data.json` excluded），`.env` 未入列。
- 部署 #1（带 seed，rev `a1k8abjvj1py`）→ `encryptionKeyLoaded:true`（密钥已写入 `app_secrets`）。
- 部署 #2（`--no-seed`，rev `j3haqtx92m4b`）→ 仍 `healthy`、`encryptionKeyLoaded:true`，
  证明密钥来自 PG。**但** `/v1/models` 从 378 掉到 1（catalog 只在 data.json）→ 促成 settings 迁移。
- 部署 #3（带 seed）→ PG `settings` 从 4 增至 22，`/v1/models` 恢复 378。
- 部署 #4（`--no-seed`，rev `yqtasf1pem82`，最新路由）→ `healthy`、`settings=22`、
  `api_keys=11`、`encryptionKeyLoaded:true`、`/v1/models=378`、`/api/keys=11`、
  `GET /api/settings` 敏感键泄露数 = 0；`routes/api.ts` 全部静态 GET + `/health`/`/api/premium`/`/`
  共 40 个端点全 200。
- 本地 file-mode（`mv db/data.json` 后 `PORT=8848 deno run …`）→ 启动正常、`/health` 200、
  `/api/health` 200（空 platform 列表），降级路径成立。

**关键事实/遗留风险**：

- 以后可直接 `deno task deploy --no-seed`：不携带 `db/data.json` 也能跑，PG 为真源。
  默认仍带 seed（便于全新库引导）。
- `db/pg.ts` 已无任何 `REFERENCES`（FK），应用层保证一致性（见上一篇原因）。
- 仍存在的**未修**问题：`session_token`/`admin_password_hash` 虽已从 `/api/settings` 脱敏，
  但登录相关端点的鉴权强度、以及其它可能的公开读写面未在本次审计范围。
