# OpenLLM (FreeLLMAPI) 迁移到 Deno Deploy — 完整计划

## 原始 Phase 计划

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 0 | 客户端源码重建（改名进源码 + Premium 改造） | ✅ 完成 |
| Phase 1 | 补齐端点清单 + 建契约回归测试 | ✅ 完成 |
| Phase 2 | schema 移植（40 迁移 SQLite→Postgres） | ✅ 完成 |
| Phase 3 | fallback/routing/models 富目录 + 打分 | ✅ 完成 |
| Phase 4 | keys 全功能 | ✅ 完成 |
| Phase 5 | 各模态页 | ✅ 完成 |
| Phase 6 | 观测运维页 | ✅ 完成 |
| Phase 7 | 客户端 / 配额 /auth | ✅ 完成 |

---

## Phase 5: 各模态页 — 已完成

### 已实现的端点

#### Media Models (image, video, audio, transcription)
- `GET /api/media` — 获取所有多模态模型列表
- `GET /api/media/usage?modality=...` — 获取指定模态的使用统计
- `POST /api/media/custom` — 注册自定义多模态模型
- `PUT /api/media/:id` — 更新多模态模型启用状态
- `DELETE /api/media/custom/:id` — 删除自定义多模态模型

#### Embeddings
- `GET /api/embeddings` — 获取所有嵌入模型（按 family 分组）
- `GET /api/embeddings/usage` — 获取嵌入使用统计
- `POST /api/embeddings/custom` — 注册自定义嵌入模型
- `PUT /api/embeddings` — 更新嵌入设置（默认 family）
- `DELETE /api/embeddings/custom/:id` — 删除自定义嵌入模型

#### Search Engines
- `GET /api/search/engines` — 获取所有搜索引擎列表
- `PATCH /api/search/engines/:id` — 更新搜索引擎启用/优先级
- `GET /api/search/summary` — 获取搜索摘要统计

### 前端页面

所有模态页面已存在：
- `/pages/ImagePage.tsx` — 图像生成页面
- `/pages/VideoPage.tsx` — 视频生成页面
- `/pages/AudioPage.tsx` — 音频生成页面
- `/pages/EmbeddingsPage.tsx` — 嵌入模型页面
- `/pages/SearchPage.tsx` — 搜索引擎页面

### 技术架构

```
前端 (React/Next.js)
    │
    ▼
API Server (Hono on Deno Deploy)
    │
    ├── Media Router
    │   ├── GET /api/media
    │   ├── GET /api/media/usage
    │   ├── POST /api/media/custom
    │   ├── PUT /api/media/:id
    │   └── DELETE /api/media/custom/:id
    │
    ├── Embeddings Router
    │   ├── GET /api/embeddings
    │   ├── GET /api/embeddings/usage
    │   ├── POST /api/embeddings/custom
    │   ├── PUT /api/embeddings
    │   └── DELETE /api/embeddings/custom/:id
    │
    └── Search Router
        ├── GET /api/search/engines
        ├── PATCH /api/search/engines/:id
        └── GET /api/search/summary
```

---

## 生产环境

- **URL**: https://openllm.yadinae.deno.net
- **最新修订**: pjnwk36qsab9
- **数据库**: Prisma Postgres
- **Provider 数量**: 9
- **模型总数**: 106
- **免费模型**: 27（含 cached）

---

## Phase 6: 观测运维页 — 已完成

### 已实现的端点

#### Health（健康检查）
- `GET /api/health` — 全系统健康状态（按平台聚合）
- `GET /api/health/detailed` — 详细健康检查（含 degradation 状态）

#### Logs（运行日志）
- `GET /api/logs` — 游标式日志查询（支持 levels/sinceId/limit/q/provider 过滤）
- `POST /api/logs/clear` — 清空运行日志

#### Observability（观测）
- `GET /api/observability/metrics` — 性能指标（请求/token/延迟/平台）
- `GET /api/observability/performance` — 按平台的性能数据
- `GET /api/observability/summary` — 观测摘要

#### Alerts（告警）
- `GET /api/observability/alerts` — 告警配置列表
- `POST /api/observability/alerts` — 创建告警
- `PUT /api/observability/alerts/:id` — 更新告警
- `DELETE /api/observability/alerts/:id` — 删除告警

### 技术架构

```
前端 (React/Next.js)
    │
    ▼
API Server (Hono on Deno Deploy)
    │
    ├── Health Router
    │   ├── GET /api/health
    │   └── GET /api/health/detailed
    │
    ├── Logs Router
    │   ├── GET /api/logs
    │   └── POST /api/logs/clear
    │
    ├── Observability Router
    │   ├── GET /api/observability/metrics
    │   ├── GET /api/observability/performance
    │   ├── GET /api/observability/summary
    │   └── Alerts (CRUD)
    │
    └── DB Layer (Prisma Postgres)
        ├── api_keys — API 密钥
        ├── server_logs — 运行日志
        ├── requests — 请求日志
        └── settings — 系统设置
```

---

## Phase 7: 客户端 / 配额 /auth — 已完成

### 已实现的端点

#### Client Profiles（客户端配置）
- `GET /api/client-profiles` — 客户端列表
- `POST /api/client-profiles` — 创建客户端（含密钥生成）
- `PATCH /api/client-profiles/:id` — 更新客户端
- `POST /api/client-profiles/:id/rotate` — 轮换客户端密钥
- `DELETE /api/client-profiles/:id` — 删除客户端

#### Quota Management（配额管理）
- `GET /api/quota/usage` — per-client 配额使用情况
- `GET /api/quota/limits` — per-client 配额限制
- `PUT /api/quota/limits` — 更新配额限制
- `GET /api/quota/forecast` — 配额预测

#### Auth Clients（认证客户端）
- `GET /api/auth/clients` — 认证客户端列表
- `POST /api/auth/clients` — 创建认证客户端
- `PUT /api/auth/clients/:id` — 更新认证客户端
- `DELETE /api/auth/clients/:id` — 删除认证客户端

#### URL Tokens（URL 令牌）
- `GET /api/url-tokens` — URL 令牌列表
- `POST /api/url-tokens` — 创建 URL 令牌
- `DELETE /api/url-tokens/:id` — 撤销 URL 令牌

### 技术架构

```
前端 (React/Next.js)
    │
    ▼
API Server (Hono on Deno Deploy)
    │
    ├── Client Profiles Router
    │   ├── GET /api/client-profiles
    │   ├── POST /api/client-profiles
    │   ├── PATCH /api/client-profiles/:id
    │   ├── POST /api/client-profiles/:id/rotate
    │   └── DELETE /api/client-profiles/:id
    │
    ├── Quota Router
    │   ├── GET /api/quota/usage
    │   ├── GET /api/quota/limits
    │   ├── PUT /api/quota/limits
    │   └── GET /api/quota/forecast
    │
    ├── Auth Clients Router
    │   ├── GET /api/auth/clients
    │   ├── POST /api/auth/clients
    │   ├── PUT /api/auth/clients/:id
    │   └── DELETE /api/auth/clients/:id
    │
    └── URL Tokens Router
        ├── GET /api/url-tokens
        ├── POST /api/url-tokens
        └── DELETE /api/url-tokens/:id
```

---

## 参考资源
- awesome-free-llm-apis: https://github.com/mnfst/awesome-free-llm-apis
- Deno Deploy: https://deno.com/deploy
- OpenRouter Free Models: https://openrouter.ai/models?order=popularity&category=chat&paid=false