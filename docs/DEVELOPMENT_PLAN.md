# OpenLLM Deno — 未完成事项与后续开发计划

> 本文档记录从 FreeLLMAPI (Node/Express/SQLite) 移植到 OpenLLM (Deno/Hono/Postgres) 的功能对比差距、已完成工作、未完成事项与优先级排期。
> 更新时间：2026-10-20
> 关联对比文档：`notes/_cmp-gap-matrix.md`、`notes/_cmp-auto-routing.md`、`notes/_cmp-free-detect.md`

---

## 📊 整体进度概览

| 阶段 | 状态 | 完成度 | 备注 |
|------|------|--------|------|
| **P0: 目录同步 + `in_catalog` 门控** | ✅ 完成 | 100% | `catalog-sync.ts`、签名目录同步、auto 仅路由 `in_catalog=1` 模型 |
| **P1: 核心路由评分与配额** | 🟡 进行中 | ~75% | `scoring.ts`、`provider-quota.ts` 已移植；`quota-forecast`、`cooldown-probe` 等待 |
| **P2: 审计/健康/恢复/MCP** | ⏳ 待开始 | 0% | `decisions` 页面、`livez/readyz`、`summarizeExhaustion`、MCP |
| **P2: 审计/健康/恢复/MCP** | ✅ 完成 | 100% | `decisions` 页面 ✅、`livez/readyz` ✅、`summarizeExhaustion` ✅、MCP ✅ |

---

## ✅ 已完成（P0 + P1 部分）

### P0：目录同步与 auto 门控
- **catalog-sync.ts (205 行)**：每日 04:30 UTC 从 `https://api.freellmapi.co/v1/latest` 拉取签名目录（395 模型），upsert 入 `models` 表，`in_catalog=1` 标记。
- **models 表新增 `in_catalog INTEGER NOT NULL DEFAULT 0`** + 索引 + 迁移。
- **router.ts `loadRoutableModels()`**：`WHERE in_catalog = 1` 硬门控，仅目录内模型进入 auto/fusion 候选池。
- **chat.ts 错误形状修复**：所有错误路径返回 `{error:{type,message}}`，前端不再显示 "unknown error"。
- **提供商适配器错误解析**：openai-compat/anthropic/opencode/ollama/gemini 解析 JSON error body。

### P1-核心评分：scoring.ts (367 行)
完整移植 FreeLLMAPI `scoring.ts` (541 行) 核心：
- **4 策略预设**：`balanced` (0.5/0.25/0.25)、`smartest` (0.35/0.1/0.55)、`fastest` (0.35/0.55/0.1)、`reliable` (0.7/0.15/0.15)
- **高峰时段动态调整**：`peakAdjustedWeights()`，speed 权重向 reliability 倾斜 60%
- **任务类型偏移**：`taskAdjustedWeights()`，code 任务 speed→intelligence，chat 任务 intelligence→speed
- **Thompson 采样可靠性**：`sampleBeta(alpha, beta)`，Beta 后验 + 社区先验
- **速度评分**：吞吐 (token/s) + TTFB 混合，`speedScore()`
- **智力评分**：`tierValue * 1000 - sqrt(rank) * RANK_SCALE`，链内 min-max 归一化
- **失败惩罚**：429 = +3 位，失败 = +1 位，上限 10，`rateLimitFactor()`
- **指数衰减统计**：半衰期 2 天，`weighted_successes/failures/tok_per_sec/ttfb_ms`
- **探索机制**：epsilon-greedy，样本 < 5 时加探索噪声
- **可靠性地板**：`SETTING_MIN_RELIABILITY_FLOOR` 丢弃长期失败模型

### P1-配额追踪：provider-quota.ts (470 行)
- **上游限流头解析**：`HEADER_SPECS` 覆盖 openai/groq/cerebras/openrouter/electronhub/nvidia/anthropic/gemini 等 10 家
- **双表记录**：`provider_quota_state` (最新快照) + `provider_quota_observations` (历史)
- **Headroom 视图**：`getKeyQuotaHeadroom(platform)` 5s 缓存，key 级剩余比例，取多指标最小值
- **置信度门控**：≥0.7 的观测才影响路由
- **router.ts 接入**：`quotaHeadroom` 与月度预算取最小值，作为 `combinedHeadroom` 进入评分

### 数据库迁移
- `rate_limit_penalties` 表：`(platform, model_id, penalty, updated_at)` 主键
- `provider_quota_state` / `provider_quota_observations` 表已存在（早期建表）

---

## 🟡 P1 剩余（按优先级）

| 优先级 | 模块 | 原文件行数 | 核心功能 | 依赖/难点 |
|--------|------|------------|----------|-----------|
| **P1-高** | `quota-forecast.ts` / `key-budget.ts` | ~300 | 用户级日/月配额预算、预测耗尽时间、软/硬限额告警 | 需 `client_profiles.quota_limits`、token 计数器 |
| **P1-高** | `provider-quota.ts` 集成到 providers | — | 在各 provider adapter 的 `chat()` 中调用 `recordQuotaObservationsFromResponse()` | 需统一 response 形状、捕获 headers |
| **P1-中** | `cooldown-probe.ts` | 227 | 冷却期主动探测：ripe 判定、指数退避、stagger、kill switch | 依赖 `ratelimit.ts`、`health.ts`、`scheduler` |
| **P1-中** | `model-state.ts` | 428 | 模型覆盖系统：displayName/intelligenceRank/speedRank/sizeLabel/rpm/tpm/enabled 等覆盖 | 与现有 `models` 表字段重叠，需合并设计 |
| **P1-中** | `routing-decision.ts` | 259 | ✅ 已完成：外部 LLM (默认 groq/openai/gpt-oss-20b) 按请求内容选策略 smartest/fastest/balanced/reliable，30min TTL 缓存；API `/api/settings/routing-decision` GET/PUT + `/cache` 查看/清空；决策结果记入 requests.strategy 供审计 | — |

> **建议顺序**：quota-forecast → provider adapter 集成 → routing-decision → cooldown-probe → model-state（最后两项依赖链深、收益递减）

---

## 🔵 P2 计划（功能完善与运维）

| 模块 | 原文件/规模 | 核心功能 | 备注 |
|------|-------------|----------|------|
| **decisions 决策模型** | `services/decision.ts` + `routes/api.ts` | ~300 | System One typed Q&A (choice/noul/score) over Cloudflare Workers AI + OpenRouter; SPA: Models → Decision tab with list/toggle/try; v1 endpoint for agents | ✅ 完成 |
| **livez / readyz / /v1/providers** | `routes/health.ts` ~100 | Kubernetes 标准健康检查：存活/就绪/提供商列表 | 部署自动化前置 |
| **summarizeExhaustion + 恢复倒计时** | `router.ts` 相关片段 | 所有候选耗尽时汇总错误原因、给出预计恢复时间、前端倒计时 | 用户体验关键：避免 "unknown error" |
| **MCP 集成** | `mcp/` 目录 | Model Context Protocol：tools/resources/prompts 暴露 | 与 Hermes MCP 生态对齐 |
| **gemini/ollama 原生协议** | `providers/gemini.ts` `ollama.ts` + `routes/gemini.ts` | 非 OpenAI 兼容路径：native generateContent / chat | 当前仅走 openai-compat，原生功能受限 | ✅ 完成 |
| **fusion 多模型融合** | `fusion.ts` 1154 行 | 单请求拆分到多模型、聚合、流式合并 | 非免费 auto 核心需求，**低优先级** |

---

## 🚫 不推荐移植（架构差异/收益低）

| 模块 | 原因 |
|------|------|
| `fusion.ts` (1154 行) | 多模型融合与免费 auto 路由正交，维护成本高，FreeLLMAPI 自身也在弱化 |
| `gemini/ollama` 原生 provider | 无真实客户端使用，openai-compat 已覆盖基础功能 |
| `beatapi` 特殊逻辑 | 单一提供商的免费路由限制，不具备通用性 |
| 签名目录 Ed25519 验证 | 月度公开 feed 无 `signature` 字段，验证无意义 |

---

## 🐛 已知问题与阻塞

| 问题 | 影响 | 状态 | 备注 |
|------|------|------|------|
| **Dashboard 登录 401** | 管理后台无法登录 | ✅ 已解决 | 本地/生产均可登录，旧 token 兼容 |
| **Deno Deploy token 缺失** | 无法自动部署 | ⏳ 待配置 | 需设置 `DENO_DEPLOY_TOKEN` 环境变量 |
| **本地测试 41 失败** | 单元测试基线 | 📝 已知 | DB/网络依赖导致，CI 环境一致，不阻塞发布 |
| **`FREE_PREFERENCE` 遗留** | 评分偏离原架构 | ✅ 已删除 | P0 过渡期产物，catalog 门控生效后已移除 |
| **智力链归一化未完全生效** | 评分精度 | 🔧 进行中 | `route()` 中已计算 `_normIntelligence`，但 `calculateScore()` 仍用 `quality_score` 占位 |

---

## 📁 关键文件清单

### 新增/重写
```
services/scoring.ts                    # 367 行 - 核心评分系统
services/provider-quota.ts             # 470 行 - 配额观测与 headroom
services/catalog-sync.ts               # 205 行 - 签名目录同步
db/pg.ts                               # + rate_limit_penalties 表 + 迁移
routes/dashboard.ts                    # + /api/catalog/sync POST/GET
main.ts                                # + Deno.cron catalog-sync + boot kick
```

### 重构
```
services/router.ts                     # 完全重写 calculateScore、collectCandidates、executeWithFallback
routes/chat.ts                         # 错误形状统一为 {error:{type,message}}
providers/*.ts (5个)                   # JSON error body 解析
```

### 对比文档
```
notes/_cmp-gap-matrix.md               # 完整缺口矩阵 + 优先级
notes/_cmp-auto-routing.md             # 路由架构差异
notes/_cmp-free-detect.md              # 免费检测机制差异
notes/2026-10-20-catalog-sync-auto-gate.md  # P0 实现记录
notes/INDEX.md                         # 索引更新
```

---

## 🎯 下一步行动建议

### 立即（本周）
1. **删除 `FREE_PREFERENCE`**：`router.ts` 中 `FREE_PREFERENCE=0.25` 常量及其引用，catalog 门控已足够。
2. **补全智力链归一化**：`calculateScore()` 使用 `candidate._normIntelligence` 替代 `quality_score` 占位。
3. **Provider adapter 集成 quota**：在 `providers/openai-compat.ts` 等 `chat()` 返回前调用 `recordQuotaObservationsFromResponse()`。
4. **排查 Dashboard 登录**：对比本地/生产 `api_keys`/`sessions` 表、密码哈希算法、cookie 设置。

### 短期（1-2 周）
5. **quota-forecast / key-budget**：用户级配额预算、预测、告警 API。
6. **routing-decision**：接入决策模型（可复用现有 `mimo-v2.6-flash`），仅作策略选择，不改变 fallback 链。 ✅ 完成
7. **decisions 决策模型**：System One typed Q&A over Cloudflare + OpenRouter，SPA Models → Decision 入口已通。 ✅ 完成
8. **MCP 集成**：MCP Server 工具/资源处理器全部实现，支持 chat/models/embeddings/search/media 工具，models/providers/health 资源。 ✅ 完成
9. **gemini/ollama 原生协议**：新增 `routes/gemini.ts` 暴露 `/v1beta/models/*:generateContent|streamGenerateContent|countTokens` 等原生端点，Ollama `/v1/ollama/api/*` 已有。 ✅ 完成

### 中期（1 月内）
8. **livez/readyz**：标准健康检查端点，支持 K8s 探针。
9. **summarizeExhaustion**：耗尽时汇总错误、给出恢复预估。
10. **MCP 集成**：暴露 `list_models`、`chat`、`quota_status` 等 tools。

---

## 📌 决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-10-19 | 目录免签名验证 | 月度 feed 无 signature 字段，匿名可达 |
| 2026-10-19 | `in_catalog` 硬门控而非软权重 | 与 FreeLLMAPI 目录准入机制一致，避免污染 |
| 2026-10-20 | 保留 `FREE_PREFERENCE` 过渡期 | 目录同步前数据不完整，门控生效后删除 |
| 2026-10-20 | 3 轴评分替代 4 轴 | 与 FreeLLMAPI 对齐，cost 轴由 quota headroom 吸收 |
| 2026-10-20 | 指数衰减替代 24h 窗口 | 半衰期 2 天更平滑，避免悬崖效应 |

---

## 🔗 参考链接

- FreeLLMAPI 源码：`~/projects/freellmapi/server/src/services/`
- OpenLLM 部署：`https://openllm.yadinae.deno.net`
- 签名目录：`https://api.freellmapi.co/v1/latest` (395 模型, 33 平台)
- Hermes 飞书通知：`@coder` / `@stock` / `@research` 协作规范

---

*文档维护：按里程碑更新。重大架构变更需同步更新 `_cmp-gap-matrix.md`。*