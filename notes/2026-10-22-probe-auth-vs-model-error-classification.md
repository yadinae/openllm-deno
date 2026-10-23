# 2026-10-22 · Probe 设计重构：auth 校验与模型可用性必须分离

- **来源会话**：@session:default/20261022_194124_492d5e
- **类型**：踩坑/架构决策
- **涉及文件**：`routes/api.ts`（probe 端点）

## 问题

用户反馈 Keys 页 NVIDIA 行：点击"立即检查"图标转圈无反应、状态不变；换了 key 依然显示"1 个问题"。根本原因有两个叠加：

1. **模型 EOL**：探针硬编码 `nvidia/meta/llama-3.3-70b-instruct`，该模型于 2026-08-26 被 NVIDIA 下线（410 Gone），所有 NVIDIA key 的 chat completion 阶段都报模型错误 → 被误判为 key 无效。
2. **设计缺陷**：用具体模型做 chat completion 来验证 key 可用性，本身就存在混淆——"模型不可用"和"key 无效"是两类不同错误，但旧逻辑把它们等同。

## 权衡

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 单阶段 validateKey | 简单、快 | NVIDIA `/models` 返回 200 即使 key 无效，假阴性 |
| B. 单阶段 chat completion（旧方案） | 能同时验证 key + 模型 | 模型 EOL 会误杀整个 platform 的 key；无法区分两类错误 |
| C. 两阶段 + 错误分类（采用） | 分离关注点：Phase 1 验 auth，Phase 2 验功能；按错误类型分级 | 代码复杂度增加；需要维护 probe models 列表 |

## 结论

采用方案 C，分两阶段实现：

- **Phase 1** `validateKey`（auth-level check）：调用 provider 的 `/models` 端点，仅验证 key 是否被接受。
- **Phase 2** chat completion（functional check）：对 Phase 1 的结果做补充验证，但按错误类型分类处理：
  - `401/403/unauthorized/invalid api key/invalid jwt/authentication` → key 无效
  - `"Function not found"/410 Gone/decommissioned/model not found` → key 有效，只是模型不可用，**不标记问题**
  - `429/timeout/network` → 不确定，保留 Phase 1 结论

**实测验证**：
- commit `1685f89` 已提交并推送到 `main`。
- `deno task deploy --no-seed` 部署成功，生产 URL `https://openllm.yadinae.deno.net` HTTP 200 可访问。
- 前端 JS 已更新（`dist/assets/index-DB2wqc1Y.js` 包含新的 `/api/keys/${e}/probe` 调用）。

**遗留风险**：
- `probeModels` map 需要随模型生命周期手动维护；未来某模型下线会导致同类型的假阳性重现。
- 分类正则基于错误消息文本匹配，provider 改错误消息格式可能导致分类失效（未加防御注释，是已知债务）。

**可复用规则**：**当验证一个凭据（key/token）的可用性时，永远不要用一个可能 EOL 的具体资源（模型名）作为探针；先做 auth 层检验，再做功能层检验，并明确区分"凭据无效"和"资源不可用"两类错误。**
