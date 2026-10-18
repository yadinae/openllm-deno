# 2026-10-18 · 线上跑的还是缺端点的旧 revision —— "部署成功"是真的，成功的版本是错的

- **来源会话**：@session:default/20261017_212548_daf34d、@session:default/20261017_232222_b53bb2c3
- **类型**：踩坑排查 / 风险
- **涉及文件**：`routes/api.ts`、`main.ts`、`db/pg.ts`

## 问题

10-17 晚把 FreeLLMAPI 的 Deno 移植版部署到 `https://openllm.yadinae.deno.net` 并做全量端点测试。
当晚重写 `routes/api.ts` 时误删 Phase 0-5 端点（见同目录 2026-10-17 那篇笔记），随后把代码补回。
第二天要回答的问题很朴素：**线上此刻究竟是哪一版、缺什么。**

## 权衡

判断"线上状态"有三种口径，代价和可靠性差别很大：

| 口径 | 得出的结论 | 实测校验 |
|---|---|---|
| 看部署工具返回（`status: "routed"` + revisionId） | "部署成功 = 我的代码已上线" | ❌ 已证伪：routed 的那版里根本没有那 24 个端点 |
| 读本地代码推断线上 | 69 条路由齐全 | ❌ 与线上差 24 条 GET |
| 逐条打真实端点（最终采用） | 37 个 GET → 11×200 / 24×404 / 2×500 | ✅ 约 5 分钟成本 |

同一晚其实已经栽过一次反向的同一个坑 —— 21:36 的记录原话是
「测试发现：Phase 6/7 的新端点返回 404，因为部署版本还是旧的」。修的方向相反，机制完全相同。

## 结论

**实测数据（2026-10-18 09:20，拿本地路由表逐条打线上 GET）**：

- 本地 `routes/api.ts`：69 条路由（37 个 GET）；双 `/api/` 前缀 bug 已修（`api.get("/api/…")` 匹配数 0）；文件 mtime `2026-10-17 23:34`
- 线上同样这 37 个 GET：**11 个 200、24 个 404、2 个 500**（`/api/health`、`/api/health/detailed`）
- 其余：`/health` 200、`/v1/models` 200、`/` 200（SPA 正常）
- 404 的 24 个正好是被误删的 Phase 0-5：`/keys*`、`/models*`、`/fallback*`、`/settings*`、`/media*`、`/embeddings*`、`/search*`、`/scan`、`/quota`
- 200 的那批正好是 Phase 6/7：logs、observability、client-profiles、quota/usage|limits|forecast、auth/clients、url-tokens

⇒ **线上仍是 10-17 23:14 部署的 `d7xeywcztrsf`，也就是"只写了 Phase 6/7"的那次重写；23:34 补回 Phase 0-5 的代码从未上线。**
证据链：最后一次 `deno deploy` 出现在 23:14（会话记录里有 revisionId）；`routes/api.ts` 的 mtime 是 23:34，
即"修好"发生在最后一次部署之后；23:22 那个会话跑到 23:39 撞上工具迭代上限，以
"Cannot Deploy — 环境受限"的报告收尾；grep 全量消息，23:14 之后再无 `deno deploy` 调用。

**顺带核实的一条机制**：`deno check main.ts` 现在仍报 **Found 17 errors**，而部署命令是
`deno deploy . --org yadinae --app openllm --prod --no-check` —— **类型检查对部署完全不设闸**，
类型烂成什么样都能"部署成功"。

**遗留风险（均未解决）**：

1. 线上仍缺 Phase 0-5 的 24 个 GET，Dashboard 的 keys / models / fallback / settings 页必然异常。
2. `/api/health`、`/api/health/detailed` 报 500，**确切异常未知**：deploy token 只能部署，
   调 `api.deno.com` 通用 API 一律 401（本次实测），读不到线上日志。
   代码层面唯一能确认的结构差异：这两个 handler 裸调 `await listApiKeys()`（`routes/api.ts:71`、`348`），
   而 200 的那批走 `listRaw()` → `ensureDb()`，且 `ensureDb()` 是 `try { await initDb() } catch {}` 吞掉异常。
   **"Postgres 连接失败"只是假设，未证实。**
3. `/health/detailed` 里 `database: "connected"` 是**硬编码字面量**，不检测任何东西 —— 这个端点天生会说谎。
4. `dist/` 与 `db/data.json` 都在 `.gitignore` 里：线上 SPA 与初始数据来自部署时上传的本地产物，
   干净 clone 复现不了线上内容（未重新部署验证，因为当前无可用部署路径）。

**可复用规则**：部署验证的判定单位是「端点 × 状态码」，不是部署工具返回的 `status`。
把整份路由表打一遍只要 5 分钟；而"本地已修"与"线上已修"之间能稳稳藏一整晚，
中间每一句"部署成功"都还是真的 —— 它成功上线的恰好是错的那版。
