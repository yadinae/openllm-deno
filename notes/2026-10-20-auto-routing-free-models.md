# auto 路由：不是"筛选免费模型"，而是"每个 provider 抓列表头 8 个"

## 问题

用户反馈：auto 功能有问题，应该自动筛选可用的免费模型，而不是随意找几个模型来轮换。
9 个 provider 筛不出几个可用的免费模型；就算全部不可用，聊天窗口也应该给用户反馈错误原因，而不是未知错误。

## 根因（三个缺陷，全部在 `services/router.ts`）

### 1. `auto` 用的是上游列表的**原始顺序**，不是排序后的

```typescript
// services/router.ts:168-169（修复前）
const allModels = await this.getProviderModels(adapter, key.platform);
const models = allModels.slice(0, 8);
```

`getProviderModels` 返回的是 `adapter.models()` 的原始上游响应，**数组顺序是任意的**。
`slice(0, 8)` 取了前 8 个，于是 groq 列表里排在前面的
`canopylabs/orpheus-arabic-saudi`（阿拉伯语 TTS 模型）就成了路由主选。
打分算法完全没用上——它只是把已经选好的 8 个排个序。

线上验证：`auto` 实际返回 `canopylabs/orpheus-arabic-saudi`，
该模型要求接受条款，主选失败后 fallback 链也没救回来，最终返回字符串化 JSON。

### 2. 免费模型从未参与打分

`calculateScore` 里的 `cost_per_1k` 是**常量 0.001**（`services/router.ts:310`），
从未从 `models.paid_input_per_m` 或 `discovered_models.is_free` 读取。
所以免费模型和付费模型在分数上完全平级，`auto` 没有任何理由优先免费模型。

### 3. 错误信息被吞成字符串，前端读不到

`executeWithFallback` 在 fallback 链耗尽时返回 `primaryResult`，
其中 `error` 是上游的**字符串**（如 `{"status":403,"detail":"Authorization failed"}`）。
`routes/chat.ts` 直接 `c.json({ error: res.error })`，
SPA 读 `err.error?.message` → undefined → 显示 `common.unknownError` = "未知错误"。

## 修复

### `services/router.ts`

1. **新增 `loadRoutableModels(platform)`**（替换 `getProviderModels` + `slice(0,8)`）：
   - 从 `models` 表（curated catalog）取，按 `paid_input_per_m IS NULL OR = 0` 排序（免费在前）
   - `discovered_models` 里 `is_free = true` 的行提升/追加为免费
   - 再用 `free-detect-service` 的运行时定价检测确认免费状态
   - 过滤 `NON_CHAT_MODEL_RE`（含 `orpheus|speech|voice`）和 `CLIENT_LOCKED_MODEL_RE`
   - 每个平台 cap 25 个（ranked，不是 head-of-list）

2. **`collectCandidates` 改用 `loadRoutableModels`**：
   - `auto`/`fusion` → 取该平台的 ranked routable models
   - 显式 model → `resolveRequestedModel` 查 catalog，找不到再用 `providerServesModel` 兜底

3. **`Candidate` 增加 `free` 字段**，`calculateScore` 里：
   - `costPer1k = candidate.free ? 0 : m.cost_per_1k`
   - `auto` 时加 `FREE_PREFERENCE = 0.25` 偏置，大于正常分数抖动，保证免费模型优先

4. **`executeWithFallback` 链耗尽时**返回结构化错误：
   ```typescript
   { error: lastError || "No available channel for this request",
     status: primaryResult.status ?? 502,
     provider_metadata: { exhausted_chain: true, attempts: [...] } }
   ```

### `routes/chat.ts`

5. **`auto`/`fusion` 路径**：`res.error` 时返回标准形状 `{ error: { type, message, ... } }`
6. **显式 model 路径**：同上
7. **SSE 错误帧**：`{ error: { type: "server_error", message: String(err) } }`（原为裸字符串）

## 验证

```
auto → model: openai/gpt-oss-20b | reason: bandit-top1 FREE (latency:403ms cost:$0.001/1k quality:0.89 reliability:1)
auto (stream) → 正常输出，选了免费模型
nonexistent-model → {"error":{"type":"invalid_request_error","message":"No available channel for model nonexistent-model..."}}
groq/canopylabs/orpheus-arabic-saudi → {"error":{"type":"invalid_request_error","message":"The model `canopylabs/orpheus-arabic-saudi` requires terms acceptance..."}}
nvidia/01-ai/yi-large → {"error":{"type":"invalid_request_error","message":"Authorization failed"}}
```

- `deno check main.ts` ✅
- 新增 6 个单测全绿（analytics-contract + client-classifier）
- 全量测试：59 passed / 41 failed（全部是环境性失败，与 stash 基线一致）
- 部署 revision `gd25tsdhq9x0`

## 免费判定的数据质量 caveat（重要，未修，需产品决策）

排查中发现**"哪些模型免费"目前没有可靠数据源**，两个来源还互相矛盾：

| 平台 | `/api/free-models` 静态表 | 运行时检测（router 实际用的） | 可信度 |
|---|---|---|---|
| groq | 0 | 41 | 静态表明显漏（gpt-oss-20b 确实免费） |
| zhipu | 0 | 0 | 两者都说没有 |
| nvidia | 81（含 `01-ai/yi-large`、`adept/fuyu-8b`） | 81 | 假阳性，这些不是免费模型 |
| openrouter | 470 | 150 | 静态表把非 `:free` 的也算进来了 |
| electronhub | 631（含 `gpt-3.5-turbo`） | — | 明显假阳性 |

根因：`db/seed/models.json` 里 **`paid_input_per_m` 全部是 `null`**，价格从没 seed 过。
我的 `loadRoutableModels` 里 `free = NOT (paid_input_per_m > 0)`，
于是"没有价格记录"被当成"免费" —— groq 的 41 个免费、nvidia 的 81 个免费都是这么来的。

**为什么现在先不收紧成"必须有明确免费证据"**：收紧后 groq/zhipu 的免费候选会归零，
`auto` 反而选不出免费模型了（比现在更差）。当前实现在证据不足时宁可宽松。

**安全垫**：freeness 只影响排序权重（`FREE_PREFERENCE = 0.25`），**从不做硬过滤**。
所以误判成免费的代价最多是浪费一次尝试，fallback 链会继续往下走，不会卡死。

**建议的正确做法**（待用户拍板）：把"免费"收敛成一个唯一判据函数
`isKnownFree(platform, modelId, price)`，让 `/api/free-models` 页面页面和 router 共用，
判据 = 显式 0 价 OR `discovered_models.is_free` OR 名称标记（`:free`/`-free`/`_free`/`/free`）
OR `free-detect.ts` 白名单 OR ollama 自建，其余一律"未知"（不优先、但仍可兜底）。

## 遗留

- `cost_per_1k` 仍为常量 0.001（非免费模型的价格没从 pricing 表读取）
- `ttfb_ms`、`request_attempts`、价格 seed 暂未完成
- 单会话 token：登录会注销其它设备会话（既有行为，见 10-18 笔记）
- 用户 `yadinae@gmail.com` 仍需在 PostgreSQL 中创建/迁移（当前仅 `admin@openllm.local` 可用）