# OpenLLM → FreeLLMAPI 全面移植计划 v2.1

## 目标
完整取代 FreeLLMAPI，所有 service + route 1:1 移植（排除主动增强或移除的模块）

## 原则
每项任务 ≤ 8h，增量验证、不可回滚合并

---

## 当前进度总览 (2026-10-23)

| 类别 | 完成 | 缺失/不完整 | 完成率 |
|------|------|-----------|--------|
| services/ | 25/33 | 8（缺/不完整） | **76%** |
| routes/ | 21/25 | 4（缺/不完整） | **84%** |
| schema | Postgres 完整 | — | ✅ |
| frontend | 4/18 pages | 14 | **22%** |

### ✅ 已完成移植 (Full Port, >80%)
- catalog-sync.ts (56KB → 57KB ✅)
- key-budget.ts (5.5KB → 6.1KB ✅)
- quota-forecast.ts (9.6KB → 12KB ✅)
- cooldown-probe.ts (9.3KB → 10KB ✅)
- model-state.ts (17.9KB → 18.3KB ✅)
- routing-decision.ts (12KB → 18KB ✅)
- quirks.ts (2.8KB → 2.8KB ✅)
- premium.ts (4.3KB → 4.1KB ✅)
- gemini.ts (route, 9.2KB → 17KB ✅)
- custom-model.ts (437 lines ✅)
- custom-model-budget.ts (6.3KB ✅)
- proxy-helpers.ts (11KB ✅)

### ⚠️ 部分移植 (<80%)
| FreeLLMAPI | OpenLLM | 完成度 | 缺失内容 |
|-----------|---------|--------|---------|
| ratelimit.ts (67KB) | ratelimit.ts (20KB) | 0.31× | 多层级清单、复杂退后、令牌桶 |
| scoring.ts (27KB) | scoring.ts (15KB) | 0.54× | 社区先验聚合、探索性奖励 |
| router.ts (124KB) | router.ts (85KB) | 0.68× | 多 provider 并发、复杂 fallback |
| fusion.ts (54KB) | fusion.ts (17KB) | 0.32× | 多模型融合、流式聚合 |
| health.ts (29KB) | health.ts (2.8KB) | 0.09× | 全面的探针、多 provider 状态 |
| auth.ts (6.7KB) | auth.ts (1.9KB) | 0.28× | OAuth、API key 加密、会话管理 |
| analytics.ts (36KB) | analytics.ts (19.8KB) | 0.54× | 实体图表、趋势分析 |
| embeddings.ts (20KB) | embeddings.ts (5.7KB) | 0.28× | 批量、缓存 |
| media.ts (57KB) | media.ts (8.8KB) | 0.15× | 图片/视频生成 |
| responses.ts (79KB) | responses.ts (7KB) | 0.09× | OpenAI Responses API |
| keys.ts (86KB) | keys.ts (0.58KB) | 0.01× | 几乎全部缺失 |
| anthropic.ts (61KB) | anthropic.ts (7.8KB) | 0.13× | /v1/messages 兼容 |

### ❌ 完全缺失的模块
**services:**
- proxy.ts (155KB) — HTTP 代理转发核心
- declarative-config.ts (23KB) — 配置驱动路由
- cache.ts (31KB) — 响应缓存层
- model-discovery.ts (32KB) — 动态模型发现
- builtin-model-discovery.ts (17KB) — 内置模型发现
- backups.ts (22KB) — 备份/恢复
- request-retention.ts (17KB) — 请求日志保留
- idempotency.ts (6.9KB) — 请求幂等性
- context-handoff.ts (7.5KB) — 上下文传递
- quota-outlook.ts (5.2KB) — 配额前瞻
- model-groups.ts (18.9KB) — 模型分组
- model-listing.ts (6.5KB) — 模型列表
- model-retirement.ts (5.3KB) — 模型退休
- model-weight-overrides.ts (8.2KB) — 权重覆盖
- penalty-inspector.ts (8.7KB) — 惩罚审计
- degradation.ts (6.4KB) — 降级策略
- moderation.ts (8.1KB) — 内容安全
- anthropic-map.ts (9.8KB) — Anthropic→OpenAI 转换
- custom-endpoint.ts (10.6KB) — 自定义端点
- custom-model-register.ts (7.6KB) — 注册中心
- custom-model-seed.ts (3.5KB) — 种子数据
- custom-model-sync.ts (7.4KB) — 同步逻辑
- custom-model-tombstone.ts (1.8KB) — tombstone 记录

**routes:**
- search.ts (1.5KB) — 搜索路由
- url-tokens.ts (1.3KB) — URL 令牌
- compression.ts (3.4KB) — 压缩设置
- docs.ts (1KB) — 文档
- health.ts (4.4KB) — 健康检查
- status.ts (9.4KB) — 平台状态
- logs.ts (3.8KB) — 日志查看
- free-tier.ts (8.8KB) — Free-tier 状态
- profiles.ts (19KB) — 客户端配置档
- client-profiles.ts (5.2KB) — 客户端配置路由
- conversations.ts (9.5KB) — 对话历史
- decisions.ts (2.4KB) — 决策审计
- mcp.ts (32KB) — MCP 集成
- update.ts (25KB) — 更新检查
- backups.ts (4.5KB) — 备份路由
- cache.ts (1.7KB) — 缓存管理路由

---

## P0 — 核心代理 (P0-CORE) ⚡ 进行中

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 0.1 | proxy-helpers.ts | services/proxy-helpers.ts (11KB) | ✅ 完成 | 1h |
| 0.2 | routes/proxy.ts (155KB) | — | ❌ 未开始 | 6h |
| 0.3 | embeddings.ts (20KB) | embeddings.ts (5.7KB) | ⚠️ 补全 | 4h |
| 0.4 | routes/responses.ts (79KB) | responses.ts (7KB) | ⚠️ 补全 | 5h |
| 0.5 | anthropic-map.ts (9.8KB) | — | ❌ 未开始 | 3h |
| 0.6 | gemini-map.ts (2.7KB) | — (gemini route 已有) | ⚠️ 部分 | 2h |
| 0.7 | /v1/completions | routes/chat.ts | ✅ 完成 | 1h |

## P1 — Keys & Auth (P1-KEYS-AUTH)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 1.1 | routes/keys.ts (86KB) | keys.ts (0.58KB) | ❌ | 6h |
| 1.2 | services/auth.ts (6.7KB) | auth.ts (1.9KB) | ⚠️ 补全 | 3h |
| 1.3 | services/provider-credential.ts (1.9KB) | — | ❌ | 1h |
| 1.4 | services/declarative-config.ts (23KB) | — | ❌ | 4h |
| 1.5 | services/url-tokens.ts (2.3KB) | — | ❌ | 2h |

## P2 — Scoring & Routing (P2-SCORING)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 2.1 | services/ratelimit.ts (67KB) | ratelimit.ts (20KB) | ⚠️ 补全 | 5h |
| 2.2 | services/fusion.ts (54KB) | fusion.ts (17KB) | ⚠️ 补全 | 4h |
| 2.3 | services/penalty-inspector.ts (8.7KB) | — | ❌ | 2h |
| 2.4 | services/model-weight-overrides.ts (8.2KB) | — | ❌ | 2h |
| 2.5 | services/degradation.ts (6.4KB) | — | ❌ | 2h |
| 2.6 | services/moderation.ts (8.1KB) | — | ❌ | 2h |

## P3 — Schema & DB (P3-DB)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 3.1 | SQLite → Postgres | pg.ts (大部分) | ✅ | — |
| 3.2 | services/backups.ts (22KB) | — | ❌ | 3h |
| 3.3 | services/request-retention.ts (17KB) | — | ❌ | 3h |
| 3.4 | services/idempotency.ts (6.9KB) | — | ❌ | 2h |
| 3.5 | services/context-handoff.ts (7.5KB) | — | ❌ | 2h |

## P4 — Models & Discovery (P4-MODELS)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 4.1 | builtin-model-discovery.ts (17KB) | — | ❌ | 3h |
| 4.2 | model-discovery.ts (32KB) | — | ❌ | 4h |
| 4.3 | model-groups.ts (18.9KB) | — | ❌ | 3h |
| 4.4 | model-listing.ts (6.5KB) | — | ❌ | 2h |
| 4.5 | model-retirement.ts (5.3KB) | — | ❌ | 2h |
| 4.6 | routes/models.ts (20.7KB) | models.ts (2.7KB) | ⚠️ 补全 | 4h |

## P5 — Frontend Pages (P5-FRONTEND)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 5.1 | Keys 管理页 (86KB) | — | ❌ | 4h |
| 5.2 | Models 子页 | — | ⚠️ 部分 | 2h |
| 5.3 | Analytics 图表 | — | ⚠️ 部分 | 3h |
| 5.4 | Decisions / Logs / Free-tier / Health / Status | — | ❌ | 3h |
| 5.5 | Profiles / Client-Profiles / Conversations | — | ❌ | 3h |
| 5.6 | Settings 页 (28KB) | — | ❌ | 4h |
| 5.7 | MCP / Search / Cache / Compression / Docs / Backups / Update | — | ❌ | 3h |

## P6 — Ops & Observation (P6-OBS)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 6.1 | services/cache.ts (31KB) | — | ❌ | 4h |
| 6.2 | services/quota-outlook.ts (5.2KB) | — | ❌ | 2h |

## P7 — Advanced (P7-ADV)

| # | FreeLLMAPI | OpenLLM | 状态 | 工时 |
|---|-----------|---------|------|------|
| 7.1 | services/custom-endpoint.ts (10.6KB) | — | ❌ | 2h |
| 7.2 | services/custom-model-sync.ts (7.4KB) | — | ❌ | 2h |
| 7.3 | services/custom-model-tombstone.ts (1.8KB) | — | ❌ | 1h |

---

## 实施节奏

| 周 | 目标 | 交付物 |
|----|------|------|
| W1 | P0-CORE | proxy-helpers ✅, /completions ✅; 下一步: proxy.ts 核心代理 |
| W2 | P1-KEYS-AUTH | Keys 管理页 + OAuth + declarative-config |
| W3 | P2-SCORING | ratelimit + fusion 补齐 + penalty-inspector |
| W4 | P3-DB + P4-MODELS | schema 完成 + model discovery 启动 |
| W5 | P5-FRONTEND | 所有前端子页完成 |
| W6 | P6/P7 | Ops 页面 + MCP/search/backups/update |

---

## 已主动移除的模块（不移植）
- `services/proxy.ts` 的原版 Node/Express 实现（OpenLLM 用 Hono 重写）
- 原版 `routes/*.ts` 的 Express Router 模式（改为 Hono App）
- 原版 `lib/*.ts` 中的 Express 中间件（Hono middleware 替代）
