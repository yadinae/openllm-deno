# Dashboard 剩余端点 + /api 会话网关 + 键 CRUD 契约修正

## 问题

前端登录后各页面能开，但 Analytics / Backups / Cache / Compression / Conversations /
Profiles / Update 以及大量 `settings/*` 配置页调用后端时 404——端口从未实现这些端点。
另有键管理（增删改、reveal、自定义端点导入）与后端契约不一致，且 `/api/*` 全部公开
（`reveal` 与 `settings/api-key` 会泄漏明文密钥）。

## 权衡

- **补齐方式**：逐个逆向 minified bundle 还原 40+ 个响应形状 vs. 先返回"良构空值 +
  通用字段"，再按真实 UI 报错迭代。选后者：无请求历史，空 analytics 是事实而非 stub；
  形状从 bundle 已确认（timeline/by-* 是数组，requests 是 `{rows}`，summary 是对象，
  backups `{backup:{filename}}`，import-selected `{imported,errors[]}`）。
- **配置持久化**：无状态回显 vs. 写入 `settings` 表。选持久化，让开关跨刷新生效。
- **鉴权**：不做（保持原样）vs. 给 `/api/*` 加会话网关。选加网关：SPA 每个 `/api`
  调用都带 `Authorization: Bearer <session_token>`（见 bundle `Wg='freellmapi_dashboard_token'`），
  登录前只打 `/api/auth/*`，因此网关不破坏登录流程却能挡住密钥泄漏。
- **键 id 语义**：SPA 用 GET `/api/keys` 返回的 1-based 序号做 `PATCH/DELETE/reveal`
  的路径参数；后端原本按 `platform` 处理。选"服务端统一按 `localeCompare(platform)`
  排序生成序号，并在 PATCH/DELETE/reveal 中把序号解析回 platform"，保持自洽。

## 结论（均已线上验证）

- 新增 `routes/dashboard.ts`（约 40 个端点），`main.ts` 在 `apiCompat` 之后挂载
  `app.route("/api", dashboardRouter)`；配置类落 `settings`，键类走 `saveApiKey`+`saveModels`。
- 键 CRUD：`POST/PUT/PATCH/DELETE /api/keys[/:id]` 统一支持 SPA 的驼峰字段
  （`key/keyValue/apiKey`、`baseUrl`）并用 `encryptKey` 加密入库（此前明文直存且 `{}` 会 500）；
  新增 `POST /api/keys/:id/reveal` 返回明文；`/keys/custom`、`/keys/discovered-models`、
  `/keys/import-selected` 真正落库。
- 修正危险 bug：GET `/api/keys` 原用 SQL `ORDER BY platform`，而 `idOf/resolvePlatform`
  用 JS `localeCompare`，两者排序不一致 → SPA 传回的序号可能指向**另一个**键（删错键）。
  现 GET 也按 `localeCompare` 排序，序号全链路自洽。
- `/api/*` 会话网关（`main.ts`）：放行 `/api/auth/*` 与 `/api/health`，其余要求
  `Bearer` 等于 `settings.session_token`，否则 401 `{error:{type:"authentication_error"}}`。
- 线上验证：`deno check` 0 error；部署 revision `f8y40hc1826n` routed；未带 token
  `/api/keys`、`/api/settings/api-key` → 401；带 token 全 200；`/v1/models` 仍 378，
  `/api/keys` 11 条；本地用真实 Postgres 跑通 POST→GET id 一致→reveal 回原文→定向删除。
- 排查插曲：连续多次 curl 登录取 token 会出现间歇 401——`rotateSession()` 每次登录都换
  token 且只存一个会话，多次登录互相踢下线（也可能踢掉浏览器会话）。属设计行为，非 bug。

## 遗留

- 端点多为"良构空值"，Analytics 尚无请求历史（未接入请求日志落库），页面展示为空属预期。
- `settings/proxy` 不回显 `relayToken`，仅置 `relayTokenConfigured`。
- 单会话模型：同一时刻仅一个有效 token，多设备登录会互相注销。
