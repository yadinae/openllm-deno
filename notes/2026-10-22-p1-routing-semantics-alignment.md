# 2026-10-22 · P1 调度语义对齐：decay-stats 修复 + 能力闸门 + priority 策略 + Sticky + Dashboard scoring API

## 来源

P1 调度语义对齐（`auto`/`fusion` 表现一致性前提）。对比 `freellmapi/server/src/services/router.ts` 实现，移植缺口：
- `computeMetrics` 把 decay 计数归一化 → Beta 后验塌陷
- `collectCandidates` 缺能力闸门
- `priority` 策略 (dense-rank + penalty sink) 缺失
- Sticky 会话缺失
- `/fallback/routing` 返回 `scores: []`（前端模型列表无评分 → 用户直观感知"没有评分数据")

## 关键缺陷：decay 计数归一化

旧 `computeMetrics` 做 `normSuccesses = weightedSuccesses / totalWeight`，存到了 `weighted_successes` 字段。后果：

1. `reliabilityPosterior(normSuccesses≈0.95, normFailures≈0.05, prior)` → alpha≈2, beta≈2 → 后验 ≈ 0.5，**所有模型信赖度相同**。
2. `totalSamples = 0.95 + 0.05 ≈ 1.0` 恒 < `EXPLORE_MIN_SAMPLES`(5) → 探索奖励永远触发在每个候选上。
3. `success_rate` 因意外算对 (ratio 稳定) 而掩盖了上面两个 bug，误判为"评分系统工作中"。

**修复**：存 RAW 衰减伪计数 `Σ decay·success`。验证：50 success/0 failure → expected reliability > 0.9（而非 ≈0.5）。

## 端口清单 (services/router.ts + routes/api.ts)

| 语义 | 原版 | 移植 (P0+P1) | 验证 |
|------|------|--------------|------|
| 三轴 BANDIT_PRESETS (reliability/speed/intelligence) | 0.55/0.25/0.25 起草权重 | `scoring.ts` 完成 | deno check |
| Beta posterior + Thompson sample | sampleBeta(α,β) | `reliabilityPosterior`+`sampleBeta` | — |
| 探索 (epsilon-greedy, EXPLORE_MIN_SAMPLES) | <5 → bonus | 单次 `calculateScore` | — |
| 衰减半衰 (2 天) + raw pseudo-counts | Σ decay·count | `computeMetrics` 修复 | — |
| 吞吐 = 比率的比率 | Σ(w·out)/Σ(w·lat) | 修复 | — |
| reliability floor + 冷启动保活 | <MIN_SAMPLES 保留 | `expectedReliability` 守卫 | — |
| monthly headroom | parseBudget(标签)×keyCount vs used | 驱动 | `parseBudget` 单元测试 |
| window headroom | rpm/rpd/tpm/tpd used vs limit | `windowUsedFraction` | 单元测试 |
| 失败惩罚 | 429+3/fail+1/max10 | `rateLimitFactor(penalty)` 独立轴 | — |
| priority 策略 | denseRank(priority)+penalty ASC | port | — |
| vision/tools 上下文 tpm 闸门 | hard gate | `collectCandidates` | 单元测试 |
| margin (1.25×) | soft reorder | `route()` | 单元测试 |
| Sticky 会话 | 30min TTL | `getStickyModel`/`setStickyModel` | 单元测试 |
| Dashboard scoring API | GET `/fallback/routing` 返回确定性 scores[] | port + PUT 持久化 | OpenAPI/live |

## 额外修复

- `cost_per_1k` 暂位 `0.001` → 从 `paid_input_per_m`/`paid_output_per_m` 读实价（`model-pricing.ts` 移植）。
- `metadata.reason` 改为 `bandit-top1`/`priority-top1` + 轴度透传 (`tok/s`/`penalyy`/`$/1k`)。
- `getRoutingScores()` 覆盖全 catalog（左联 `fallback_config`），deterministic path。

## 风险 / 已知债务

- TTFB 无列（requests 表无 `ttfb_ms`） — 仍用 `latency*0.1` 代理，已加注释。
- `keySelectionStrategy` 暴露在设置但 `least-remaining` 未实现 selectKeyForModel 层（quotaHeadroom bias 等价替代）。
- Sticky 依赖 `X-Session-Id` 头或 sha1 fallback；gateway 线程已加。
- 认证墙阻止匿名验证 `/api/fallback/routing` — 依赖单元测试 (11/11 pass) + deno check + live `/v1/models` 200。

## 验收

```
deno check main.ts services/router.ts services/scoring.ts routes/api.ts  → ok
deno test tests/scoring-p1.test.ts --allow-all                          → 11 passed
curl https://openllm.yadinae.deno.net/v1/models                         → 915 models (catalog)
```
