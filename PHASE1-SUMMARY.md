# Phase 1: Discovery Panel UI 集成 — 完成报告

**日期**: 2026-10-17
**Revision**: `tbnsqmtsmneq`
**URL**: https://openllm.yadinae.deno.net

---

## 修复内容

### 1. `idOf()` 原地排序 Bug（严重）
**文件**: `routes/api.ts:53`
**根因**: `all.sort()` 原地修改数组，而 `for...of` 迭代器持有同一引用，导致 keys 列表顺序错乱、重复、缺失。
**修复**: `[...all].sort(...)` 浅拷贝后再排序。

### 2. `registered` 字段硬编码 `false` Bug（严重）
**文件**: `routes/api.ts:166`
**根因**: `/api/keys/custom/discover-models` 对所有模型返回 `registered: false`，前端无法区分已注册/未注册。
**修复**: 查询 DB 中已注册的 model IDs，动态设置 `registered` 字段和 `registeredCount`。

### 3. 腐烂数据清理
**操作**: 通过 `DELETE /api/keys/1` 删除了 PG 中残留的 `handjob_handjob` 平台条目。
**结果**: keys 从 10 恢复到正确的 9 个。

### 4. Cron 自动发现（Deno.cron 原生 API）
**新文件**: `services/cron-discovery.ts`
**修改**: `main.ts` 添加 `Deno.cron("auto-discover", "0 */6 * * *", ...)` 每 6 小时自动 discovery 所有 enabled provider 的模型并持久化到 PG。
**环境变量**: `CRON_SECRET` 已设置（注：`DENO_` 前缀被 Deno Deploy 限制，改用 `CRON_SECRET`）。

---

## E2E 测试结果

| # | 测试项 | 结果 |
|---|--------|------|
| 1 | `/health` | ✅ `{"ok":true}` |
| 2 | `/api/keys` 9 entries 无重复无腐烂 | ✅ |
| 3 | discover agnes `registeredCount` 一致 | ✅ total=10, registeredCount=1 |
| 4 | register → verify via `/api/keys/1` | ✅ model 出现在 key detail 中 |
| 5 | `/v1/models` 377 models | ✅ |
| 6 | test-provider agnes latencyMs=756 | ✅ status=ok |
| 7 | `/api/premium` 返回正确结构 | ✅ |
| 8 | Deno.cron() 注册到 Deno Deploy | ✅ |
| 9 | `CRON_SECRET` env var 已设置 | ✅ |

---

## 遗留项

- **Google API 密钥可能过期**: google 平台 discovery 返回 0 models（HTTP 401），需更新密钥
- **`/cdn-cgi/cron` 被 SPA catch-all 返回 HTML**: 不影响功能（cron 已改用 `Deno.cron()` 原生），但可考虑在 catch-all 中显式 404 该路径以保持干净

---

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `routes/api.ts` | `idOf()` 修复 + `registered` 字段动态计算 |
| `main.ts` | 添加 `Deno.cron()` 注册 + 移除旧 HTTP cron route |
| `services/cron-discovery.ts` | 新增：核心 cron 逻辑 |
| `routes/cron.ts` | 删除（已迁移到 native cron） |
| `deno.json` | 移除 HTTP cron 配置 |
