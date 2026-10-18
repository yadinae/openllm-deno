# FreeLLMAPI Deno Deploy 免费模型检测增强 — Phase 1 总结

## 完成的工作

### 1. 后端增强 (`services/discovery.ts`)
- 新增 `classifyFree()` 函数，实现四级免费模型检测：
  1. **已知白名单优先**：`KNOWN_FREE_MODELS` 字典（来自 awesome-free-llm-apis）
  2. **严格零定价检查**：OpenRouter 风格 `pricing.prompt == 0 && pricing.completion == 0`
  3. **`:free` 后缀识别**：OpenRouter 惯例（如 `model:free`）
  4. **平台启发式规则**：预留扩展点

- 返回字段增强：
  - `isFree?: boolean` — 是否免费
  - `priceNote?: string` — 价格描述（"free" 或 "$X.XXXXXX/M in $Y.YYYYYY/M out"）
  - `contextWindow?: number` — 上下文窗口（已从上游提取）

### 2. 权威数据源
- 参考 https://github.com/mnfst/awesome-free-llm-apis
- 更新 `KNOWN_FREE_MODELS` 白名单：
  ```typescript
  groq: new Set([
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-safeguard-20b",
    "meta-llama/llama-prompt-guard-2-86m",
    "meta-llama/llama-prompt-guard-2-22m",
  ]),
  zhipu: new Set([
    "glm-4.7",
    "glm-4.5",
    "glm-4.6v",
  ]),
  ```

### 3. 前端适配（已存在）
- `discover-models-dialog.tsx` 已支持 `isFree` 和 `priceNote` 字段
- 免费模型显示绿色 badge（`bg-emerald-600/15 text-emerald-700`）
- 价格信息作为 tooltip 显示

### 4. 类型修复 (`db/mod.ts`)
- 修复 `crypto.subtle.importKey` 和 `decrypt` 的 `BufferSource` 类型错误
- 创建 `shared/types.ts` 补全缺失的类型定义

## 当前状态

| Provider | 总模型 | 免费模型 | 检测方式 |
|----------|--------|---------|---------|
| OpenRouter | 470 | 19 | `:free` 后缀 + 白名单 |
| Groq | 11 | 0 → 6（待部署） | 白名单 |
| Zhipu | 11 | 0 → 3（待部署） | 白名单 |
| NVIDIA | 81 | 0 | 无免费模型 |
| Agnes | 10 | 0 | 无免费模型 |

## 部署状态
- 最新成功版本: `f6zh13pfac3q` (10:06 UTC)
- 后续部署因 TypeScript 类型错误失败
- 已修复类型错误，等待部署限流重置后重新部署

## 文件变更清单
1. `services/discovery.ts` — 重写免费模型检测逻辑
2. `db/mod.ts` — 修复 BufferSource 类型错误
3. `shared/types.ts` — 新建，补全类型定义
4. `routes/api.ts` — 无需修改（已支持新字段）

## 下一步
- 等待部署限流重置后重新部署
- 验证 Groq 和 Zhipu 免费模型正确标记
- 考虑添加前端过滤/排序功能（仅显示免费模型）
