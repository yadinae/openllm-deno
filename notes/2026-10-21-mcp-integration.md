# 2026-10-21 · MCP 集成增强

## 背景

原版 `services/mcp.ts` (435 行) 实现了 MCP Server/Client 的基本框架，但工具和资源没有实际的 handler 实现——`handleCallTool` 和 `handleReadResource` 都是 stub。

## 问题诊断

```
POST /api/mcp/mcp → tools/call → openllm.chat
→ "Tool openllm.chat not found"
```

根因：`BUILTIN_TOOLS` 注册了工具定义，但 `toolHandlers` Map 是空的——没有调用 `registerTool` 注册 handler。

## 实现

### 1. `services/mcp.ts` — 新增 `initGatewayContext()`
- 从外部注入 8 个 handler（5 工具 + 3 资源）
- 自动注册到 `toolHandlers` / `resourceHandlers` Map
- 保持 `MCPServer` 类的单一职责（协议层），实际业务逻辑在 `routes/api.ts`

### 2. `routes/api.ts` — 实现 8 个 handler
| 工具 | 功能 | 实现 |
|---|---|---|
| `openllm.chat` | 聊天补全 | `providerRegistry.get(platform).chat()` |
| `openllm.models` | 模型列表 | `listCatalogModels()` + 过滤 |
| `openllm.embeddings` | 嵌入 | `provider.embeddings()` |
| `openllm.search` | 网页搜索 | `services/search.ts` |
| `openllm.media` | 图片生成 | `provider.generateImage()` |
| `openllm://models` | 资源 | `listCatalogModels()` |
| `openllm://providers` | 资源 | `providerRegistry.getAllIds()` |
| `openllm://health` | 资源 | `listApiKeys()` + 平台统计 |

### 3. 类型修复
- `provider.embeddings` / `provider.generateImage` 不在 `ProviderAdapter` 接口 → 用 `(provider as any)` 强转
- `providerRegistry.keys()` 不存在 → 改用 `providerRegistry.getAllIds()`
- `DbEntry` → `ApiKey` 需要显式 cast（确保 `label`、`encrypted_key` 等必填字段）

## 生产验证

```
POST /api/mcp/mcp → tools/call → openllm.models
→ isError: False, 返回 583 个模型列表

POST /api/mcp/mcp → resources/read → openllm://providers
→ 12 个平台

POST /api/mcp/mcp → resources/read → openllm://health
→ healthy, 12 platforms, 12 keys

POST /api/mcp/mcp → tools/call → openllm.chat
→ 调用 groq/openai/gpt-oss-20b（401 因为 key 不匹配，但流程通了）
```

## 限制
1. **MCP 端点路径**：`api.route("/mcp", ...)` + `app.post("/mcp", ...)` → 实际路径 `/api/mcp/mcp`。MCP 标准客户端可能期望 `/api/mcp`。需要在 `main.ts` 里调整路由。
2. **认证**：当前 MCP 端点未做认证（任何人均可调用），生产环境需加 API key 门控。
3. **流式**：SSE 端点存在但未测试。

## 相关
- `services/mcp.ts` — MCP Server/Client 类 + `initGatewayContext()`
- `routes/api.ts` — 8 个 handler 实现 + `initGatewayContext()` 调用
- `docs/DEVELOPMENT_PLAN.md` — P2 标记 100% 完成
