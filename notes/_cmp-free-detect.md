# 免费模型判定机制对比：原版如何做到不误判 vs 移植版为何满屏假阳性

## 一句话结论

原版 `models` 表**根本没有 free 列**（全服务端 `is_free` 出现 0 次）—— 免费性由**「谁被允许进表」**保证，不是运行时布尔。
移植版反过来：目录随便进，然后在查询时用「没有价格记录」倒推免费，于是 **0/893 有价格 ⇒ 全目录被判免费**。

## 原版判据优先级（可直接照抄的规格）

| 序 | 判据 | 位置 | 语义 |
|---|---|---|---|
| 1 | **签名目录（Ed25519）** | `services/catalog-sync.ts:28,44` | 每半天拉一次签名目录；**签名不符或篡改直接丢弃**（防 CDN 被攻破）。对 `electronhub / plugsky / llmtr / inferbase / gizmo / speka / auray / typhoon / router9 / septor / simplellm / moondream` 这批 **catalog-only 平台**，这是**唯一**模型来源（`shared/types.ts` 注释反复写 "signed catalog only"、"no bundled model seeds"） |
| 2 | **内置发现 + 上游报价即拒** | `services/builtin-model-discovery.ts:238` | 注释原文：*"an upstream that prices a model and says it is not free is skipped"* |
| 3 | **`priceHintOf()` 字面判定** | `services/model-discovery.ts:166-186` | 见下 |
| 4 | **运营者 glob 白名单** | `services/custom-model-sync.ts:43` `customModelSyncFreePatterns()` (#746) | 自定义同步时额外只保留匹配项 |
| 5 | **人工迁移审计** | `db/migrations/20260101_000000_legacy_baseline.ts:1837` `migrateModelsV23FreeTierAudit` | 直接把不再免费的平台**整族删除**（`DELETE FROM models WHERE platform IN ('sambanova','chutes')` 并连带删 fallback_config、api_keys） |

### `priceHintOf()` 的三条硬规则（原版防假阳性的精髓）

```
输入：provider /models 返回体里的 price / pricing 字段（PRICE_KEYS = ['price','pricing']，:78）

① 字符串 → 只认字面量 'free'
   注释原文：「Only the literal word counts as free — never a pattern over the note,
             which is how "$10/M in" ends up painted green.」
② 对象   → pricing.prompt 与 pricing.completion 都是 0 ⇒ free
   （OpenRouter 的 :free slug 就是 {"prompt":"0","completion":"0"}）
③ 认不出 → return undefined  ⇒ 状态是 unknown，**不打标、不当免费**
```

第 ③ 条是移植版最缺的一条。原版第 ⑤ 条还配了一句方法论（V24 迁移注释）：
*"All claims live-probed 2026-06-07 with a real Zen account key through the gateway"*、
*"confirms the **docs-confirmed-only bar**; never added, nothing to remove"* —— **没实测验证过的一律不加进目录**。

## 移植版现状：三套判据并存且互不一致

| 位置 | 判据 | 问题 |
|---|---|---|
| `providers/free-detect.ts` `detectFreeModel()` | Tier1 白名单 → Tier2 严格零价 → Tier3 `:free/-free/_free` 后缀 → 否则 `tier="unknown"` | 逻辑本身没问题，是原版精神的子集 |
| **`services/router.ts` `loadRoutableModels()`** | SQL：`(paid_input_per_m IS NOT NULL AND >0)` 记为 paid，**其余一律 free** | ← **假阳性总根源**。目录 0 条有价格 ⇒ 893 条全部 free |
| `/api/free-models` 端点 | 又一套（走 `detectFreeModel` 遍历） | 与上两者口径不同 ⇒ 页面显示 `groq 0 / nvidia 81 / electronhub 631`，而 router 认为三者都是"全 free" |

三套判据 → 三个答案，这本身就说明缺一个 single source of truth。

## 实测污染（live，2026-10-20）

```
/api/models  : 893 条 = catalog 351 + discovered 537 + user 5
价格记录     : 0 / 893 条 paid_input_per_m > 0
名称带免费标记: 仅 58 条（:free / -free / _free / /free）
疑似付费混入 : 100 条（electronhub/gpt-4.1、electronhub/gemini-2.5-flash、cohere/command-r-plus…）
/api/free-models: openrouter 470 / electronhub 631 / llmtr 379 / nvidia 81 / inferbase 127 / plugsky 38 …
```

`electronhub / plugsky / llmtr / inferbase / gizmo` 在原版是**合法平台**（`shared/types.ts` Platform 联合里有），
但它们**只由签名目录供给模型、原版不捆绑 model seeds**。移植版没有签名目录客户端，
这些平台的模型行是自己 discovery 抓 `/models` 塞进去的 ⇒ 没有任何免费性证据 ⇒ 全被当成免费。

## 消除假阳性要改的 4 处

1. **加 `free_status` 三态列**（`free` / `paid` / `unknown`）到 `models` 与 `discovered_models`。
   默认 `unknown`；**`unknown` 一律不进 auto 候选**（显式指定模型名时仍可用）。
2. **`loadRoutableModels()` 改成只认 `free_status='free'`**，删掉「无价格即免费」的 SQL 推断。
3. **三套判据收敛成一个函数** `isKnownFree(platform, modelId, upstreamPriceRecord)`，
   让 `loadRoutableModels`、`detectFreeModel`、`/api/free-models` 全部调用它。判据顺序照抄原版：
   签名目录/人工目录 → 上游字面 `'free'` → 上游 `pricing` 双 0 → 名称后缀（仅 `:free` 等硬标记）→ 运营者 glob；
   **其余一律 unknown**。移植 `priceHintOf` 时务必保留"只认字面量"的注释与行为。
4. **发现管线加入口闸门**：provider 明确报价且非 free ⇒ **拒收**（现在是无条件 INSERT）。
   价格回填：原版 `db/model-pricing.ts` 有 124 条 paid-equivalent 价，可直接补上移植版 356 条种子中的 **44 条（12%）**；
   剩下 88% 补不上，恰是那些 catalog-only 平台 —— 印证它们本就依赖签名目录，而非本地种子。

> 目录干净后应**撤掉** `FREE_PREFERENCE` 打分偏置：原版没有"给免费加分"这回事，
> 免费优先是目录准入的自然结果。
