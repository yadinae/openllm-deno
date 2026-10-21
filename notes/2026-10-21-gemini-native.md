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
```

## 已知限制

1. **gpt-oss 模型内容为空**：该模型将输出放在 `reasoning` 字段而非 `content`，转换层未处理。需在 `openAIToGemini` 中合并 `reasoning_content`。
2. **仅支持 chat 能力**：原生 Gemini 还支持 `embeddings`, `generateImage` 等，暂未暴露。
3. **认证**：当前复用 Dashboard session，生产建议独立 API key 认证。

## 相关文件
- `routes/gemini.ts` (NEW)
- `providers/index.ts` (base_url 修复)
- `main.ts` (静态文件放行)
- `docs/DEVELOPMENT_PLAN.md` (P2 标记完成)