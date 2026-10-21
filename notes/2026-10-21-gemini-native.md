# 2026-10-21 · Gemini 原生协议落地

## 背景

P2 计划中明确要求实现 "gemini/ollama 原生协议" —— 即非 OpenAI 兼容的原生 API 路径：
- **Gemini**: `POST /v1beta/models/{model}:generateContent|streamGenerateContent|countTokens`, `GET /v1beta/models`
- **Ollama**: `/v1/ollama/api/tags`, `/v1/ollama/api/chat`, `/v1/ollama/api/generate` (已存在于 `routes/ollama.ts`)

原版 FreeLLMAPI 仅通过 OpenAI 兼容层 (`/v1/chat/completions`) 代理 Gemini，无法使用原生 SDK 的流式、工具调用、计数等功能。

## 实现

### 1. 新增 `routes/gemini.ts` (~330 行)
暴露完整的 Gemini Generative Language API v1beta 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1beta/models` | GET | 列出所有可用模型 |
| `/v1beta/models/{model}` | GET | 获取单个模型信息 |
| `/v1beta/models/{model}:generateContent` | POST | 非流式生成 |
| `/v1beta/models/{model}:streamGenerateContent` | POST | 流式生成 (SSE) |
| `/v1beta/models/{model}:countTokens` | POST | Token 计数 |

**核心逻辑**：
- 将原生 Gemini 请求格式 (`contents[]`, `generation_config`, `system_instruction`, `tools`) 转换为 OpenAI 兼容格式
- 通过现有 Provider Registry 路由到任意 provider (google, groq, openrouter 等)
- 将 OpenAI 响应转换回原生 Gemini 格式 (`candidates[]`, `usageMetadata`)

### 2. 修复 `providers/index.ts` Google provider base_url
- 原: `https://generativelanguage.googleapis.com/v1beta` (导致双重 `/v1beta`)
- 新: `https://generativelanguage.googleapis.com`
- GeminiAdapter 内部拼接 `/v1beta/models/...`

### 3. 静态文件处理器放行 `/v1beta/`
- `main.ts` 中 `app.all("*")` 排除 `/v1beta/` 前缀

### 4. 路由挂载点调整（2026-10-21 后续会话）
- **原方案**：`app.route("/", geminiRouter)` + 路由使用 `/v1beta/models/*` 前缀
- **新方案**：`app.route("/v1beta", geminiRouter)` + 路由使用 `/models/*` 前缀
- **原因**：原方案路由模式冗长，新方案更清晰且与 API 路径约定一致

### 5. Hono 路由模式踩坑：`/models/**` 不匹配单段路径
- **问题**：Hono 的 `/**` catch-all 只匹配至少一个 path segment 的路径。`/models/foo`（一个 segment）不匹配 `/models/**`，返回 404。
- **排查**：部署脚本（`scripts/deploy.ts`）使用 git diff 判断文件变更；未提交但有 `M` 状态的文件不会被上传。多次 deploy 显示 "No files were changed" 实际是旧版本在生产。
- **解决**：同时注册 `/models/*`（精确匹配单段）和 `/models/**`（多段）两条路由。
- **验证**：`POST /v1beta/models/foo` → 400 "Invalid model path"（已到达 handler）；`POST /v1beta/models/gemini-1.5-flash:generateContent` → 503（provider key 未配置，但路由链路通）。

### 6. 已知限制修复：gpt-oss reasoning_content
- **原限制**：该模型将输出放在 `reasoning`/`reasoning_content` 字段而非 `content`，转换层未处理，返回空响应。
- **修复**：`providers/openai-compat.ts` 在三个代码路径中合并 `reasoning`/`reasoning_content` → `content`：
  1. 非流式响应：`response.choices[i].message.content` 为空时，优先取 `reasoning_content`，其次取 `reasoning`
  2. 流式整块响应：`singleChunkStream()` 中对 `choice.message` 做同样合并
  3. 流式逐 chunk：SSE 解析时对 `choice.delta` 做同样合并

## 生产验证

```
GET  /v1beta/models                              → 10 models from 10 platforms
GET  /v1beta/models/groq/openai/gpt-oss-20b      → model info
POST /v1beta/models/groq/openai/gpt-oss-20b:generateContent
  → candidates[], usageMetadata (non-streaming)
POST /v1beta/models/groq/openai/gpt-oss-20b:streamGenerateContent
  → SSE stream with candidates
POST /v1beta/models/groq/openai/gpt-oss-20b:countTokens
  → { totalTokens, totalBillableCharacters }
POST /v1beta/models/gemini-1.5-flash:generateContent
  → 503 (provider key 未配置，路由链路已通)
POST /v1beta/models/foo                          → 400 "Invalid model path" (路由已通)
```

## 已知限制

1. ~~**gpt-oss 模型内容为空**~~：已修复（见第 6 节）。`openai-compat.ts` 三个路径均合并 `reasoning`/`reasoning_content` → `content`。
2. **仅支持 chat 能力**：原生 Gemini 还支持 `embeddings`, `generateImage` 等，今日新增 `handleEmbedContent`/`handleGenerateImage` 骨架但尚未完整测试。
3. **认证**：当前复用 Dashboard session，生产建议独立 API key 认证。

## 相关
- `routes/gemini.ts` (NEW)
- `providers/index.ts` (base_url 修复)
- `main.ts` (静态文件放行; mount point 从 `/` 改为 `/v1beta`)
- `providers/openai-compat.ts` (reasoning_content 合并)
- `docs/DEVELOPMENT_PLAN.md` (P2 标记完成)

## 可复用规则

- Hono 的 `/**` catch-all **不匹配单段路径**（如 `/models/foo`）。需要同时注册 `/*` 和 `/**` 两条路由以确保覆盖所有情况。
- 部署脚本（`scripts/deploy.ts`）用 git diff 判断文件变更；未 commit 的修改不会被上传。`"No files were changed"` 不一定意味着代码没改，可能是 git 状态问题。遇到此情况先跑 `git status` 确认。