# FreeLLMAPI ↔ OpenLLM-Deno 功能差距总表 + 对齐排期

> 生成于 2026-10-20。方法：路由/服务模块清单直接 diff + 关键实现逐行核对 + 线上实测。
> 三个并行子代理因 agnes 免费额度 429 全部失败，本文全部结论由我自己取证的命令产出，可复跑。
> 配套：`_cmp-auto-routing.md`（调度机制）、`_cmp-free-detect.md`（免费判定）。

## 规模对比

| 维度 | FreeLLMAPI（原版） | OpenLLM-Deno（移植版） |
|---|---|---|
| server 源文件 | 617 | ~60 |
| 路由模块 | 31 | 18 |
| services 模块 | 46（+compression 子目录） | 18 |
| 路由核心 | `router.ts` **2518 行** + `scoring.ts` 541 行 | `services/router.ts` **622 行**（权重硬编码，无独立 scoring 模块） |
| 融合 | `fusion.ts` 1154 行 | 无 |
| 目录来源 | **签名目录（Ed25519，每半天同步）+ 内置种子 + 迁移审计** | provider `/models` 自动发现 + 一次性种子 |
| 目录实况 | 目录天然只含免费档（准入即过滤） | 893 条 / **0 条有价格** / 537 条是自动发现 |

## 缺失的 services 模块（36 个，按功能域分组）

### A 组：调度智能（auto 表现不一致的直接原因）→ P1
| 模块 | 作用 |
|---|---|
| **scoring** | 4 套策略预设权重 + 高峰时段调整 + 任务类型偏置 + Beta 后验。**移植版没有这个模块，权重硬编码在 router.ts** |
| routing-decision / decision | `decision` 策略：每请求由决策模型从 4 个预设里选一个 |
| provider-quota / quota-forecast / quota-outlook / key-budget | 配额感知路由、余量预测、key 预算 |
| cooldown-probe / model-state / degradation | 冷却到期主动探测、模型状态机、劣化检测 |
| penalty-inspector / model-weight-overrides | 失败惩罚可观测 + 人工权重覆盖 |
| model-listing / model-groups / model-retirement | 模型列表组装、分组、退役 |

### B 组：目录准入（假阳性根源）→ **P0**
| 模块 | 作用 |
|---|---|
| **catalog-sync**（1240 行） | 从 `https://api.freellmapi.co/v1/latest` 拉**签名目录**，Ed25519 验签，篡改即弃 |
| builtin-model-discovery | 内置目录发现，上游报价非 free 即 skip |
| model-discovery | 模型发现 + `priceHintOf()` 字面量价格判定 |
| custom-model-sync / -seed / -register / -tombstone | 自定义模型全生命周期（含墓碑） |
| custom-endpoint / provider-credential / declarative-config | 自定义端点、凭据、声明式配置 |

### C 组：请求管线 → P2
`cache`、`compression/`(整目录)、`context-handoff`、`idempotency`、`request-retention`、`health`、`moderation`、`url-tokens`、`backups`、`profile-models`、`anthropic-map`、`gemini-map`

## 缺失的路由能力

真正**完全没有**的：`decisions`（选路决策审计页）、`free-tier`（免费层配额状态）、`mcp`（MCP server）、`docs`/`openapi.json`、`status`（`livez`/`readyz`/`/v1/providers`/`/v1/quota-forecast`）、`gemini`（`/v1beta/models` 原生协议）、`ollama` 原生面（`/api/chat`、`/api/generate`、`/api/embed`、`/api/tags`、`/api/show`）。

已在 `api.ts`/`dashboard.ts` 里移植、只是没单独成模块的：`settings`、`fallback`、`client-profiles`、`search`、`cache`、`compression`、`conversations`、`logs`、`backups`、`url-tokens`、`update`、`health`。
→ 说明 **HTTP 面大体已对齐，真正的差距在 services 层的深度**，不在端点数量。

移植版独有：`chat`、`dashboard`、`prometheus-metrics`、`rerank`、`transcriptions`、`ws-observability`、`client-classifier`。

## 一个改变最优解的发现

原版目录来自 **`https://api.freellmapi.co/v1/latest` 的签名目录**，而：
- license Bearer 头是**可选**的（`catalog-sync.ts:1027` `if (key) headers.Authorization = ...`），注释写明 "A valid Premium license key (Bearer) gets the **live tier**" ⇒ 无 key 也有免费档目录；
- `electronhub / plugsky / llmtr / inferbase / gizmo / speka / auray / typhoon / router9 / septor / simplellm / moondream` 这批平台在原版 `shared/types.ts` 里标注 **"signed catalog only / no bundled model seeds"** —— 它们**根本没有本地种子**，模型全靠签名目录下发。

⇒ 移植版对这些平台只能靠自己抓 `/models`，而抓回来的东西**没有任何免费性证据**，这正是 `electronhub 631 个免费`、`llmtr 379 个免费`的来源。
⇒ **我们不需要发明免费判定算法，上游已经把判定做完了，我们没接。**

## 排期建议

**P0 — 接签名目录（1 个模块，最高杠杆）**
移植 `catalog-sync.ts`（1240 行含 Ed25519 验签，验签公钥就在原版代码里可照抄）+ 一次性把 `db/model-pricing.ts`（124 条价格）合进种子。
落地后：目录质量由上游策展保证，`free_status` 有了权威来源，**A 组的 auto 问题一大半自动消失**，B 组其余模块重要性下降。
风险：依赖上游服务可用性 —— 需保留"拉不到就用本地快照"的降级路径（原版本来就是这么设计的，`res.status===304` 短路 + 保留已应用版本）。

**P1 — 调度语义对齐**
`scoring.ts` 照搬（三轴 + 4 预设 + 高峰/任务偏置 + Beta 后验）→ 失败惩罚系统（429=降 3 位、失败=1 位、上限 10、**先 dense rank 再加罚**）→ 半衰期 2 天衰减统计替换扁平平均 → 上下文窗口/vision/tools 闸门 + 粘性会话。
撤掉我加的 `FREE_PREFERENCE` 偏置（目录干净后它是多余的，且是对原版的偏离）。

**P2 — 补齐与可见性**
`decisions` 审计页、`free-tier` 状态页、`quota-forecast`/`rate-limit-usage`/`token-usage`、`cooldown-probe`、`summarizeExhaustion` + 恢复倒计时、探索/利用、社区先验、`livez`/`readyz`、MCP。

## P0 前提已实测确认（2026-10-20 12:4x）

**匿名可拉，无需 license key**：
```
GET https://api.freellmapi.co/v1/latest  →  HTTP 200, 525 KB
{ version: "2026.10.19.35633f", tier: "monthly", updated 30 分钟内 }
```
载荷结构：
| 数组 | 条数 | 每条字段 |
|---|---|---|
| `models` | **395** | platform, modelId, displayName, intelligenceRank, speedRank, sizeLabel, `limits{rpm,rpd,tpm,tpd}`, monthlyTokenBudget, contextWindow, enabled, supportsVision, supportsTools, quirks |
| `embeddings` | 29 | family, dimensions, maxInputTokens, quotaLabel |
| `transcriptionModels` | 10 | maxBytes, quotaLabel |
| `searchEngines` | 4 | creditsPerQuery, features |
| `decisionModels` | 2 | contextWindow |
| `quirks` | 92 | slug, title, body, severity, targets（provider 行为怪癖文档） |
| `platforms` | 38 | id, name |

**目录里没有 free/price 字段** —— 与 `_cmp-free-detect.md` 的结论一致：
**目录本身就是免费性的保证，进来的都是免费档。**
⇒ 移植版正确做法是「**只路由目录内的模型**」，而不是再写一套免费判定算法。

### 污染程度（已与目录做键集对比，并排除格式差异假阳性）

```
签名目录 395 条  vs  移植版 893 条
  ├─ 目录内有权威依据         : 353
  └─ 目录里没有（无免费性证据）: 540  (60%)
       其中名称带 :free/-free : 9
       ⇒ 既无目录依据、又无名称标记: 531 条
```

按平台：openrouter 460、nvidia 63、zhipu 11、opencode 4、groq 2。

**已排除键格式假阳性**：对 openrouter 做过 4 种归一（原样/小写/去 `:free`/去 vendor 前缀）后仍有 460/472 对不上。
根因是**性质不同**而非格式不同——签名目录对 openrouter 只策展 **12 条，且全部带 `:free` 后缀**；
移植版是从 OpenRouter `/models` 抓了 472 条整表，其中 **456 条无任何免费标记**，包括
`amazon/nova-pro-v1`、`amazon/nova-premier-v1`、`amazon/nova-lite-v1`、`aion-labs/aion-3.5` —— 这些是明确付费模型。

⇒ `/api/free-models` 页面宣称 openrouter 470 条免费，**实际有证据的约 12–16 条，高估约 30 倍**。

### 白捡清单

目录里有、移植版没有的 **42 条**：xkiro 19、cloudflare 13、google 4、speechify 2、**agnes 2**、cohere 2 …
（`agnes` 在签名目录里是**受认可的平台**，含 `agnes-image-2.0-flash` / `agnes-image-2.1-flash`。）
另可白捡：29 embedding + 10 转录 + 4 搜索引擎 + 2 决策模型 + 92 条 provider quirks 文档。

> ⚠️ 注意：本机 `/home/admin/projects/freellmapi` 源码克隆**落后于上游**（本地源码里没有 agnes/xkiro/speechify 平台，
> 但线上签名目录有）。所以做对齐时**以线上目录为准绳，不要只 diff 本地克隆**。

## 明确不建议做

- `fusion.ts`（1154 行，多模型融合，与"免费自动路由"目标无关）
- `gemini` / `ollama` 原生协议面（除非真有客户端在用）
- 自研免费判定算法：签名目录已是权威判据，重复造只会再制造一套互相矛盾的判据

## 需要你拍板的 3 件事

1. **是否移植签名目录同步**（P0）？这是唯一能一次性解决"目录不干净 + 免费判定无据"的路径；代价是多一个上游依赖（可降级到本地快照）。
2. **P1 调度对齐做多重**？最小集 = scoring 三轴+预设 + 惩罚系统 + 衰减统计；完整集 = 再加配额感知与冷却探测。
3. **现网 893 条目录怎么处置**？建议：先跑一次免费性重判打标 `free_status`，`unknown` 不进 auto（保留显式指定可用），而不是直接删数据。
