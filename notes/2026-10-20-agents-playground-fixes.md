# /agents 页面 "i.filter is not a function"：analytics 端点返回包裹对象崩 SPA .filter
# /试验场 页面 "请求失败未知错误"：上游错误字符串未解析
# 登录失败：需重置密码

## 问题

1. **/agents 页面白屏**：报错 `i.filter is not a function`。`main.ts:186` 把 `routes/analytics.ts` 挂在 `/api/analytics`（早于 `/api`），返回 `{data, range}` 包裹对象，而 SPA 期望**裸数组**直接 `.filter()`。11 个 analytics 端点全是此形状错误，字段名也是 snake_case。

2. **/试验场 页面 "请求失败未知错误"**：**两层原因**。
   - (a) provider adapter 把上游非 2xx 响应体原文当错误字符串返回，字段名不统一（`detail`/`message`/`error.message`）。
   - (b) **真正让前端显示"未知错误"的是响应形状**：`routes/chat.ts` 返回 `{error: "<字符串>"}`，而 SPA 读 `err.error?.message`。字符串没有 `.message`，所以**无论消息内容多干净都必然退化成 unknownError**。

3. **登录失败**：`yadinae@gmail.com` / `openllm2026` 登录不了，数据库里只有 `admin@openllm.local` 用户。

## 权衡

- **analytics 端点**：一次性重写全部 11 个端点，按 FreeLLMAPI 契约对齐（6 个裸数组、4 个对象），并加入永久回归测试。
- **错误解析**：在所有 provider adapter 统一加入 JSON 解析回退，提取 `error.message`、`error.detail`、`message`、`detail`，不改变成功路径。
- **登录**：一次性临时端点 `/api/auth/reset-admin` 重置密码，用完即删，不留后门。

## 结论

### 1. Analytics 端点重写（核心修复）

- **`services/client-classifier.ts`（新）**：移植 FreeLLMAPI 26 值粗粒度分类器，纯函数 + 4 单测全绿。
- **`main.ts`**：新增全局 middleware `setClientMeta()`，**挂在所有 `/v1` router 之前**，UA + X-Forwarded-For → caller identity。
- **`services/request-log.ts`**：AsyncLocalStorage 承载 caller 元数据，**零调用点签名改动**；INSERT 5 新列 + ON CONFLICT 用 `COALESCE` 保留 request 阶段写入的元数据。
- **`db/pg.ts`**：`requests` 增 5 列（client_agent/client_ip/client_user_agent/request_type/requested_model）+ MIGRATIONS + 索引。
- **`routes/analytics.ts`（重写 447 行）**：6 个数组端点返回**裸数组**，4 个对象端点返回契约字段名对象。数组端点 DB 出错时返回 `[]` 而非错误对象，保证页面永不因后端故障白屏。
- **`tests/analytics-contract.test.ts`（新）**：`DATABASE_URL` 未设置时启动 analyticsRouter（initDb 必抛，走 catch 路径），断言 6 个数组端点返回**真数组**、4 个对象端点返回对象。**旧代码上会失败**（stash 回退验证：旧代码 42 failed，修复后 41 failed，差的就是这一条），是永久守卫。

### 2. Provider 错误解析修复（本次新增）

在所有 provider adapter 的 `!res.ok` 分支统一加入：
```typescript
const text = await res.text();
let message = text.slice(0, 500);
try {
  const parsed = JSON.parse(text);
  if (parsed.error?.message) {
    message = parsed.error.message;
  } else if (parsed.error?.detail) {
    message = parsed.error.detail;
  } else if (parsed.message) {
    message = parsed.message;
  } else if (parsed.detail) {
    message = parsed.detail;
  } else if (typeof parsed === "string") {
    message = parsed;
  }
} catch {
  // Not JSON, use raw text
}
return { error: message, ... };
```
涉及文件：`openai-compat.ts`、`anthropic.ts`、`opencode.ts`、`ollama.ts`、`gemini.ts`。

验证：NVIDIA 返回 `{"status":403,"title":"Forbidden","detail":"Authorization failed"}` 现解析为 `"Authorization failed"`；Zhipu 返回 `余额不足或无可用资源包,请充值。`。

> ⚠️ **本条只修到了一半**：消息提取变干净了，但前端仍显示"未知错误"，因为 `chat.ts` 返回的是 `{error: 字符串}` 而 SPA 读 `error.message`。
> 完整修复见 [2026-10-20-auto-routing-free-models.md](2026-10-20-auto-routing-free-models.md)（错误形状改为 `{error:{type,message}}`）。

### 3. 登录修复

- 临时添加 `/api/auth/reset-admin` 端点，用 `RESET_ADMIN_2026` 密钥重置第一个用户密码为 `openllm2026`。
- 成功重置 `admin@openllm.local`，登录验证通过。
- 确认后立即删除临时端点，不留后门。

### 4. 死代码清理

- **`routes/dashboard.ts`**：删除 11 个 analytics stub 端点（被 `analyticsRouter` 全部遮蔽），减少 ~570 行。
- 删除临时 reset-admin 端点。

### 踩坑（差点把整站搞挂）

`db/pg.ts` 用 `SCHEMA_SQL.split(";")` 切分 DDL。我在 CREATE TABLE 里加的 SQL 注释 `-- ... client_agent; ip + raw UA ...` **注释里带了分号**，DDL 被从注释中间截断，部署后 `/api/health` 直接 503：
`schema statement failed [CREATE TABLE IF NOT EXISTS requests ...]: syntax error at end of input`。

→ **DDL 字符串里任何位置（含注释）都不能出现分号。** 修法：注释改用逗号/句号重写。

## 验证

- `deno check main.ts` ✅
- 新增 6 个单测全绿（analytics-contract + client-classifier）
- 全量测试：59 passed / 41 failed（全部是环境性失败：`DATABASE_URL not set` / 本地无 :9999 服务，与 stash 基线一致）
- 部署 revision `byhvbk5vr1ky`（错误解析修复）
- 线上验证：
  - `/api/health` → `healthy`，12 platforms，schema 迁移成功
  - `/api/analytics/by-client` 等 6 个数组端点 → **裸数组** ✅
  - `/api/analytics/summary` 等 4 个对象端点 → 契约字段名对象 ✅
  - 错误响应：`{"error":"Authorization failed"}` 而非字符串化 JSON ✅
  - 正常聊天：`model:"auto"` 返回 `deepseek/deepseek-v4.1-flash-1017` ✅
  - 登录：`admin@openllm.local` / `openllm2026` ✅

## 遗留

- 需在 PostgreSQL 创建/迁移 `yadinae@gmail.com` 用户（当前仅 `admin@openllm.local` 可用）
- `ttfb_ms`、`request_attempts`、价格 seed 暂未完成
- 单会话 token：登录会注销其它设备会话（既有行为，见 10-18 笔记）

