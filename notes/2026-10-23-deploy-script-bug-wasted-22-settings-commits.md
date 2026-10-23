# 2026-10-23 · openllm-deno: deploy.ts 重复参数导致 22 次 /settings 修复全未上线

- **来源会话**：@session:default/20261023_203935_42f85c
- **类型**：踩坑/根因
- **涉及文件**：`scripts/deploy.ts`, `deno.json`, `main.ts`

## 问题
当天 (10-23) 集中精力修复 `/settings/*` 端点返回 HTML 而非 JSON 的问题，累计推了 22 个 fix  commit (48afddb → 8f334ba，16:12–21:38)。每次改完 push 后验证线上仍是 `<!doctype html>`，推测是 Hono 路由匹配 / SPA catch-all / 静态文件中间件拦截，轮番尝试：
- 把 `/settings` 加入 SPA catch-all skip list
- 把 settings 改成 `app.use("/settings/*", ...)` 中间件
- 改成 `app.on()`、`app.all("/settings/*")`
- 写死 inline handler 在 `app.all("*")` 内部
- 移到 `/api/settings/`、`/v1/settings/` 前缀
- 增加 `_deployed: "2026-10-23-v1"` 标记验证代码是否执行

**全部无效**：线上始终返回 HTML，部署标记从未出现。

## 权衡

| 方向 | 尝试次数 | 结果 |
|------|----------|------|
| SPA catch-all skip list | 3 次 (9feac8b, dbc6c0f, f77a3c3) | 无效 |
| 独立 router 挂载 `/settings` | 2 次 (48afddb, 0c22e85) | 无效 |
| 前缀改 `/api/settings/` | 1 次 (b3ef783) | 被 auth middleware 拦截 |
| 前缀改 `/v1/settings/` | 1 次 (fc10bee) | 404 |
| `app.use` / `app.on` / `app.all` 中间件拦截 | 5 次 | 无效 |
| inline handler 在 `app.all("*")` 内部 | 4 次 | 无效 |
| 增加部署标记验证 | 2 次 (2caf73a, 9fb0160) | 标记从未出现在线上响应 |

## 结论
**根因不是路由匹配，是部署脚本本身失效**：

1. `deno.json` 已声明 `"deploy": { "org": "yadinae", "app": "openllm" }`
2. `scripts/deploy.ts` 读取该配置，**又在 CLI 参数里显式传 `--org yadinae --app openllm`**
3. `deno deploy` 读取 `deno.json` 会自动注入相同参数 → **参数重复** → `Option "--org" can only occur once, but was found several times` → exit code 2
4. 后续尝试去掉 `--org/--app` 只传 `--non-interactive --prod`，**同样重复**（`deno deploy` 也会从 `deno.json` 注入 `--non-interactive`）
5. 真实可用姿势：`deno deploy <dir> --prod --token $DENO_DEPLOY_TOKEN`（不带目录参数让 CLI 读 deno.json，或显式传 `--token` 绕过交互）

**实测验证**：
- 直接用 `/home/admin/.deno/bin/deno deploy <staged_dir> --prod --token x` → 仅报错“需交互 token”，**无重复参数错误**
- 通过 `npx -y deno run -A scripts/deploy.ts` 触发的子进程 `Deno.Command(Deno.execPath())` 因 npx 包装层导致参数注入两次
- HEAD 为 9fb0160 (21:29 push)，curl 验证 21:30 仍是 HTML → **22 个 commit 从未真正部署上线**

**遗留风险**：
- `/settings/*` 仍返回 HTML，真实路由修复未验证（部署通了才能验证）
- `scripts/deploy.ts` 仍需修复：应完全移除 `--org/--app/--non-interactive` 显式传递，仅传 `--prod --token $DENO_DEPLOY_TOKEN`，或改用 `deno task deploy` 让 deno.json 完全托管
- Deno Deploy 的静态文件服务是否拦截 `/settings/*` 仍需部署成功后复核（当前 skip list 逻辑在 `app.all("*")` 内部，理论应生效）

**可复用规则**：**部署脚本若读取 `deno.json` 的 `deploy.*` 字段，绝不可在 CLI 里再传同名参数**；`deno deploy` 会自动注入 `deno.json` 的所有 deploy 配置，重复即报错。部署失败时**必须先验证 deploy 命令本身能跑通**，再排查业务代码——否则会在错误假设上浪费数十次 commit。