# 2026-10-21 · routing-decision.ts 落地记录

## 背景

FreeLLMAPI 原版有 `decision` 策略 (#1354)：每次请求由一个决策 LLM 从 4 个
bandit 预设（`balanced | smartest | fastest | reliable`）里挑一个，替代运营者
全局配置。这是 `_cmp-auto-routing.md` 里 P2-10 未完成项之一。

## 实现

`services/routing-decision.ts` (~440 行)：

```
DecisionContext  →  buildDecisionPrompt  →  callDecisionModel
                                                  ↓
DECISION_CACHE ← getCacheKey ←──────────  {strategy, reasoning}
```

- **上下文**：messageCount、lastUserMessage、hasTools、hasVision、
  hasReasoning、estimatedTokens。
- **Prompt**：`PRESET_DESCRIPTIONS` 里对每个预设描述"什么任务用它"，让决策模型
  在 JSON 里返回 `{strategy, reasoning}`。
- **缓存**：`Map<string, DecisionCacheEntry>`，key 由 tool/vision/reasoning 标志
  + 长度桶 + last-message hash 组成，TTL 默认 30 min。
- **决策模型调用**：`adapter.chat()` 走 10 s 超时；不设置
  `response_format: json_object`（groq 严格 JSON 模式易失败），改用 system
  prompt + `/\{[\s\S]*\}/` 正则提取。
- **失败降级**：任何一步失败 → `strategy = "balanced"`, `source = "fallback"`，
  不阻塞用户请求。

## 集成点

| 位置 | 改动 |
|---|---|
| `services/router.ts` | `route()` 第一步调 `resolveStrategyForRequest()`，将策略作为参数传给 `calculateScore()`（不存实例字段，避免并发覆盖） |
| `services/router.ts` | `_routed_via.reason` 附带 `strategy=<preset> (<reasoning>)`，主选与 fallback 路径都会写 |
| `routes/chat.ts` | 从 `_routed_via.reason` 提取 `strategy` 传给 `logComplete(..., strategy)`，落到 `requests.strategy` 列 |
| `routes/dashboard.ts` | `/api/settings/routing-decision` GET/PUT + `/cache` GET/DELETE；`/api/settings/routing-strategy` GET/PUT 暴露策略配置 |
| `main.ts` | 启动时 `initDecisionSettings()` 落默认值（默认 disabled，`groq/openai/gpt-oss-20b`） |

## 配置

四个 settings key：
- `routing_decision_enabled` — boolean，默认 false
- `routing_decision_provider` — 默认 `groq`
- `routing_decision_model` — 默认 `openai/gpt-oss-20b`
- `routing_decision_cache_ttl_ms` — 默认 1800000 (😀 min)
- `routing_strategy` — 现有 key；设为 `decision` 才会触发决策路径

## 决策模型选型踩坑

- ❌ `opencode/mimo-v2.6-flash-free` — OpenCode 免费层只能在 OpenCode 客户端
  里用，从 API 调用被拒绝：`OpenCode's free tier can only be used from within
  OpenCode`
- ❌ `agnes-2.0-flash` — 当天服务端过载，返回 500
- ❌ `groq + response_format: json_object` — groq JSON 模式对 prompt 敏感，
  经常 `Failed to generate JSON`
- ✅ `groq/openai/gpt-oss-20b` 无 `response_format` — 有 reasoning_content
  回退路径，纯 prompt 引导能稳定输出 JSON

## 实测（生产，2026-10-21 15:20 UTC+8）

清 cache 后连发两条：
- `"你好啊"` → `_routed_via.reason = "bandit-top1 FREE strategy=fastest
  (简单问候，快速响应) ..."`
  决策模型用中文给出了理由，识别为问候类，选 fastest。
- `"证明 TCP 三次握手不能用两次，讨论 SYN-flood 与 TOFU 语义冲突"` → cache 命中
  `smartest`；primary 命中模型超时后走 fallback，仍然成功返回。

## 已知限制 / 后续

1. **决策模型失败降级到 `balanced`**，不会二次尝试其他模型。若某个 provider
   长时间故障，需要在 PUT `/settings/routing-decision` 里换 provider/model。
2. **Cache 是 isolate 内存级**，Deno Deploy 不同 isolate 之间不共享，冷启动
   第一次请求始终要过决策模型。跨 isolate 共享需要引入 KV / Upstash Redis。
3. **Prompt 里 `availablePresets` 是硬编码的 4 个预设**，如果未来加入新预设要
   同时改这里和 `BANDIT_PRESETS`。
4. **未做的**：决策成本统计（决策模型每请求消耗 ~100 tokens，若流量大需要
   按 provider 单独记一笔 `decision` 类型的 request 记录）。

## 相关

- 前序：`notes/_cmp-auto-routing.md` 对齐清单第 10 项
- 依赖：`services/scoring.ts` `BANDIT_PRESETS`；`providers/*` `chat()`
- 集成：`services/router.ts` `route()` → `resolveStrategyForRequest()` →
  `calculateScore(c, ctx, resolvedStrategy)`
