---
core_thesis: "把 OpenLLM Deno 从 '仪表盘+基础转发层' 重构为 '智能 LLM 网关'，实现 FreeLLMAPI (Node) 的功能平权，成为生产环境唯一网关"

principles:
  # P0-critical: 零容忍，一项 ❌ 直接 REJECTED
  - id: P-CORE-001
    desc: "核心网关必须具备智能路由能力：Bandit Scoring + Fallback Chain + 失败自动重试，而非单一转发"
    level: P0-critical
    verify:
      method: assertion
      level: 3
      target: "services/router.ts"
      script: |
        from services.router import SmartRouter, RoutingContext
        router = SmartRouter()
        # Verify core methods exist and are callable
        assert hasattr(router, 'route')
        assert hasattr(router, 'select_provider')
        assert hasattr(router, 'build_fallback_chain')
        # Verify Bandit scoring components
        assert hasattr(router, '_calculate_score')
        # Verify fallback chain building
        ctx = RoutingContext(request=None, available_keys=[])
        decision = await router.route(ctx)
        assert hasattr(decision, 'provider')
        assert hasattr(decision, 'fallback_chain')
        assert len(decision.fallback_chain) >= 1

  - id: P-CORE-002
    desc: "配额/冷却引擎必须在请求入口强制执行：RPM/TPM 限制、Sliding Window 计数、Cooldown Probe 自动回退"
    level: P0-critical
    verify:
      method: assertion
      level: 3
      target: "services/ratelimit.ts"
      script: |
        from services.ratelimit import QuotaEngine, CooldownManager
        engine = QuotaEngine()
        # Verify quota check and consume
        assert hasattr(engine, 'check_and_consume')
        assert hasattr(engine, 'on_response')
        # Verify cooldown probe
        assert hasattr(engine, 'probe_cooldown')
        cooldown = CooldownManager()
        assert hasattr(cooldown, 'get_state')
        assert hasattr(cooldown, 'set_cooldown')
        # Verify DB tables exist
        import os
        assert os.path.exists("db/pg.ts")
        with open("db/pg.ts") as f:
            content = f.read()
            assert "rate_limit_usage" in content
            assert "rate_limit_cooldowns" in content
            assert "created_at_ms" in content

  - id: P-CORE-003
    desc: "Fusion 多模型融合必须实现：Panel 投票(≥4 槽、去重 provider+family) + Judge 合成 + tool_choice 三档(auto/required/none)处理"
    level: P0-critical
    verify:
      method: assertion
      level: 3
      target: "services/fusion.ts"
      script: |
        from services.fusion import run_fusion, FusionConfig
        # Verify core function
        assert hasattr(run_fusion, '__call__') or hasattr(run_fusion, '__name__')
        # Verify panel selection with diversity
        assert hasattr(FusionConfig, 'panel_selection')
        assert hasattr(FusionConfig, 'k')
        assert hasattr(FusionConfig, 'judge')
        assert hasattr(FusionConfig, 'strategy')
        # Verify tool_choice handling
        import inspect
        sig = inspect.signature(run_fusion)
        assert 'tools' in sig.parameters or 'tool_choice' in str(sig)

  - id: P-CORE-004
    desc: "所有 30+ FreeLLMAPI Provider 必须在 OpenLLM 可用，含专用适配器、免费模型检测、定价解析"
    level: P0-critical
    verify:
      method: grep
      level: 2
      target: "providers/"
      pattern: "class.*Provider|export.*Adapter|interface.*Adapter"

  - id: P-CORE-005
    desc: "请求日志必须落库并驱动 /api/analytics 真实数据，不再返回空值"
    level: P0-critical
    verify:
      method: assertion
      level: 3
      target: "services/request-log.ts"
      script: |
        from services.request_log import RequestLogger
        logger = RequestLogger()
        assert hasattr(logger, 'log_request')
        assert hasattr(logger, 'log_response')
        assert hasattr(logger, 'get_metrics')
        # Verify DB tables
        with open("db/pg.ts") as f:
            content = f.read()
            assert "CREATE TABLE IF NOT EXISTS requests" in content
            assert "input_tokens" in content
            assert "output_tokens" in content
            assert "latency_ms" in content

  - id: P-CORE-006
    desc: "OpenAI 兼容契约 /v1/chat/completions /v1/models 必须与 FreeLLMAPI 完全一致，下游消费者零感知切换"
    level: P0-critical
    verify:
      method: test
      level: 3
      target: "tests/contract/"
      pattern: "test_chat_completions_contract|test_models_contract"

  # P0-standard: 关键级，弹性但累计扣分
  - id: P-CORE-007
    desc: "内置模型发现自动化：Builtin Discovery + Catalog Sync + 定期 Cron + 免费模型白名单更新"
    level: P0-standard
    verify:
      method: grep
      level: 2
      target: "services/catalog-sync.ts"
      pattern: "catalog|builtin|discover|sync|cron"

  - id: P-CORE-008
    desc: "多租户体系：Client Profiles CRUD、Quota 限制/预测、Auth Clients、URL Tokens 必须有真实持久化实现"
    level: P0-standard
    verify:
      method: assertion
      level: 2
      target: "services/client-profiles.ts"
      script: |
        from services.client_profiles import ClientProfileService
        svc = ClientProfileService()
        assert hasattr(svc, 'create')
        assert hasattr(svc, 'list')
        assert hasattr(svc, 'rotate_key')
        assert hasattr(svc, 'delete')
        # Quota
        from services.quota import QuotaService
        qsvc = QuotaService()
        assert hasattr(qsvc, 'get_usage')
        assert hasattr(qsvc, 'get_limits')
        assert hasattr(qsvc, 'set_limits')
        assert hasattr(qsvc, 'forecast')

  - id: P-CORE-009
    desc: "Embeddings/Media/Search 核心能力必须有真实实现：向量生成、图像/视频/音频生成、联网搜索"
    level: P0-standard
    verify:
      method: grep
      level: 2
      target: "services/"
      pattern: "embeddings|media|search"

  - id: P-CORE-010
    desc: "MCP 协议支持：Server/Client 模式、工具发现、资源访问"
    level: P0-standard
    verify:
      method: grep
      level: 1
      target: "services/mcp.ts"
      pattern: "MCP|mcp"

  - id: P-CORE-011
    desc: "自定义模型全生命周期：Register/Sync/Tombstone/Retirement"
    level: P0-standard
    verify:
      method: grep
      level: 1
      target: "services/custom-model*.ts"
      pattern: "register|sync|tombstone|retirement"

  - id: P-CORE-012
    desc: "加密密钥轮转脚本和 DB 备份/恢复流程必须存在并可运行"
    level: P0-standard
    verify:
      method: grep
      level: 1
      target: "scripts/"
      pattern: "rotate|backup|restore|encryption"

  # P1: 重要级，允许合理偏差
  - id: P-CORE-013
    desc: "CLI 工具：openllm keys/models/config 生成器、doctor 检查、部署命令"
    level: P1
    verify:
      method: grep
      level: 1
      target: "cli/"
      pattern: "command|args|keys|models|config|doctor|deploy"

  - id: P-CORE-014
    desc: "桌面应用打包：Electron + 自动更新 + Tray 菜单"
    level: P1
    verify:
      method: grep
      level: 1
      target: "desktop/"
      pattern: "electron|tray|auto-update|main"

  - id: P-CORE-015
    desc: "Anthropic/Gemini 协议映射：请求/响应格式转换、工具调用适配"
    level: P1
    verify:
      method: grep
      level: 1
      target: "providers/"
      pattern: "anthropic|gemini|map|transform"

recommendations:
  - id: R-001
    level: P2
    desc: "存储建议 Prisma Postgres，本地开发可用 SQLite 降级"
    tolerance: medium
    verify:
      method: grep
      level: 1
      target: "db/"
      pattern: "prisma|postgres|sqlite"

  - id: R-002
    level: P2
    desc: "消息队列建议：请求日志异步写入、配额计数异步聚合"
    tolerance: high
    verify:
      method: grep
      level: 1
      target: "services/"
      pattern: "queue|async|batch|worker"

  - id: R-003
    level: P3
    desc: "WebSocket 实时日志推送给仪表盘"
    tolerance: high
    verify:
      method: grep
      level: 1
      target: "routes/"
      pattern: "websocket|ws|sse"

  - id: R-004
    level: P3
    desc: "Prometheus/Grafana 指标导出端点"
    tolerance: high
    verify:
      method: grep
      level: 1
      target: "routes/"
      pattern: "metrics|prometheus"

glossary:
  SmartRouter: "智能路由引擎，基于 Bandit Scoring 从可用 Provider 中选择最优模型并构建 Fallback Chain"
  BanditScoring: "多臂老虎机评分算法，综合 latency_p50(30%) + cost(20%) + quality(30%) + reliability(20%) 计算模型分数"
  FallbackChain: "按评分降序排列的 Provider/Model/Key 备选链，请求失败时自动按顺序重试"
  QuotaEngine: "配额引擎，实现 Sliding Window Log 精确计数 + Token Bucket 平滑限流，支持 RPM/TPM"
  CooldownProbe: "冷却探测，当 Provider 返回 429/5xx 时自动标记进入冷却期，定期探测恢复"
  Fusion: "多模型融合，Panel(默认 4 槽跨平台去重)并行调用 + Judge 合成或 Best-of 选最长，支持 tool_choice 三档"
  Panel: "Fusion 的模型组，从 Fallback Chain 选 K 个模型，先按 Provider 去重再按 Model Family 去重"
  Judge: "Fusion 合成阶段的评判模型，将所有存活回答匿名化后重写为单一答案"
  ProviderAdapter: "统一 Provider 接口抽象，封装 chat/models/test/estimateTokens 等能力，支持 OpenAI/Anthropic/Gemini/Custom 协议"
  FreeModelDetection: "免费模型检测：三级逻辑(白名单优先 → 零定价严格检查 → :free 后缀识别)"
  ClientProfile: "客户端配置档案，包含 API Key、配额限制、模型作用域、优先级策略"
  URLToken: "一次性/有时效的 URL 令牌，用于无需认证的临时调用"

non_functional:
  - metric: "路由决策延迟 P99"
    target: "< 50ms"
    measure: "内部基准测试: node scripts/bench-router.js"
  - metric: "端到端聊天补全延迟 P99 (不含上游)"
    target: "< 200ms"
    measure: "curl -w '%{time_total}' https://openllm.yadinae.deno.net/v1/chat/completions"
  - metric: "配额检查延迟 P99"
    target: "< 10ms"
    measure: "内部基准测试: node scripts/bench-quota.js"
  - metric: "并发请求处理"
    target: "1000 RPS 无降级"
    measure: "locust -f tests/locustfile.py --users 100 --spawn-rate 10"
  - metric: "可用性"
    target: "99.9% (Deno Deploy SLA)"
    measure: "Deno Deploy 监控面板"
  - metric: "数据持久化"
    target: "零数据丢失 (Prisma Postgres 自动备份)"
    measure: "灾难恢复演练: 从备份恢复 < 5min"
  - metric: "部署时间"
    target: "< 3min 单次部署"
    measure: "deno deploy --prod 计时"
  - metric: "回滚时间"
    target: "< 1min"
    measure: "deno deploy rollback 计时"

architecture:
  layers:
    - name: Gateway
      role: "入口层 — Hono 路由、认证、请求验证、CORS"
      path: "routes/"
    - name: CoreEngine
      role: "核心引擎层 — Router/Quota/Fusion/Logging"
      path: "services/"
    - name: ProviderLayer
      role: "提供商适配层 — 统一接口 + 30+ 具体实现"
      path: "providers/"
    - name: DataLayer
      role: "数据持久层 — Prisma Postgres + 加密工具"
      path: "db/"
    - name: Frontend
      role: "管理控制台 — React SPA (dist/ 托管)"
      path: "dist/"
    - name: CLI
      role: "命令行工具 — keys/models/config/doctor/deploy"
      path: "cli/"
    - name: Desktop
      role: "桌面应用 — Electron 打包"
      path: "desktop/"

version: 1.0
---

# DESIGN.md — OpenLLM Deno: FreeLLMAPI 完全替代设计契约

## 🚫 不可违背原则 (Principles)

> 以下原则为 **设计契约**，验收时逐项检查。违背任何 P0-critical 直接 REJECTED。

### P-CORE-001: 智能路由引擎
**约束**: 核心网关必须具备智能路由能力：Bandit Scoring + Fallback Chain + 失败自动重试，而非单一转发。

**验证**: `services/router.ts` 存在 `SmartRouter` 类，包含 `route()`、`select_provider()`、`build_fallback_chain()`、`_calculate_score()` 方法，集成测试通过。

### P-CORE-002: 配额/冷却引擎
**约束**: 配额/冷却引擎必须在请求入口强制执行：RPM/TPM 限制、Sliding Window 计数、Cooldown Probe 自动回退。

**验证**: `services/ratelimit.ts` 存在 `QuotaEngine` 和 `CooldownManager`，`db/pg.ts` 包含 `rate_limit_usage`、`rate_limit_cooldowns` 表。

### P-CORE-003: Fusion 多模型融合
**约束**: Fusion 必须实现 Panel 投票(≥4 槽、去重 provider+family) + Judge 合成 + tool_choice 三档处理。

**验证**: `services/fusion.ts` 存在 `run_fusion()` 和 `FusionConfig`，支持 `k`、`judge`、`strategy`、`panel_selection`，工具调用走 Panel 投票逻辑。

### P-CORE-004: Provider 生态完整
**约束**: 所有 30+ FreeLLMAPI Provider 必须在 OpenLLM 可用，含专用适配器、免费模型检测、定价解析。

**验证**: `providers/` 目录下存在所有 Provider 的适配器实现，通过 `grep` 可匹配到类/接口定义。

### P-CORE-005: 请求日志驱动真实 Analytics
**约束**: 请求日志必须落库并驱动 `/api/analytics` 真实数据，不再返回空值。

**验证**: `services/request-log.ts` 存在 `RequestLogger`，`db/pg.ts` 有 `requests` 表，`/api/observability/*` 返回非零数据。

### P-CORE-006: OpenAI 契约零感知兼容
**约束**: `/v1/chat/completions` 和 `/v1/models` 必须与 FreeLLMAPI 完全一致，下游消费者零感知切换。

**验证**: `tests/contract/` 包含契约测试用例，CI 中跑通。

### P-CORE-007: 内置模型发现自动化
**约束**: Builtin Discovery + Catalog Sync + 定期 Cron + 免费模型白名单更新。

**验证**: `services/catalog-sync.ts` 实现自动同步逻辑，`deno.json` 配置 cron 任务。

### P-CORE-008: 多租户体系真实实现
**约束**: Client Profiles CRUD、Quota 限制/预测、Auth Clients、URL Tokens 必须有真实持久化。

**验证**: `services/client-profiles.ts`、`services/quota.ts` 存在且方法完整，DB 表完备。

### P-CORE-009: Embeddings/Media/Search 核心能力
**约束**: 向量生成、图像/视频/音频生成、联网搜索必须有真实实现。

**验证**: `services/embeddings.ts`、`services/media.ts`、`services/search.ts` 存在核心方法。

### P-CORE-010: MCP 协议支持
**约束**: MCP Server/Client 模式、工具发现、资源访问。

**验证**: `services/mcp.ts` 存在。

### P-CORE-011: 自定义模型全生命周期
**约束**: Register/Sync/Tombstone/Retirement。

**验证**: `services/custom-model-*.ts` 系列文件存在。

### P-CORE-012: 加密轮转与备份恢复
**约束**: 加密密钥轮转脚本和 DB 备份/恢复流程必须存在并可运行。

**验证**: `scripts/rotate-encryption-key.ts`、`scripts/db-backup.ts`、`scripts/db-restore.ts` 存在且可执行。

### P-CORE-013: CLI 工具
**约束**: `openllm` CLI 支持 keys/models/config 生成、doctor 检查、部署命令。

**验证**: `cli/` 目录存在，主入口可运行。

### P-CORE-014: 桌面应用打包
**约束**: Electron + 自动更新 + Tray 菜单。

**验证**: `desktop/` 目录存在，打包脚本可用。

### P-CORE-015: Anthropic/Gemini 协议映射
**约束**: 请求/响应格式转换、工具调用适配。

**验证**: `providers/anthropic-map.ts`、`providers/gemini-map.ts` 存在。

---

## 💡 可偏离建议 (Recommendations)

| ID | 级别 | 建议 | 容忍度 |
|----|------|------|--------|
| R-001 | P2 | 存储建议 Prisma Postgres，本地开发可用 SQLite 降级 | medium |
| R-002 | P2 | 消息队列：请求日志异步写入、配额计数异步聚合 | high |
| R-003 | P3 | WebSocket 实时日志推送给仪表盘 | high |
| R-004 | P3 | Prometheus/Grafana 指标导出端点 | high |

---

## 🏗️ 架构地图

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenLLM Deno                              │
├─────────────────────────────────────────────────────────────────┤
│  Frontend (React SPA)          │  CLI (openllm)  │  Desktop    │
│  dist/                         │  cli/           │  desktop/   │
├─────────────────────────────────────────────────────────────────┤
│                         Gateway Layer (Hono)                     │
│  routes/                                                       │
│  ├─ /v1/chat/completions  ←── CoreEngine.route()               │
│  ├─ /v1/models            ←── ProviderLayer.list_models()      │
│  ├─ /api/* (dashboard)    ←── apiCompat (Phase 0-7)            │
│  └─ /health               ←── DataLayer.health()               │
├─────────────────────────────────────────────────────────────────┤
│                      CoreEngine Layer                            │
│  services/                                                     │
│  ├─ router.ts           SmartRouter (Bandit + Fallback)        │
│  ├─ ratelimit.ts        QuotaEngine + CooldownManager          │
│  ├─ fusion.ts           run_fusion (Panel + Judge)             │
│  ├─ request-log.ts      RequestLogger (async batch write)      │
│  ├─ catalog-sync.ts     BuiltinDiscovery + CatalogSync         │
│  ├─ client-profiles.ts  ClientProfileService                   │
│  ├─ quota.ts            QuotaService                           │
│  ├─ embeddings.ts       EmbeddingService                       │
│  ├─ media.ts            MediaService                           │
│  ├─ search.ts           SearchService                          │
│  ├─ mcp.ts              MCPServer / MCPClient                  │
│  └─ custom-model-*.ts   Register/Sync/Tombstone/Retirement     │
├─────────────────────────────────────────────────────────────────┤
│                    ProviderLayer (统一抽象)                      │
│  providers/                                                    │
│  ├─ types.ts            ProviderAdapter interface              │
│  ├─ openai-compat.ts    OpenAICompatAdapter                    │
│  ├─ anthropic.ts        AnthropicAdapter                       │
│  ├─ gemini.ts           GeminiAdapter                          │
│  ├─ groq.ts             GroqAdapter                            │
│  ├─ openrouter.ts       OpenRouterAdapter                      │
│  ├─ ... (30+ adapters)                                         │
│  └─ index.ts            ProviderRegistry (factory)             │
├─────────────────────────────────────────────────────────────────┤
│                       DataLayer (Postgres)                       │
│  db/                                                           │
│  ├─ pg.ts               Postgres DDL + CRUD                    │
│  ├─ mod.ts              AES-GCM 加解密                         │
│  └─ kv.ts               Deno KV (可选，缓存/会话)               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📋 术语表

| 术语 | 定义 |
|------|------|
| SmartRouter | 智能路由引擎，基于 Bandit Scoring 从可用 Provider 中选择最优模型并构建 Fallback Chain |
| BanditScoring | 多臂老虎机评分算法，综合 latency_p50(30%) + cost(20%) + quality(30%) + reliability(20%) 计算模型分数 |
| FallbackChain | 按评分降序排列的 Provider/Model/Key 备选链，请求失败时自动按顺序重试 (max 3 hops) |
| QuotaEngine | 配额引擎，实现 Sliding Window Log 精确计数 + Token Bucket 平滑限流，支持 RPM/TPM |
| CooldownProbe | 冷却探测，当 Provider 返回 429/5xx 时自动标记进入冷却期，定期探测恢复 |
| Fusion | 多模型融合，Panel(默认 4 槽跨平台去重)并行调用 + Judge 合成或 Best-of 选最长，支持 tool_choice 三档 |
| Panel | Fusion 的模型组，从 Fallback Chain 选 K 个模型，先按 Provider 去重再按 Model Family 去重 |
| Judge | Fusion 合成阶段的评判模型，将所有存活回答匿名化后重写为单一答案 |
| ProviderAdapter | 统一 Provider 接口抽象，封装 chat/models/test/estimateTokens 等能力，支持 OpenAI/Anthropic/Gemini/Custom 协议 |
| FreeModelDetection | 免费模型检测：三级逻辑(白名单优先 → 零定价严格检查 → :free 后缀识别) |
| ClientProfile | 客户端配置档案，包含 API Key、配额限制、模型作用域、优先级策略 |
| URLToken | 一次性/有时效的 URL 令牌，用于无需认证的临时调用 |

---

## 📊 非功能性约束

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 路由决策延迟 P99 | < 50ms | 内部基准测试 |
| 端到端聊天补全延迟 P99 (不含上游) | < 200ms | curl 实测 |
| 配额检查延迟 P99 | < 10ms | 内部基准测试 |
| 并发请求处理 | 1000 RPS 无降级 | locust 负载测试 |
| 可用性 | 99.9% (Deno Deploy SLA) | Deno Deploy 监控 |
| 数据持久化 | 零数据丢失 | 灾难恢复演练 < 5min |
| 部署时间 | < 3min | deno deploy 计时 |
| 回滚时间 | < 1min | deno deploy rollback 计时 |

---

## 📝 变更记录

| 版本 | 日期 | 变更人 | 变更说明 |
|:----:|:----:|:------|:---------|
| v1.0 | 2026-10-18 | Hermes Agent | 初版设计：FreeLLMAPI 完全替代目标，18 周 5 阶段计划 |

---

## 📐 详细技术设计 (实施参考)

### 1. SmartRouter 设计

```typescript
// services/router.ts
export interface RoutingContext {
  request: ChatCompletionRequest;
  availableKeys: DbEntry[];
  clientProfile?: ClientProfile;
}

export interface RoutingDecision {
  provider: ProviderAdapter;
  model: string;
  key: DbEntry;
  fallbackChain: FallbackEntry[];
  metadata: { score: number; reason: string };
}

export class SmartRouter {
  async route(ctx: RoutingContext): Promise<RoutingDecision> {
    // 1. Collect all (provider, model, key) combinations
    const candidates = this.collectCandidates(ctx);
    // 2. Bandit Scoring
    const scored = candidates.map(c => ({
      ...c,
      score: this.calculateScore(c, ctx.clientProfile)
    }));
    // 3. Sort by score desc
    scored.sort((a, b) => b.score - a.score);
    // 4. Top-1 + Fallback Chain
    const primary = scored[0];
    const fallbackChain = scored.slice(1, 4).map(this.toFallbackEntry);
    return {
      provider: primary.provider,
      model: primary.model,
      key: primary.key,
      fallbackChain,
      metadata: { score: primary.score, reason: "bandit-top1" }
    };
  }

  private calculateScore(c: Candidate, profile?: ClientProfile): number {
    const metrics = await this.getMetrics(c.provider.id, c.model);
    const latencyScore = this.normalize(metrics.latencyP50, 0, 5000); // 0-5s
    const costScore = this.normalize(metrics.costPer1k, 0, 10); // $0-10/1k
    const qualityScore = metrics.qualityScore ?? 0.5;
    const reliabilityScore = metrics.successRate ?? 0.9;
    // Weights: latency 30%, cost 20%, quality 30%, reliability 20%
    return 0.3 * (1 - latencyScore) + 0.2 * (1 - costScore) + 0.3 * qualityScore + 0.2 * reliabilityScore;
  }
}
```

### 2. QuotaEngine 设计

```typescript
// services/ratelimit.ts
export class QuotaEngine {
  // Sliding Window Log (精确) + Token Bucket (平滑)
  async checkAndConsume(key: DbEntry, model: string, estTokens: number): Promise<QuotaResult> {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute window
    const windowStart = now - windowMs;

    // 1. Get current usage from rate_limit_usage
    const usage = await this.sql`
      SELECT SUM(tokens) as total_tokens, COUNT(*) as total_requests
      FROM rate_limit_usage
      WHERE platform = ${key.platform} AND model_id = ${model}
        AND key_id = ${key.id} AND created_at_ms >= ${windowStart}
    `;

    const rpm = Number(usage[0]?.total_requests ?? 0);
    const tpm = Number(usage[0]?.total_tokens ?? 0);

    // 2. Check limits (from key config or model defaults)
    const limits = await this.getLimits(key, model);
    if (rpm >= limits.rpm || tpm + estTokens > limits.tpm) {
      return { allowed: false, reason: "quota_exceeded", retryAfter: this.calcRetryAfter(rpm, limits.rpm) };
    }

    // 3. Check cooldown
    const cooldown = await this.getCooldown(key.platform, model, key.id);
    if (cooldown && cooldown.expires_at_ms > now) {
      return { allowed: false, reason: "cooldown", retryAfter: cooldown.expires_at_ms - now };
    }

    return { allowed: true };
  }

  async onResponse(key: DbEntry, model: string, usage: Usage, headers: Headers): Promise<void> {
    // 1. Record usage
    await this.sql`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ${this.sql([
        [key.platform, model, key.id, 'request', 1, Date.now()],
        [key.platform, model, key.id, 'tokens', usage.total_tokens, Date.now()]
      ])}
    `;

    // 2. Detect rate limit headers → trigger cooldown
    const retryAfter = headers.get('retry-after') || headers.get('x-ratelimit-reset');
    if (retryAfter) {
      const expiresAt = Date.now() + parseInt(retryAfter) * 1000;
      await this.setCooldown(key.platform, model, key.id, expiresAt);
    }
  }
}
```

### 3. Fusion 设计

```typescript
// services/fusion.ts
export interface FusionConfig {
  mode: 'auto' | 'synthesize' | 'best_of';
  k: number;                    // panel size (default 4)
  judge: string;                // judge model id
  strategy: 'synthesize' | 'best_of';
  panelSelection: 'diversity' | 'speed' | 'quality';
}

export async function runFusion(
  req: ChatCompletionRequest,
  config: FusionConfig,
  context: RoutingContext
): Promise<ChatCompletionResponse> {
  // 1. Select Panel from Fallback Chain
  const panel = selectPanel(context.fallbackChain, config.k, config.panelSelection);
  // 2. Fan-out with Promise.race + room locking (short-circuit)
  const results = await fanOutWithShortCircuit(panel, req, config);
  // 3. Tool calling: Panel voting
  if (req.tools && req.tool_choice !== 'none') {
    const toolVotes = results.filter(r => r.tool_calls).length;
    const proseVotes = results.filter(r => !r.tool_calls && r.content).length;
    if (toolVotes >= proseVotes) {
      return pickPanelToolCall(results); // majority or tie -> call
    }
    // prose wins -> return best prose
    return bestProse(results);
  }
  // 4. Judge synthesis or best_of
  if (config.strategy === 'synthesize') {
    return await judgeSynthesize(results, config.judge);
  }
  return bestOf(results); // longest response
}
```

### 4. ProviderAdapter 抽象层

```typescript
// providers/types.ts
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly protocol: 'openai' | 'anthropic' | 'gemini' | 'custom';
  readonly baseUrl: string;
  readonly capabilities: ProviderCapabilities;

  chat(req: ChatRequest, key: ApiKey, options?: RequestOptions): Promise<ProviderResult>;
  models(): Promise<Model[]>;
  test(key: ApiKey): Promise<TestResult>;
  estimateTokens(req: ChatRequest): number;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  maxContext: number;
  pricing: PricingModel;
}

// providers/index.ts - Registry
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  getAll(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  getByProtocol(protocol: string): ProviderAdapter[] {
    return this.getAll().filter(a => a.protocol === protocol);
  }
}
```

### 5. 数据库 Schema (关键表)

已在 `db/pg.ts` 定义，核心表：
- `settings` / `app_secrets` - 系统配置与密钥
- `api_keys` - Provider API 密钥
- `discovered_models` - 发现的模型 (含 is_free, price_note, context_window)
- `models` - 智能路由用模型目录 (intelligence_rank, speed_rank, rpm/tpm limits)
- `requests` - 请求日志 (驱动 analytics)
- `rate_limit_usage` - 分钟级滑动窗口计数
- `rate_limit_cooldowns` - 冷却状态
- `fallback_config` / `fallback_routing` - Fallback Chain 配置
- `client_profiles` / `quota_limits` / `quota_usage` / `auth_clients` / `url_tokens` - 多租户
- `server_logs` - 运行日志
- `observability_alerts` - 告警配置

### 6. 部署与运维

```json
// deno.json - 关键配置
{
  "tasks": {
    "deploy": "deno deploy . --json --non-interactive --org yadinae --app openllm --prod",
    "check": "deno check main.ts",
    "test": "deno test -A --unstable-cron"
  },
  "cron": {
    "jobs": [
      { "name": "model-discovery", "schedule": "0 */6 * * *", "path": "/api/cron/discover" },
      { "name": "catalog-sync", "schedule": "0 2 * * 0", "path": "/api/cron/catalog-sync" },
      { "name": "quota-forecast", "schedule": "0 * * * *", "path": "/api/cron/quota-forecast" },
      { "name": "cleanup-logs", "schedule": "0 3 * * *", "path": "/api/cron/cleanup-logs" }
    ]
  }
}
```

---

## ✅ 验收清单 (Definition of Done)

| 类别 | 指标 | 通过标准 |
|------|------|----------|
| **功能平权** | API 契约 | FreeLLMAPI 所有 `/api/*` `/v1/*` 端点同形状同语义 |
| **功能平权** | Provider 覆盖 | 30+ Provider 全部可用，免费模型检测准确率 > 95% |
| **核心能力** | 路由决策 | 同等请求下，路由选择与 FreeLLMAPI 一致 (A/B 对比) |
| **核心能力** | 配额控制 | 单 Key RPM/TPM 不超限，触发冷却自动回退 |
| **核心能力** | Fusion | 多工具调用场景 Panel 投票正确，Judge 合成可用 |
| **观测** | Analytics | `/api/observability/*` 返回真实数据 (非空) |
| **运维** | 部署 | `deno check` 0 error、单次部署 < 3min、回滚 < 1min |
| **性能** | 延迟 | P99 路由决策 < 50ms、端到端不劣于 FreeLLMAPI |
| **稳定性** | 可用性 | 7×24 运行 7 天无人工干预，错误率 < 0.1% |

---

## 🗓️ 实施路线图 (18 周)

| 阶段 | 周数 | 核心交付 | 对应 Principles |
|------|------|----------|-----------------|
| **A: 核心引擎** | 1-6 | Router + Quota + Fusion + Logging + 集成测试 | P-CORE-001, 002, 003, 005, 006 |
| **B: Provider 生态** | 7-10 | 30+ Adapter + 免费检测 + 定价解析 | P-CORE-004 |
| **C: 进阶能力** | 11-14 | Embeddings/Media/Search + MCP + Custom Model + 多租户 + 自动发现 | P-CORE-007, 008, 009, 010, 011 |
| **D: 运维工程化** | 15-16 | CLI + Desktop + 加密轮转/备份 | P-CORE-012, 013, 014 |
| **E: 验收切流** | 17-18 | 全量契约测试 + 蓝绿部署 + 监控告警 | P-CORE-006 + 所有 |

---

**设计文档版本**: v1.0
**最后更新**: 2026-10-18
**状态**: 待评审 → 待实施