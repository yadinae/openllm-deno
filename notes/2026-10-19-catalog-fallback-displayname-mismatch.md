# 2026-10-19 · fallback 574 vs catalog 356：缺失 537 模型导致 displayName 退化到 raw modelId

- **来源会话**：@session:default/20261019_205507_595350（用户报"模型列显示 provider 名而非模型名"）
- **类型**：踩坑排查 / 根因
- **涉及文件**：`routes/api.ts`（GET /fallback）、`db/pg.ts`（listCatalogModels）

## 问题

用户发现 OpenLLM 模型管理页面列表中的"模型"列显示的是 provider 名称（如 `groq`、`nvidia`），而非模型的友好名称。SPA 实际用的是 `displayName` 字段，但 537 个 fallback 条目拿到的 `displayName` 就是原始 `modelId`（如 `canopylabs/orpheus-arabic-saudi`），UI 看起来是平台前缀+原始 slug。

## 权衡

| 方案 | 代价 |
|---|---|
| A. 在 `/api/fallback` 返回时从 catalog 补充 displayName | 需额外一次 `listCatalogModels()` 调用 + Map 索引；已实测 ~5ms |
| B. 把 537 个模型全部写入 catalog DB，再改前端展示逻辑 | 批量 SQL 约 537 行，但 `scripts/add_missing_models.ts` 在本地跑不通（DATABASE_URL 只在 Deno Deploy 注入） |
| C. 不改代码，靠手动在 UI 里编辑每个模型的 displayName | 537 次手动操作，不现实 |

选 **A**（后端 enrichment）。同步写了一个 `/admin/sync-catalog` 端点（标记 TEMPORARY）供后续跑一次补录。

## 结论

**根因**：`routes/api.ts:GET /fallback` 原逻辑只合并了 `keyCount`（启用密钥数），没有合并 catalog 的 `displayName` 等元数据。当 fallback 条目在 catalog 无匹配时，SPA 收到 `displayName=modelId`（原始 slug），UI 把 provider 名称误当成模型名展示。

**已落地**：`routes/api.ts` 的 GET /fallback 已加入 catalog enrichment（+83 行，当前未提交）：
- 加载全量 catalog 建 `Map<platform||modelId, CatalogModel>`
- 每个 fallback 条目补充 `displayName` / `intelligenceRank` / `speedRank` / `sizeLabel` / `supportsVision` / `supportsTools` 等字段
- 新增 `POST /admin/sync-catalog` 端点（TEMPORARY 标记）：扫描 fallback-config 中未在 catalog 的条目，用启发式函数生成 displayName 并 INSERT ... ON CONFLICT DO NOTHING

**实测验证**（部署前，live API 状态）：
- fallback 唯一模型数：**574**
- catalog 唯一模型数：**356**
- 缺失（fallback - catalog）：**537**
- 典型症状：`canopylabs/orpheus-arabic-saudi` 的 displayName 仍 = modelId（未修复前）

**待执行**：部署后调用 `POST /admin/sync-catalog` 补录 537 条，或将 `scripts/add_missing_models.ts` 改为直接对 Deno Deploy 运行（需 DATABASE_URL 环境变量）。

**可复用规则**：任何"主数据源有 N 条但关联查询只覆盖 M 条"的场景，**必须确认 miss 分支的降级行为**——`catalogModel?.displayName ?? modelId` 是正确降级，但如果前端把 modelId 直接当展示文本用（而不是把 displayName 作为 fallback），就会看到 provider+slug 这种半成品。写 enrichment 时优先给 display 字段加 `??` 守卫。

**遗留风险**：
- `/admin/sync-catalog` 是临时端点，标记了 TEMPORARY；补录完成后应删除或改名为正式接口
- 启发式 displayName 生成（`generateDisplayName`）对部分长 slug 生成结果质量一般（如 `google/codegemma-1.1-7b` → `Codegemma 1.1 7 B`），可接受但不完美
- 本地开发环境无法直接跑 `scripts/add_missing_models.ts`（DATABASE_URL 仅 Deno Deploy 注入），需走 Deno Deploy 的 edge function 方式
