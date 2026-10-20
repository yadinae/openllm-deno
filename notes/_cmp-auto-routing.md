# auto 调度机制对比：FreeLLMAPI（原版）vs OpenLLM-Deno（移植版）

> 我逐行核对的部分。三个并行子代理因 agnes 免费额度 429 全部失败，免费判定部分我随后自己补齐（见 `_cmp-free-detect.md`），
> 能力面总表见 `_cmp-gap-matrix.md`。
> 原版路径 `/home/admin/projects/freellmapi/server/src`，移植版 `/home/admin/projects/openllm-deno`。

## 一句话结论

原版的 auto 是**「入库时准入 + 库里预排序链路 + 带记忆的多轴 bandit」**三层子系统；
移植版的 auto 是**「每次请求现捞候选 + 一次性静态打分」**。
差的不是一两个参数，是一整套调度子系统。

## 原版架构

### 第 1 层：准入（决定"哪些模型有资格进目录"）

**`router.ts` 里 `is_free` 出现 0 次。** 免费性不是运行时判据，是入库门槛：

| 机制 | 位置 | 作用 |
|---|---|---|
| 签名目录同步 | `services/catalog-sync.ts`（1240 行） | 权威目录 + tier 门禁，"signed catalog 每档都零行"= 该档不可用 |
| 内置发现过滤 | `services/builtin-model-discovery.ts:238` | 注释原文：*"an upstream that prices a model and says it is not free is skipped"* |
| 运营者 glob | `CUSTOM_MODEL_SYNC_FREE_PATTERNS` (#746) | 自定义发现时额外只保留匹配模式 |
| `db/model-pricing.ts` | `MODEL_PRICING` _paid-equivalent_ | **只服务 analytics「估算节省」**，不是免费闸门 |

即：目录里天然只有免费档模型，所以路由器不需要再判免费。

### 第 2 层：链路解析与排序

```
resolveRoutingChain(model)          router.ts:1437
  auto → activeChainOrThrow(db)     ← 库里预排序链路，不是每请求现算
  auto:<profile>                    → getChainByProfileName（按客户端 profile 取链）
  auto:<axis>                       → GLOBAL_SORT_ALIASES → getChainByGlobalSort
orderChain(chain, strategy)         router.ts:1204
  tier 优先（match_tier 永远压过打分）
  → applyReliabilityFloor()         先删长期失败的模型
  → scoreChainEntry()               三轴加权 + Thompson 采样
  → priority 兜底破平手
```

**策略预设**（`services/scoring.ts:49` `BANDIT_PRESETS`，三轴 reliability/speed/intelligence）：

| 策略 | reliability | speed | intelligence |
|---|---|---|---|
| balanced（默认） | 0.50 | 0.25 | 0.25 |
| smartest | 0.35 | 0.10 | 0.55 |
| fastest | 0.35 | 0.55 | 0.10 |
| reliable | 0.70 | 0.15 | 0.15 |

策略全集 7 个（`scoring.ts:36`）：`priority | balanced | smartest | fastest | reliable | custom | decision`。
`custom` = 运营者自存权重向量；`decision` (#1354) = **每请求由决策模型从 4 个预设里选一个**（`routing-decision.ts`）。

### 第 3 层：运行时闸门与自适应（移植版几乎全缺）

| 机制 | 位置 | 要点 |
|---|---|---|
| 失败惩罚 | `recordModelFailure` / `recordRateLimitHit` | 单位是**优先级位次**：429 = 3 位、失败 = 1 位、上限 10；先 dense rank 再加罚（否则大间隔链路上惩罚完全失效，注释 router.ts:1216-1237） |
| 可靠性地板 | `applyReliabilityFloor` (:1167) | `MIN_RELIABILITY_FLOOR` 打分前剔除 |
| 探索/利用 | `EXPLORE_CHANCE=0.1`、`EXPLORE_MIN_SAMPLES=5` | epsilon-greedy |
| Beta 后验 + 社区先验 | `reliabilityPosterior`（`PRIOR_SUCCESS/FAILURE=1`）、`COMMUNITY_PRIOR_MAX_SAMPLES=50` | 无数据的新模型从均匀先验采样，仍能拿到流量 |
| Key 级 bandit | `orderKeysByScore` (:1496) | 权重 reliability .75 / speed .25；无任何数据→退回 round-robin |
| 配额余量 | `getHeadroomThresholds`、`orderKeysByRemainingQuota` (:1548) | `least-remaining` 策略按剩余配额排序；`UNKNOWN_QUOTA_HEADROOM=0.5` 中立；账号级共享池 (`::account`) 明确不适用 |
| 上下文窗口闸门 | `fitsContextWindow`、`CONTEXT_WINDOW_SAFETY_FACTOR=1.25`、`routingReserveTokens`、`OUTPUT_RESERVE_CAP=2000` | 装不下的模型直接跳过 |
| 能力闸门 | `route(..., requireVision, requireTools)` | 带图/带工具请求不落到不支持的模型 |
| 粘性会话 | `preferredModelDbId` | 同一会话优先原模型，防中途换模型导致幻觉 |
| 高峰时段自适应 | `PEAK_SPEED_TO_RELIABILITY=0.6`、默认 18–6 UTC | `fastest`/`reliable` 豁免 |
| 任务类型偏置 | `TASK_WEIGHT_SHARE=0.3` (#1127) | code↔chat 在 speed/intelligence 间挪权重 |
| 衰减统计缓存 | `HALF_LIFE_DAYS=2` | 指数衰减，2 天前的请求算一半；注释明确批评"扁平 7 天窗口会让今天劣化的模型顶着一周旧均值" |
| 实测速度回写 | `writeObservedSpeedRanks`、`SPEED_RANK_MIN_SAMPLES=20` | 观测 tok/s 写回 speed_rank |
| 耗尽可解释性 | `summarizeExhaustion` (:84)、`formatResetEta` (:66) | 全链路失败时给出**原因 + 配额恢复倒计时** |
| 主动恢复 | `cooldown-probe.ts`、`model-state.ts`(428 行) | 冷却到期主动探测，模型状态机 |
| 决策审计 | `routing-decision.ts`、`routes/decisions.ts` | 每次选路决策留痕可查 |

## 移植版现状（`services/router.ts`，622 行）

```typescript
weights = { latency: 0.30, cost: 0.20, quality: 0.30, reliability: 0.20 }  // 4 轴，与原版 3 轴不同构
```

- 每请求 `collectCandidates()` 现捞候选，无 profile / 无策略预设 / 无 `auto:xxx` 变体
- `cost` 轴因 `cost_per_1k` 恒为 `0.001` 而完全失效（已修：免费置 0 + `FREE_PREFERENCE=0.25`）
- 统计是扁平平均，无衰减；无惩罚系统、无配额/headroom、无上下文窗口闸门、无 vision/tools 闸门、无粘性会话、无探索、无社区先验、无决策审计
- **`FREE_PREFERENCE` 打分偏置本身就是一种偏离**：原版没有"给免费加分"这回事，它是把不合格模型挡在目录外

## 实测污染证据（live `/api/models`，2026-10-20）

```
目录总数 893 = catalog 351 + discovered 537 + user 5
有明确付费价格记录：0 / 893          ← paid_input_per_m 全 null
名称带免费标记（:free/-free/_free//free）：仅 58
疑似付费或非聊天模型混入：100
  electronhub/gpt-4.1、electronhub/gemini-2.5-flash、electronhub/gemini-2.5-flash-lite
  cohere/command-r-plus-08-2024、cohere/command-r7b-12-2024 …
平台分布：openrouter 472 / nvidia 81 / electronhub 65 / aihorde 32 / cloudflare 26 …
```

推论链：**0 条价格记录** + 移植版把"无价格"当"免费" ⇒ 893 条全被当免费候选 ⇒
`nvidia 81 个免费`、`electronhub 631 个免费`这些假阳性就是这么来的，
而真正带 `:free` 标记的只有 58 条。**目录本身不干净，路由再怎么调参都是白调。**

## 对齐建议（按优先级）

**P0 — 目录准入（不做这条，auto 永远像随机）**
1. 移植原版的准入语义：`discovered` 入库时，provider 明确报价且非免费 → 拒收；只保留 positively-free（`:free`/`-free`/`_free`/`/free` 后缀 或 provider API 明示 free 或显式 0 价）。
2. 引入 `free_status` 三态列（`free` / `paid` / `unknown`），**`unknown` 默认不进 auto 候选**（可进显式指定）。
3. 一次性清理现存 537 条 discovered：按上述判据重判，付费/非聊天下架。
4. 移植 `db/model-pricing.ts` 的 `MODEL_PRICING`（218 行，纯数据）→ 让"估算节省"和价格判定都有真数据。

**P1 — 调度语义对齐**
5. 三轴权重改成原版 `BANDIT_PRESETS`（reliability/speed/intelligence），策略改成 7 值枚举 + settings 持久化。
6. 失败惩罚系统（429/3 位、失败/1 位、上限 10、**先 dense rank 再加罚**）。
7. 衰减统计缓存（半衰期 2 天）替换扁平平均。
8. 上下文窗口闸门 + vision/tools 能力闸门 + 粘性会话。

**P2 — 增强项**
9. 配额 headroom / `least-remaining` key 选择、`summarizeExhaustion` + 恢复倒计时、探索/利用、社区先验、决策审计页、冷却主动探测。
10. `auto:<profile>` / `auto:<axis>` 变体与 `decision` 策略。

> 注意：P0 落地后应**撤掉** `FREE_PREFERENCE` 打分偏置 —— 目录干净了，免费优先就是自然结果，不需要人为加分。
