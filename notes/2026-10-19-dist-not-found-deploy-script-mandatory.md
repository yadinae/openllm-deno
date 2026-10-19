# 2026-10-19 · `dist/ not found` 连发两次：必须用 `scripts/deploy.ts` 部署

- **来源会话**：本次对话（含 2026-10-19 两次部署回滚）
- **类型**：踩坑排查 / 部署规范
- **涉及文件**：`scripts/deploy.ts`、`main.ts`、`.deno/deploy/`（临时目录）

## 问题

OpenLLM Deno 部署到 Deno Deploy 后，前端 SPA 返回 `{"error":"dist/ not found"}`，页面完全打不开。同一错误在一天内连发两次：

| 时间 | 部署方式 | 结果 |
|---|---|---|
| ~08:35 CST | `deno deploy --prod` 直传项目根目录 | ❌ `dist/` 未打包，全站 500 |
| ~08:45 CST | `scripts/deploy.ts --prod`（脚本封装） | ✅ `dist/` 正确打包，全站 200 |

## 权衡

| 方案 | 代价 |
|---|---|
| A. 继续用 `deno deploy --prod`，手动确认 `dist/` 在部署包里 | 每次部署需人工检查 `.deno/deploy/` 临时目录，极易漏 |
| B. 固定使用 `scripts/deploy.ts --prod`（项目自带） | 脚本已内置 `dist/` 复制逻辑，**零额外成本**，一次配置永久生效 |
| C. 改 `main.ts` 用 `Deno.serveStatic` 而非手写 `readFile` | 需改动核心代码、引入不稳定性，治标不治本 |

选 **B**。脚本 `scripts/deploy.ts` 已处理：① 创建临时目录 ② 复制 `dist/` ③ 调用 `deno deploy` 并传入该目录 ④ `--prod` 指定生产环境。

## 结论

**规则：OpenLLM Deno 所有生产部署必须走 `scripts/deploy.ts --prod`，严禁直接 `deno deploy`。**

- `scripts/deploy.ts` 是项目维护的唯一可复现部署入口（参考笔记 `2026-10-18-deploy-reproducible-script-and-postgres-single-source.md`）
- 直接 `deno deploy` 会把项目根目录作为部署包，**不包含构建产物 `dist/`**（除非显式配置 `include`/`exclude`，但项目未配）
- `main.ts:184-221` 手写静态文件服务假设 `Deno.cwd()/dist` 存在，部署包缺 `dist/` 时触发 line 221 返回 `{"error":"dist/ not found"}`

**验证结果（本次修复后）：**
- `/` → 200（SPA 入口）
- `/index.html` → 200
- `/assets/index-*.js` → 200（静态资源）
- `/api/health` → healthy
- `/api/models` → 575 项，574 个有密钥
- `/api/fallback` → 574 项，全部 `keyCount > 0`

**可复用规则：** 带构建产物（`dist/`、`build/`、`out/` 等）的 Deno Deploy 项目，**必须**有封装部署脚本并显式复制产物目录；CI/CD、手动部署均只调用该脚本。无脚本 = 未完成的项目。

## 遗留风险

- 本地 `dist/` 若被误删（`rm -rf dist`），脚本会把空目录打包 → 线上同症状。建议在 `scripts/deploy.ts` 加一行检查：`if (!existsSync(join(Deno.cwd(), "dist"))) throw new Error("dist/ missing, run build first")`。
- 如迁移到其他部署平台（Cloudflare Workers、Vercel 等），需同步建立对应的构建+部署脚本。