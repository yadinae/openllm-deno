# 2026-10-23 · openllm-deno: 22 次 /settings 修复全未上线——真相是部署从未成功

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

## 初判结论（10-23 当时，部分被次日复盘推翻）
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

**遗留风险**（写于 10-23，次日复盘见下）：
- `/settings/*` 仍返回 HTML，真实路由修复未验证（部署通了才能验证）
- `scripts/deploy.ts` 仍需修复：应完全移除 `--org/--app/--non-interactive` 显式传递，仅传 `--prod --token $DENO_DEPLOY_TOKEN`，或改用 `deno task deploy` 让 deno.json 完全托管
- Deno Deploy 的静态文件服务是否拦截 `/settings/*` 仍需部署成功后复核（当前 skip list 逻辑在执行 `cd $staging && deno deploy <staging> ...` 时 deno deploy 自动扫描 deno.json；skip list 逻辑本身在 `app.all("*")` 内部，理论应生效）

---

## 2026-10-24 复盘（实测已验证，部分推翻上文推断）

拿到有效 `DENO_DEPLOY_TOKEN` 后 30 分钟内跑通部署，`/settings/anthropic-map` 立刻返回
`{"map":{"default":"auto","opus":"auto","sonnet":"auto","haiku":"auto"}}`。据此修正三处推断：

1. **路由修复从第一个 commit 起就是对的**——把 `/settings` 加进 SPA catch-all 的
   `path.startsWith("/settings")` skip list 这一版就生效了。之前 21 次"改法"是白折腾：
   线上代码从来没变过，所以怎么改都返回 HTML。**教训：改代码前先证明部署链路通，
   否则所有"修复无效"的结论都不成立。**

2. **`--non-interactive can only occur once` 不是 deno.json 自动注入同名参数**，
   是 `npx -y deno ...` 的包装层导致参数被注入了两次。直接用裸二进制
   `~/.deno/bin/deno` 就没有这问题。`deno deploy --help` 的 usage 是
   `deno deploy [root-path]`——在 staging 目录里 `cd $staging && deno deploy . --prod
   --non-interactive --token $DENO_DEPLOY_TOKEN` 零报错。**别再经 `npx` 起子进程做部署。**

3. **`--org/--app` 确实与 deno.json 冲突，但原因不是"自动注入同名参数"**，
   而是 `deno deploy` 把 root-path 当位置参数，同时又读 deno.json `deploy.org/app`。
   最干净的姿势是：**org/app 完全交给 deno.json，CLI 只传 `--prod --non-interactive
   --token $DENO_DEPLOY_TOKEN`**。

**已落地修复**（commit `5c1e72a`）：`scripts/deploy.ts` 的 `Deno.Command` 改为只传
`["deploy", "--prod", "--non-interactive", "--token", <token>]`，cwd 指向 staging 目录；
不再传 `--org/--app`，不再经 `npx`。两次连续部署（`gb8600e…`、`ak63mhm4…`）均成功。

**可复用规则**：
- 部署失败时**先单独跑一次裸 deploy 命令证明链路通**，再动业务代码。
- **永远不要经 `npx <cli>` 起子进程做关键部署**——npx 包装层会污染 argv，
  表现为诡异的 "option can only occur once"。直接定位并调用裸二进制。
- CLI 报"参数 repeated"先怀疑调用路径被包了一层，而不是配置文件注入。
- 任何"反复修复但线上毫无变化"的场景，第一假设应该是**部署根本没发生**，
  而不是"我的修复方向错了"。