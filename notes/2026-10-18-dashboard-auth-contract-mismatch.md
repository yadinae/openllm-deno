# 前端“无法连接到服务器”：SPA 走 /api/auth/*，后端却实现了 /api/settings/*

## 问题

线上 SPA 打开后提示「无法连接到服务器。请确认后端正在运行（npm run dev）」，即使
`/api/health`、`/api/keys` 等都 200。定位：SPA 的整棵 UI 包在一个网关组件里，首帧就
`GET /api/auth/status`，失败（404 → `isError`）即渲染该报错。后端把认证实现在
`/api/settings/{login,logout,authenticated,set-password}`，而 SPA（及 `port/endpoints.json`
记录的原始 Node 后端契约）用的是 `/api/auth/*`。二者完全不匹配 → 前端永远进不去。

从打包产物 `dist/assets/index-*.js` 还原出的契约（错误体为 `{error:{type,message}}`，
抛出的 Error 带 `.code=type`、`.status`）：

- `GET  /api/auth/status` → `{ needsSetup, authenticated, email }`
- `POST /api/auth/setup`  ← `{email,password,setupCode?}` → `{token}`；错误 `type=setup_code_required`
- `POST /api/auth/login`  ← `{email,password}` → `{token}`
- `POST /api/auth/logout` → `{ok}`
- `GET  /api/auth/me` → `{email}`
- `POST /api/auth/change-password` ← `{currentPassword,newPassword}`
- `POST /api/auth/change-email`    ← `{currentPassword,newEmail}`
- `POST /api/auth/forgot-password` → `{ok}`（重置码打日志）
- `POST /api/auth/reset-password`  ← `{resetCode,newPassword}` → `{token}`

token 经 `Authorization: Bearer` 传递，存 `localStorage['freellmapi_dashboard_token']`；
base URL 为同源 `/`。

## 权衡

- **只加 `/auth/status` 桩**：能过网关，但 setup/login 仍 404，用户还是进不去。否决。
- **把 SPA 改回 `/settings/*`**：`dist/` 是构建产物，没有前端源码，改不了。否决。
- **完整实现 `/api/auth/*`**：复用现有 PBKDF2（210000 轮 SHA-256）与 session token；
  新增 `routes/auth.ts` 挂到 `/api/auth`。采纳。
- **`needsSetup` 的定义**：原实现只看“有没有密码”。但 SPA 的 setup 表单要 email+password，
  而线上从未存过 email（`admin_password_hash` 有、`admin_email` 无）。故定义
  `needsSetup = !(hash && email)` —— 对当前线上正好为 true，用户走 setup 屏幕重建凭据。
- **setup code（防公开抢占）**：沿用原始设计，生成一次性码并打日志；setup 时校验，
  不匹配返回 `type=setup_code_required`（SPA 据此展开输入框）。码存 `app_secrets`（`__setup_code`）
  并进程内缓存，重启存活、无 PG 也能用。
- **login 是否轮换 session**：轮换（每次登录签发新 token，旧 token 失效）。change-password
  不轮换，避免 SPA 未更新本地 token 被登出。

## 结论

新增 `routes/auth.ts`（9 个端点），`main.ts` 挂 `app.route("/api/auth", authRouter)` 并
在启动时 `ensureSetupCodeLogged()`。`/api/settings/*` 旧端点保留不动。

**验证**：

- 本地真实 Postgres 16（docker，`postgres://postgres:pass@127.0.0.1:55432/openllm`）跑完整流程：
  status(needsSetup=true) → setup 无码 400 `setup_code_required` → 带码得 token →
  status(needsSetup=false,authenticated=true) → login 200 / 错误密码 401 →
  me 200 → change-password 200（token 仍有效）→ 新密码登录 200 → change-email 200 →
  forgot-password 200（日志出重置码）→ reset-password 200 得新 token → 错码 400 → logout 200。
- 线上部署后：`GET /api/auth/status` → 200 `{needsSetup:true,authenticated:false,email:null}`；
  `POST /api/auth/setup` 无码 → 400 `setup_code_required`；`/api/auth/clients` 仍 200（未被覆盖）。
- 回归：`routes/api.ts` 的静态 GET 全 200；仅 `/api/auth/me` 未登录时 401（符合预期）。

**遗留（重要）**：SPA 还会调用约 35 个后端未实现的端点，会在对应页面报错（404 文本被
`X()` 抛成 `Error("Not Found")`）。清单：
`backups{,/schedule,/tables}`、`cache/stats`、`compression/{preview,stats}`、`conversations`、
`embeddings/custom`、`keys/{custom,custom/discover-models,custom/probe,discovered-models,import-selected,preview}`、
`premium/{key,portal,sync}`、`profiles{,/active}`、
`settings/{agent-compatibility,anthropic-map,api-key,api-key/regenerate,compression,enable-mcp,fusion,gemini-map,min-reliability-floor,proxy,proxy/test,unify,update-check,url-tokens,version}`、
`update/{apply,check,release}`。

**待办/风险**：线上 `needsSetup=true`，用户需要从 Deno Deploy 控制台日志里读 `[openllm] dashboard not set up — setup code: XXXXXXXX` 才能完成 setup；日志无法用 `ddp_` 部署 token 经 API 读取。
