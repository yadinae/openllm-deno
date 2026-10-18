# 2026-10-17 · 重写 routes/api.ts 误删 Phase 0-5 端点

- **来源会话**：@session:default/20261017_212548_daf34d
- **类型**：踩坑排查 / 决策
- **涉及文件**：`routes/api.ts`

## 问题

Phase 6/7（观测运维页、客户端/配额/auth）实现完成后，`routes/api.ts` 里
旧代码（Phase 0-5）与新代码混在一起，括号深度 `brace depth = 2` 不匹配，
文件无法解析，服务起不来。需要在当轮内修复。

## 权衡

| 方案 | 代价 |
|---|---|
| 逐步修复（先删孤立代码块，再简化重复路由，分 3 步） | 需要大量 `patch` 编辑；单轮工具调用上限约 50 次，中途耗尽就卡在坏状态 |
| 一次性重写整个 `routes/api.ts` | 一次 `write_file` 搞定，但要重新写出全部端点，漏写就是静默 404 |

当时判断：工具调用预算是硬约束，逐步修复大概率半途而废 → 选重写。
用户拍板："删掉旧的 api.ts 文件，重新创建一个新的。"

## 结论

重写后部署成功（版本 `d7xeywcztrsf`），但**全量端点测试暴露了重写的代价**：
只写了 Phase 6/7，把 Phase 0-5（keys / models / fallback / media / embeddings /
search）全部误删，测试脚本打出成片 `❌ 404`，只能二次重写补回。

**已验证的当前状态**（2026-10-18 复查）：`routes/api.ts` 493 行、69 个路由，
Phase 0-5 的 `/keys`、`/models`、`/models/free`、`/fallback/*`、`/media/*`
端点均已恢复。

**遗留风险（截至 2026-10-18 未解决）**：

1. `https://openllm.yadinae.deno.net/api/health` 返回 `Internal Server Error`，
   线上不健康，尚未定位原因（怀疑 Prisma Postgres 连接）。
2. 本项目此前**完全没有 git 仓库**，只靠 `deno deploy .` 推二进制，
   没有可回滚版本 —— 这也是误删无法 `git checkout` 恢复的直接原因。
   已于 2026-10-18 纳入 `yadinae/openllm-deno`（`dist/`、`.env` 已 gitignore）。

**可复用规则**：对单文件做"整体重写"前，先把端点/导出清单抓成一份基线
（如 `grep -oE '^api\.(get|post|put|delete)\("[^"]*"' routes/api.ts > baseline.txt`），
重写后拿基线逐条比对，再部署。工具调用预算紧不是省略基线的理由 ——
省下的预算会在二次重写时加倍还回来。
