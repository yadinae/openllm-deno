# 部署 warming 阶段 boot_failed —— gitignore 排产与远端 schema 漂移

## 问题

本地 `deno check` 通过、`deno deploy` 构建成功（artifact 356 kB），但 revision 在
`warming` 阶段 `failed`，`failure_detail` 为
`{stage:"warmup", code:"boot_failed", message:"The application failed to start."}`，
线上日志端点读不到（`ddp_` token 只能部署，调 `api.deno.com/api/v2/...` 一律
`invalidToken`）。需要定位启动失败原因并把线上恢复到 healthy。

## 权衡

1. **读远端启动日志**：`/api/v2/apps/{app}/logs` 需要 `start`（string）参数，且走
   console 认证，`ddp_` 部署 token 401 / `invalidToken`。放弃，改本地复现。
2. **猜启动点**：`main.ts` 顶层有 `await loadDb("db/data.json")`、`Deno.cron`、
   `Deno.serve({ port, hostname })`。逐项怀疑无法收敛，需证据。
3. **查 deploy CLI 的收集逻辑**：读缓存的 deploy 子命令源码（`~/.cache/deno/remote/
   https/jsr.io/*`）发现 collector 配置项
   `ignore_git_folder=true, use_gitignore=true` —— 即部署**尊重 `.gitignore`**。
   本仓 `.gitignore` 含 `db/data.json`、`dist/`，因此 `db/data.json`（556K）与
   `dist/`（8.2M）**不会上传**；本地“源码（去掉 dist/data.json）328K”与 artifact
   356 kB 吻合，交叉验证成立。→ 顶层 `loadDb` 在 Deploy 上 ENOENT → 启动即崩。
4. **修法选择**：
   - 改 `.gitignore` 用 `!` 反选 → 会把含密钥的 `db/data.json` 纳入 git 跟踪，泄露风险，否决。
   - `--ignore` 只能追加忽略，不能反选，否决。
   - **从无 `.gitignore` 的暂存目录部署**（复制 `main.ts deno.json deno.lock db/ routes/
     services/ providers/ shared/ dist/`，排除 `.git`/`.env`/`*.bak`/`dist.bak-*`），
     不动仓库、不提交密钥。采纳。

## 结论

- 用暂存目录 `/tmp/opencode/deploy`（无 `.gitignore`）执行
  `deno deploy . --org yadinae --app openllm --prod --non-interactive --token <ddp_...>`
  → revision 首次 `routed`，warmup 通过。
- 随后线上 `/api/health` 由 `unhealthy` 变 `healthy`；但首轮报
  `column "id" referenced in foreign key constraint does not exist`。加语句级错误上下文
  （`schema statement failed [<前 90 字符>]: <msg>`）后定位到 `api_key_proxy` 的
  `REFERENCES api_keys(id)`：远端 Prisma Postgres **已存在**旧 schema 的 `api_keys`
  表（无 `id` 列，`platform` 为主键），`CREATE TABLE IF NOT EXISTS` 静默跳过，故 FK 失败。
- 修法：删除 `db/pg.ts` 中全部 9 处 `REFERENCES ...`（应用层保证一致性，本应用不需要
  DB 级外键）。重部署后 `deno check` 0 error。
- **验证（线上实测，非仅看部署 status）**：`routes/api.ts` 全部 37 个静态 GET + `/health`、
  `/v1/models`、`/api/premium`、`/` 共 41 个端点全 200。
  `/api/health/detailed` → `database:"connected"`、`api_keys=11 models=1 settings=4`；
  `/api/keys` 返回 11 个平台（custom/google/groq/kilo/nvidia/opencode/openrouter/radeon/
  test/verify/zhipu）；`/v1/models` 378 条；`/api/settings/stats {"count":4}`。
- 路由中的 revision：`2ky2qr2tw7qs`（2026-10-18T04:20:32Z，最新）、`30k2ec1nzyjn`、
  `3d1dd1zparyd`；失败的是 `325t14eec89z`、`eqx1v4sxrgct`（均为 warming/boot_failed）。
- **遗留风险**：
  1. `db/data.json` 与 `dist/` 只能靠暂存目录带上；直接 `deno deploy .` 仍会 boot 失败。
     后续应把可复现的部署脚本/清单固化（或让 `loadDb` 在文件缺失时降级为 no-op 并让
     PG 成为唯一真源），否则易复发。
  2. 远端 `api_keys`/`models` 等表是旧 schema 残留，与本次 DDL 不一致（如 `api_keys`
     无 `id`）；`models` 仅 1 行、`/api/models/free` 为 0，因为 `models` 由 discovery
     **cron** 写入而非启动时 seed，属预期，非本次回归。
  3. 部署前未做 `deno fmt` 全量（仓库历史格式）；`deno lint` 33 条 `require-await` 未清。
