# 笔记索引

| 日期 | 主题 | 类型 | 文件 |
|---|---|---|---|
| 2026-10-23 | deploy.ts 重复参数导致 22 次 /settings 修复全未上线 | 踩坑/根因 | [2026-10-23-deploy-script-bug-wasted-22-settings-commits.md](2026-10-23-deploy-script-bug-wasted-22-settings-commits.md) |
| 2026-10-22 | Probe 设计重构：auth 校验与模型可用性必须分离（NVIDIA 模型 EOL 导致假阳性） | 踩坑/架构决策 | [2026-10-22-probe-auth-vs-model-error-classification.md](2026-10-22-probe-auth-vs-model-error-classification.md) |
| 2026-10-22 | gemini.ts 重复顶层 const → warming failed；空错误体是 falsy → 原生路由崩 + `/v1` 空 200（部署历史才是裁判） | 踩坑/修复/验证 | [2026-10-22-gemini-boot-failure-and-empty-error-body.md](2026-10-22-gemini-boot-failure-and-empty-error-body.md) |
| 2026-10-21 | Gemini 原生协议落地（复核：Hono catch-all 坑 + reasoning_content 合并） | 踩坑/修复/架构 | [2026-10-21-gemini-native.md](2026-10-21-gemini-native.md) |
| 2026-10-21 | Decision Models (System One typed Q&A) 落地记录 | 架构/决策/实现 | [2026-10-21-decision-models.md](2026-10-21-decision-models.md) |
| 2026-10-21 | routing-decision.ts 落地记录 | 架构/决策/实现 | [2026-10-21-routing-decision.md](2026-10-21-routing-decision.md) |
| 2026-10-21 | MCP 集成增强 — 内置工具/资源处理器 | 踩坑/实现 | [2026-10-21-mcp-integration.md](2026-10-21-mcp-integration.md) |
| 2026-10-20 | P1 核心评分系统移植完成：3 轴 Bandit 替代 4 轴、指数衰减、配额 headroom 接入路由 | 架构/决策/实现 | [2026-10-20-p1-scoring-provider-quota-port.md](2026-10-20-p1-scoring-provider-quota-port.md) |
| 2026-10-20 | 签名目录同步 + auto 闸门：只路由有免费性证据的 395 条模型，假阳性清零 | 实现/记录 | [2026-10-20-catalog-sync-auto-gate.md](2026-10-20-catalog-sync-auto-gate.md) |
| 2026-10-20 | 【对比】免费判定：原版靠准入(签名目录+字面'free')，models 表无 free 列；移植版三套判据并存、用「无价格即免费」致满屏假阳性 | 架构/调研 | [_cmp-free-detect.md](_cmp-free-detect.md) |
| 2026-10-20 | 【对比】auto 调度：原版是签名目录+预排序链路+多轴bandit三层子系统，移植版只是每请求现捞现算 | 架构/调研 | [_cmp-auto-routing.md](_cmp-auto-routing.md) |
| 2026-10-20 | 【对比总表】FreeLLMAPI↔OpenLLM 功能差距：缺 36 个 services 模块，端点面大体已对齐、差在调度深度 | 架构/调研 | [_cmp-gap-matrix.md](_cmp-gap-matrix.md) |
| 2026-10-20 | auto 不是筛选免费模型而是抓上游列表头 8 个 + 错误形状导致未知错误 | 踩坑/修复 | [2026-10-20-auto-routing-free-models.md](2026-10-20-auto-routing-free-models.md) |
| 2026-10-20 | 智能体页 i.filter is not a function + 试验场 未知错误 + 登录重置 | 踩坑/修复 | [2026-10-20-agents-playground-fixes.md](2026-10-20-agents-playground-fixes.md) |
| 2026-10-20 | 智能体页 i.filter is not a function：analytics 端点返回包裹对象崩 SPA .filter | 踩坑/修复 | [2026-10-20-agents-page-analytics-envelope-crash.md](2026-10-20-agents-page-analytics-envelope-crash.md) |
| 2026-10-19 | fallback 574 vs catalog 356：缺失 537 模型导致 displayName 退化到 raw modelId | 踩坑/根因 | [2026-10-19-catalog-fallback-displayname-mismatch.md](2026-10-19-catalog-fallback-displayname-mismatch.md) |
| 2026-10-19 | `dist/ not found` 连发两次：必须用 `scripts/deploy.ts` 部署 | 踩坑/规范 | [2026-10-19-dist-not-found-deploy-script-mandatory.md](2026-10-19-dist-not-found-deploy-script-mandatory.md) |
| 2026-10-18 | 登录恒 "Invalid email or password"：改用 users/scrypt 对齐 FreeLLMAPI 账本 | 踩坑/修复 | [2026-10-18-dashboard-auth-users-scrypt-alignment.md](2026-10-18-dashboard-auth-users-scrypt-alignment.md) |
| 2026-10-18 | 无头浏览器逐页验证 SPA：端点"200 但形状不对"是主要故障源 | 踩坑/修复 | [2026-10-18-headless-browser-page-verification-shape-mismatches.md](2026-10-18-headless-browser-page-verification-shape-mismatches.md) |
| 2026-10-18 | 补齐 ~40 个 dashboard 端点 + /api 会话网关 + 键 CRUD 契约修正 | 决策/实现 | [2026-10-18-dashboard-remaining-endpoints-session-gate-and-key-crud.md](2026-10-18-dashboard-remaining-endpoints-session-gate-and-key-crud.md) |
| 2026-10-18 | 前端"无法连接到服务器"：SPA 走 /api/auth/* 而后端只实现 /api/settings/* | 踩坑/修复 | [2026-10-18-dashboard-auth-contract-mismatch.md](2026-10-18-dashboard-auth-contract-mismatch.md) |
| 2026-10-18 | 可复现部署脚本 + Postgres 单一真源（loadDb 降级） | 决策/实现 | [2026-10-18-deploy-reproducible-script-and-postgres-single-source.md](2026-10-18-deploy-reproducible-script-and-postgres-single-source.md) |
| 2026-10-18 | 部署 warming 阶段 boot_failed：gitignore 排产与远端 schema 漂移 | 踩坑/决策 | [2026-10-18-deploy-warmup-boot-failed-gitignore-and-schema-drift.md](2026-10-18-deploy-warmup-boot-failed-gitignore-and-schema-drift.md) |
| 2026-10-18 | 功能/质量审计：Postgres DDL 是 SQLite 语法且缺三张核心表 | 踩坑/决策 | [2026-10-18-db-schema-sqlite-ddl-audit.md](2026-10-18-db-schema-sqlite-ddl-audit.md) |
| 2026-10-18 | 线上仍是缺端点的旧 revision，24 个 GET 打 404 | 踩坑/风险 | [2026-10-18-live-revision-missing-24-endpoints.md](2026-10-18-live-revision-missing-24-endpoints.md) |
| 2026-10-17 | 重写 routes/api.ts 误删 Phase 0-5 端点 | 踩坑/决策 | [2026-10-17-rewrite-api-ts-deleted-phase0-5.md](2026-10-17-rewrite-api-ts-deleted-phase0-5.md) |

按时间倒序。每篇是一次技术问答的 `问题 / 权衡 / 结论` 摘要。