# 2026-10-21 · Decision Models (System One typed Q&A) 落地记录

## 背景

FreeLLMAPI 原版在 `services/decision.ts` (460 行) 实现了一个独立的「决策模型」API 面：
- 独立于聊天路由，专门回答结构化问题（choice / noul / score）
- 使用 catalog 中 `decisionModels` 注册的模型（当前 2 个：Cloudflare Clef Flash + OpenRouter Mercury Decide）
- 端点：`GET /api/decisions/models`、`PATCH /api/decisions/models/:id`、`POST /api/decisions/try`、`POST /v1/decisions`
- SPA 有 Models → Decision 标签页，可列表/开关/测试

原版使用 `media_models` 表存储，`modality = 'decision'` 区分。

## 实现

### 1. 数据库
- `media_models` 表已存在，字段完整（`modality`、`meta_json`、`priority`、`enabled`、`quota_label`）
- 新增 `decision_requests` 表（迁移在 `db/pg.ts`）记录每次调用：model_id、platform、key_id、status、latency_ms、question_count、input_tokens、client_agent、error
- Cloudflare key 格式：`account_id:api_token`

### 2. 服务层 `services/decision.ts` (~395 行)
- **类型**：DecisionQuestion(choice/noul/score)、DecisionRequest、DecisionResponse、DecisionError
- **DB**：`allDecisionRows()`、`getDecisionRow()`、`setDecisionEnabled()`
- **Key 加载**：`loadKeysForPlatform()` - 仅加载 healthy+enabled 的 key
- **适配器**：
  - `cloudflare` - Workers AI ai/run 端点，key 格式 `account_id:api_token`
  - `openrouter` - `/api/alpha/decisions` 端点，标准 Bearer key
- **路由**：`decisionChain()` - 支持 `auto`、`model_id`、平台排除
- **执行**：`runDecision()` - 按链路顺序尝试 key，记录日志到 `decision_requests`，失败按状态码冷却
- **同步**：`syncDecisionModels()` - 从 catalog 的 `decisionModels` upsert 到 `media_models`

### 3. API 层 `routes/api.ts`
- `GET /api/decisions/models` - 列表（含 meta 解析）
- `PATCH /api/decisions/models/:id` - 开关（enabled boolean）
- `POST /api/decisions/try` - Dashboard 测试：choice 问题，传 state/question/options
- `POST /api/v1/decisions` - 正式端点：接收 System One 标准体 {state, questions}

### 4. 部署与验证
- 部署：`scripts/deploy.ts --prod` 成功
- 生产验证：
  - `GET /api/decisions/models` 返回 2 个模型（cloudflare/openrouter）
  - `PATCH /api/decisions/models/30` 开关生效，链路正确跳过 disabled
  - `POST /api/decisions/try` 三种题型均通过：
    - choice: `Which database?` → 返回 probabilities + choice
    - score: `Rate 1-10` → 返回 10 选项的分布
    - noul: `Should I deploy? yes/no` → 返回概率分布
  - `POST /api/v1/decisions` System One 标准体成功

## 已知限制
1. **Cloudflare key 格式**要求 `account_id:api_token`，现有 key 可能不符合，需在 Keys 页确认
2. **OpenRouter alpha 端点**可能有速率限制，生产用需监控
3. **未实现**：
   - `noul`/`score` 类型的原生响应解析（现统一用 choice 返回 probabilities）
   - 按 key 的配额/月度预算门控（决策模型复用 chat key）
   - `decision_requests` 的 analytics 面板

## 相关
- `services/decision.ts` (395 行)
- `routes/api.ts` 新增 4 个端点
- `db/pg.ts` 新增 `decision_requests` 表迁移
- `docs/DEVELOPMENT_PLAN.md` P2 标记完成
