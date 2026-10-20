# /agents 页面 "i.filter is not a function"：analytics 端点返回了包裹对象

## 问题

线上打开「智能体」页面白屏报错 `i.filter is not a function`。

压缩后的 `i` 是 `AgentsPage.tsx` 里 `useQuery<ClientAnalytics[]>` 拿到的
`/api/analytics/by-client?range=30d` 响应，页面直接 `byClient.filter(...)`。

真正的形状错配在后端：`main.ts:186` 把 `routes/analytics.ts` 挂在 `/api/analytics`
（**早于** `/api`，Hono 先匹配先生效，因此遮蔽了 `routes/dashboard.ts` 里同路径的
stub），而这份 analytics 实现返回的是 `{ data: rows, range: {...} }` 包裹对象 ——
对象没有 `.filter`，页面直接崩。

不是孤例：该文件 **11 个端点全都是** `{data, range}` 信封 + snake_case 字段，
AnalyticsPage 读取的 9 个端点（by-model/by-platform/by-client/by-key/timeline/
errors 期望**裸数组**；summary/error-distribution/requests/search 期望对象）
字段名也对不上（后端 `total_requests` vs SPA `totalRequests`）。

另外 `requests` 表**根本没有 client_agent / client_ip / request_type 列**，
`chat.ts` 传 `client_id: undefined` —— 智能体维度此前无任何数据来源，页面即使不崩
也是空的。

## 权衡

- **只把 by-client 改成数组**：一处修复，但同类 bug 会逐个页面继续爆（用户此前
  明确批评过"表面化"）。否决。
- **删掉 analyticsRouter 挂载，退回 dashboard.ts 的 stub**：页面立刻不崩，但那些
  stub 自身也不合契约（`inputTokens` vs `totalInputTokens`、`buckets` vs
  `byCategory`），且永远空数据 —— 等于用另一个 bug 盖住这个 bug。否决。
- **把 analytics.ts 重写成契约层 + 补齐 caller 识别链路**：一次覆盖 11 个端点，
  并让智能体归因有真实数据。采纳。

关键约束：SPA 是既成契约，FreeLLMAPI `server/src/routes/analytics.ts` 是权威实现，
逐端点比对后再改，不猜字段。

## 结论

- **`services/client-classifier.ts`（新）**：移植 FreeLLMAPI `lib/client-classifier`
  的 26 值粗粒度枚举。做成纯函数（输入 `{path, userAgent, x-claude-code-session-id,
  x-session-id}`），26 条规则不依赖 Hono 上下文即可单测。
- **`main.ts`**：新增全局 middleware 调 `setClientMeta()`，**必须挂在所有 `/v1`
  router 之前**（line 156 < 192），否则请求日志读不到。所有客户端共用统一网关
  key，UA 与转发 IP 是唯一的 per-caller 信号。
- **`services/request-log.ts`**：用 `AsyncLocalStorage` 承载 caller 身份 —— 刻意
  **不改 10 处 `logComplete()` 位置参数签名**，零调用点改动。streaming 尾部若脱离
  异步链则退化到 `unknown`（降级标签，不产生错误标签）。
  INSERT 的 ON CONFLICT 对 5 个新列用 `COALESCE(EXCLUDED.x, requests.x)`，
  避免 response 阶段把 request 阶段已写入的元数据擦成 NULL。
- **`db/pg.ts`**：`requests` 增 5 列（client_agent/client_ip/client_user_agent/
  request_type/requested_model）+ `idx_requests_client_agent`，CREATE TABLE 与
  MIGRATIONS 同步。
- **`routes/analytics.ts`（重写 447 行）**：6 个数组端点返回**裸数组**，
  4 个对象端点返回契约字段名的对象。数组端点 DB 出错时返回 `[]` 而非错误对象 ——
  保证页面永不因后端故障白屏。

### 踩坑（差点把整站搞挂）

`db/pg.ts` 用 `SCHEMA_SQL.split(";")` 切分 DDL。我在 CREATE TABLE 里加的 SQL 注释
`-- ... client_agent; ip + raw UA ...` **注释里带了分号**，DDL 被从注释中间截断，
部署后 `/api/health` 直接 503：
`schema statement failed [CREATE TABLE IF NOT EXISTS requests ...]: syntax error at end of input`。

→ **DDL 字符串里任何位置（含注释）都不能出现分号。** 修法：注释改用逗号/句号重写。

## 验证

- `deno check main.ts` 通过。
- 新增 `tests/analytics-contract.test.ts`：以 `DATABASE_URL` 未设置启动 analyticsRouter
  （initDb 必抛，走 catch 路径），断言 6 个数组端点返回**真数组**、4 个对象端点返回
  对象。**该测试在旧代码上会失败**（stash 回退验证：旧代码 42 failed，修复后 41
  failed，差的就是这一条），是这次回归的永久守卫。
- 新增 `tests/client-classifier.test.ts`：4 组用例覆盖 header 信号优先、UA 优先于
  wire-format 回退（qwen-code 走 Gemini wire、openai SDK 打 /v1/responses、mimo
  优先于 opencode）、自报家门（hermes-cli / pi-coding-agent / Reasonix）、以及
  /v1/messages 有无 x-session-id 的区分。
- 两次 `deno test`：新增 6 项全绿；其余失败项与 stash 基线完全一致
  （全部是 `DATABASE_URL not set` / 本地无 :9999 服务的环境性失败）。
- 部署 revision `8gw98ezsrf1`（首个 `5x63j71v1477` 因分号坑导致 503，已修）。
  线上 `/api/health` → `healthy`，12 platforms，schema 迁移成功（新列已建）。

## 遗留

- **未做带鉴权的线上端到端验证**：`/api/analytics/*` 全部过 session 网关，
  没有 dashboard 密码无法 curl 到真实响应体。数组/对象契约由单测覆盖，
  DB 往返与真实归因数据尚未经端到端确认。
- `ttfb_ms` 未插桩 → summary 返回 `null`（不是 0，UI 显示占位而非谎报瞬时首字）。
- `request_attempts` 表未迁移 → `/requests` 的 `attemptCount` 恒 0、
  `/requests/:id` 的 `attempts` 恒空数组，故障切换阶梯图暂时无数据。
- `estimatedCostSavings` / `estimatedCost` 返回 0：`models` 有 `paid_input_per_m`
  列但尚未 seed 价格。
- `routes/dashboard.ts` 的 11 个 `/analytics/*` stub 现在是**死代码**
  （被 analyticsRouter 全部遮蔽），仍留着与 analytics 层不一致的旧字段名，
  后续应删除以免误导。
- 单会话 token：登录会注销其它设备会话（既有行为，见 10-18 笔记）。
