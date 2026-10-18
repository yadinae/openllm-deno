# 用无头浏览器逐页验证 SPA：端点"200 但形状不对"是主要故障源

## 问题

上一轮把缺失端点补齐后，curl 探测所有路径都 200，但"200"≠"页面能渲染"。
需要确认每个页面真的打开不崩。用 Playwright + 真实 Postgres 起本地服务，
注入 `freellmapi_dashboard_token` 后逐路由加载，捕获 console/pageerror/4xx，
并 hook `window.fetch` 记录每个 `/api` 响应的**形状指纹**（array(n) / obj{keys}）。

## 权衡

- 静态读 minified bundle 推字段 vs. 真浏览器跑一遍。选浏览器：能一次性给出
  "哪个页面崩、崩在哪、它刚才调了哪些接口、各接口返回什么类型"。
- 空数据 vs. 合成数据。仍选"良构空值/默认值"，因为未接请求日志，空是事实。
- 需要真 Postgres 才能过会话网关；用 docker `postgres:16-alpine` + `DATABASE_URL`。

## 结论（均已本地 + 线上验证）

无头浏览器暴露出一类**已存在端点的形状 bug**（都返回 200，但类型/字段与 SPA 不符导致页面崩溃）：

| 端点 | 原返回 | SPA 期望 | 后果 |
|---|---|---|---|
| GET `/api/fallback` | `{enabled,fallbackMode,config}` | **数组** `[{modelDbId,platform,keyCount,enabled,...}]` | `/`、`/models/chat`、`/models/fusion`、`/playground`、`/test`、`/fallback` 崩 `P.filter` |
| GET `/api/keys/providers` | 字符串数组 | `{providers:[{...,configured}], summary:{configured,total}}` | `/keys` 崩 `i.providers.length` |
| GET `/api/search/engines` | `{engines:[]}` | **数组** | `/models/search`、`/playground`、`/test` 崩 `n.slice` |
| GET `/api/embeddings/usage` | `{usage:0}` | `{families:[],totalTokensMonth,totalRequestsToday}` | `/models/embeddings` 崩 `c.families.length` |
| GET `/api/media/usage` | `{byModality:{...}}` | `{models:[],totalRequestsMonth,totalRequestsToday}` | `/models/image|video|audio` 崩 `a.models.length` |
| GET `/api/fallback/routing` | `{strategies,activeStrategy,candidates}` | `{strategy,keySelectionStrategy,scores:[]}` | 字段缺失（不崩，但策略读不到） |
| GET `/api/fallback/{token,rate-limit}-usage` | `{usage}` | `{rows:[]}` | 用量恒空 |
| GET `/api/settings/fusion` | data.json 里是**扁平** `{mode,models,judge,k,strategy,expose_panel}` | `{config:{...}, maxK}` | `/models/fusion` 崩 `n.config.judge` |

- 关键坑：`data.json` 迁移进 PG 的 settings 是**旧后端形状**（`fusion_config` 扁平、
  `enable_mcp:"0"`、`update_check_enabled:"1"`、`compression` 是 JSON 字符串）。
  新写的 dashboard 默认值被"已存在的错误形状"覆盖。修法：GET 时归一化
  （`parseMaybeJson` + 包裹成 SPA 形状 + `truthy()` 解析 "0"/"1"）。
- 同时补：`PATCH /api/search/engines/:id`、`/analytics/search` 增加 `today`、
  `/profiles/active` 兼容 `active_profile_id`、PUT `/fallback`/`/fallback/routing`
  与 GET 用同一 settings key。
- 验证结果：本地与线上 **17/17 路由 clean**（`/`、`/models/{chat,embeddings,image,video,audio,search,fusion}`、
  `/playground`、`/keys`、`/agents`、`/analytics`、`/premium`、`/logs`、`/fallback`、`/health`、`/test`）；
  Settings 弹窗四个 tab 无 console 错误；"Check for updates"、"Save compression"（PUT 200）正常；
  线上未带 token `/api/keys`、`/api/fallback`→401，`/v1/models` 仍 378、keys 11。
- 部署 revision `5eyjm0vvpq5d`。

## 遗留

- Analytics/用量类仍为空数据（未接请求日志落库），页面显示空态属预期。
- 设置项只走了 Settings 弹窗暴露的 compression 页；proxy/url-tokens/agent-compat/
  anthropic-map/gemini-map/min-reliability-floor 等 GET/PUT 已按形状实现但未在 UI 点击验证。
- 单会话 token：登录会注销其它设备（含浏览器）会话。
