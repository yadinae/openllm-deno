# 登录始终 "Invalid email or password"：Deno 端自造单管理员凭据，与 FreeLLMAPI 的 users/scrypt 账本不兼容

## 问题

线上 `openllm.yadinae.deno.net` 前端输入确认正确的密码，始终返回
`{error:{type:"authentication_error",message:"Invalid email or password"}}`。
`GET /api/auth/status` → `{needsSetup:false,authenticated:false,email:"admin@openllm.local"}`。

对照原版 FreeLLMAPI（本机 systemd 服务，`freellmapi.service`，监听 :3001）：
- 它的账号存在 SQLite `users` 表，**scrypt** 哈希，按 email 索引
  （`freellmapi/server/src/lib/password.ts`，格式 `scrypt$<saltHex>$<hashHex>`，
  N=16384,r=8,p=1,64B；`services/auth.ts` 用 `users` + `sessions`）。
- 本机库里账号是 `yadinae@gmail.com`（`SELECT id,email FROM users`）。

而 Deno 移植版把 dashboard 认证另起炉灶：单管理员、**PBKDF2-210000**、凭据存
`settings` 表的 `admin_password_hash`/`admin_email`，且 `routes/auth.ts:login`
**完全忽略请求里的 email**，只比对单条 settings 哈希。所以用原版账号密码（或任何
email）去登录，都比对到 `admin@openllm.local` 的那条哈希 → 必然 401。
`db/pg.ts` 里其实早就建了 `users`/`sessions` 表，但从未被使用。

## 权衡

- **只重置线上密码**：能进，但认证仍是两套割裂实现，原版账号永远进不来；且
  `forgot-password` 的重置码只打 Deno 日志，ddp token 读不到（见旧笔记），恢复极难。否决。
- **保留 PBKDF2 单管理员，额外加 scrypt 兼容分支**：要同时维护两套哈希与两套会话，
  复杂度高且 `needsSetup` 语义混乱。否决。
- **改用 users/scrypt，与上游逐字节对齐**：登录真正按 email 查表、scrypt 校验，
  会话存 `sessions`（SHA-256(token)）。账号可在原版与移植版之间互通。采纳。

关键约束验证：Deno 的 `node:crypto.scryptSync` 与 Node 的默认参数一致，
交叉验证 Node 生成哈希 → Deno 验证通过，且 Deno 生成 → Node 也能验（本地实测）。
因此旧版 `users` 行可直接导入复用，无需重设密码。

## 结论

- 新增 `services/auth.ts`：scrypt `hashPassword`/`verifyPassword`（与上游同参）、
  `normalizeEmail`、`newSessionToken`/`hashSessionToken`（sha256）、`SESSION_TTL_MS`(30d)。
- `db/pg.ts` 新增 users/sessions 访问层：`countUsers`/`getUserByEmail`/`getFirstUser`/
  `createUser`/`updateUserPassword`/`updateUserEmail`/`createSession`/`getSessionUser`/
  `deleteSession`/`deleteUserSessions`。
- 重写 `routes/auth.ts`：`needsSetup = userCount()===0`；`/setup`(需 setup code，
  可用 `SETUP_CODE` 环境变量覆盖)、`/login`(email+scrypt)、`/logout`、`/me`、
  `/change-password`、`/change-email`（唯一约束→409）、`/forgot-password`(重置码→日志)、
  `/reset-password`（签发新会话并注销旧会话）。错误体沿用 `{error:{type,message}}`，
  成功体同时带 `ok` 与 `success`，兼容 SPA 两种读法。加了每 email 5 次/15 分钟锁定。
- `main.ts` 的 `/api/*` 会话网关改为查 `sessions` 表（原为 settings `session_token`）。
- `routes/api.ts` 的旧 `/api/settings/{authenticated,login,logout,set-password}` 改为委托到
  同一 users/sessions 存储，保留兼容。
- **schema 修复**：`sessions.expires_at_ms` 等 ms 时间戳列原为 Postgres `INTEGER`(32 位)，
  写 ~1.79e12 直接 `22003 out of range`（setup 因此 500）。DDL 改 `BIGINT`，并加
  `MIGRATIONS` 幂等 `ALTER ... TYPE BIGINT`（`CREATE TABLE IF NOT EXISTS` 不会改已存在列），
  覆盖 `rate_limit_usage`/`rate_limit_cooldowns`/`sessions`/`quirks`/`playground_conversations`/`server_logs`。

**验证**（docker `postgres:16-alpine` @127.0.0.1:55432，本地 `deno run` SETUP_CODE=TESTCODE）：

- `deno check main.ts` 通过；新文件 `deno lint` 零告警。
- 交叉哈希：Node `scryptSync` 生成的 `scrypt$...` 在 Deno 端 `verifyPassword` →
  `DENO_VERIFY_NODE=true`；Deno 生成自验 true、错密码 false。
- 全流程 curl：status(needsSetup=true) → setup 无码 403 `setup_code_required` →
  带码 setup **201 且立即 login 200** → login 错密码 401 → me 200 →
  会话网关 `/api/keys` 带 token 200 / 无 token 401 → change-password 200 →
  新密码登录 200 → change-email 200（登录新 email 200）→ logout 200 → me 401 →
  forgot-password 200（日志出码）→ reset-password 得新 token（错码 403）→ 新密码登录 200。
- 兼容性铁证：把本机 SQLite 的账号（email + Node-scrypt 哈希）直接 INSERT 进 Postgres
  `users`，用其明文密码登录 → **200**；错密码 401。即旧 FreeLLMAPI 密码可在移植版使用。

**部署后线上行为**：`users` 表为空 → `/api/auth/status` `needsSetup:true` → SPA 弹
setup 屏；用 `SETUP_CODE`（或 Deno Deploy 日志里的码）建号即可登录。旧的
`admin_email`/`admin_password_hash` settings 保留但已不参与认证，并已列入
`SENSITIVE_SETTINGS` 不再经 `/api/settings` 泄漏。

**遗留/风险**：
- 我无法从本机读取线上 Postgres，未做真实线上验证；需 `deno task deploy` 后人工确认。
- 若想沿用原账号 `yadinae@gmail.com`，可在 setup 时填同一 email + 原密码（等价重建），
  或将 SQLite `users` 行导入 Postgres `users`（字段：email、password_hash）。
- 单账号模型：setup 只在 `users` 为空时可用；多账号/多用户仍未接入 SPA。
