# gemini.ts 重复声明导致 warming failed + 空错误体退化成 200 空响应

日期：2026-10-22 ｜ 提交：`21c1b74`、`38490ce` ｜ 线上 revision：`j0vtjcgg1pt0`（routed）

## 问题

两件事同时发生，一开始看起来无关：

1. HEAD（`d6744d1`，10-21 21:51）部署后线上 `/v1beta` 仍"正常"，怀疑没上线；
   `deno check main.ts` 报 4 个错误：`TS2451 Cannot redeclare block-scoped
   variable 'GEMINI_ACTIONS'` + `TS2393 Duplicate function implementation`。
2. `POST /v1beta/models/google/gemini-2.5-flash:generateContent` 返回
   `503 Cannot read properties of undefined (reading 'choices')`；同一模型走
   `/v1/chat/completions` 更糟 —— **HTTP 200 + 0 字节 body**。

## 权衡

| 方案 | 代价 |
|---|---|
| 只在四条原生路由加 `if (!result.response)` 守卫 | 快，但只是把崩溃换成一句笼统错误，真实原因仍被埋 |
| 只修适配器（保证 `error` 永不为空） | 语义正确，但 `c.json(undefined)` 的空 200 仍在 |
| **两层都做 + 修 `mapResponse` 的 usage 命名**（选定） | 改动 6 文件 ~20 行；语义在适配器、纵深防御在路由 |

## 结论（全部实测）

**1. 部署历史是唯一的裁判。** `deno deploy deployments list --org yadinae --app openllm --json`：

```
cs4m9n5gcf5g routed 10-21 21:42:30   ← 昨天的 successful deploy（b7c430b）
wgvx2cjgxq84 failed 10-21 21:47:56 warming  ← HEAD 那次，boot 起不来
```

`routes/gemini.ts` 里 `const GEMINI_ACTIONS` / `matchGeminiAction` 整段重复了一次
（`git show d6744d1:routes/gemini.ts | grep -c '^const GEMINI_ACTIONS'` = 2）。顶层
`const` 重复声明让模块 evaluation 直接 `SyntaxError`，而 `main.ts` import 它 →
整个 app boot 失败。**failed 的部署不会让线上掉线**，Deno Deploy 继续服务上一个
`routed` revision —— 这也是为什么"线上还活着"完全不能当作"HEAD 已上线"的证据。

**2. 空错误体是 falsy。** 上游返回 4xx 且 error body 为空时，四个适配器交出
`{ error: "", status }`。`""` 是 falsy，调用方的 `if (result.error)` 于是放行：

- 原生路由 → 继续执行 `openAIToGemini(result.response)` → 崩在 `undefined.choices`；
- `/v1/chat/completions` → `c.json(undefined)` → **HTTP 200 + 0 字节**。

修复：`providers/{anthropic,gemini,openai-compat,opencode}.ts` 错误体为空时兜底为
`HTTP <status> from <platform> (empty upstream error body)`；`routes/chat.ts` 非流式
尾巴加 `!result.response` → `502 {error:{type,message}}` + 写请求日志；四条原生路由
（gemini/ollama/anthropic/responses）各加一条守卫。ollama 本来就用
`Ollama <status>: <message>` 前缀，不受影响。

**3. `mapResponse` 读 `gemini.usage_metadata.prompt_token_count` 是裸访问。**
Gemini v1beta REST 实际返回 camelCase `usageMetadata`，移植版类型声明的是
snake_case。改成两侧可选链 + `?? 0`，`candidates` 同样加 `?.`。

**4. 验收。**

- `deno check main.ts` → 0 错误（改前 4 个）。
- 回归：`deno test -A --no-check` = **60 passed / 40 failed**，与基线一致；
  用 `git worktree` 跑 HEAD~1 对照，**HEAD 没有新增任何失败用例**，反而多通过一条
  `Health: OpenAICompatAdapter.test() - returns TestResult shape`（正是空错误体兜底修的）。
  40 条失败全是环境性：`DATABASE_URL not set` 与 `localhost:9999 Connection refused`。
- 线上：`autoloop.py` auto ×6 全 OK；`errorshape.py` 3/3 PASS（object 形状 + 真实原因）。
- Gemini 调用不再伪装：`HTTP 404 {"error":{"code":404,"message":"HTTP 404 from google (empty upstream error body)"}}`，
  `/v1` 同模型同样返回 404 + 103 字节结构化错误（原来是 200 空 body）。

## 遗留（未结）

- **google 平台整体不可用**：原生 `:generateContent` 与 `/v1/chat/completions`
  都是 `HTTP 404 from google (empty upstream error body)`。Google 正常错误是带 JSON body 的，
  空 body 的 404 更像 URL 路径拼错 —— GeminiAdapter 拼的是
  `${base_url}/v1beta/models/${model}:generateContent`，若 DB 里 google 行的
  `base_url` 已含 `/v1beta`（FreeLLMAPI 用的是 `/v1beta/openai`）就会双写。
  下一步先看 `GET /api/keys` 里 google 行的 base_url，再决定改数据还是改适配器。
- `routes/chat.ts` 仍有 4 处 `c.json({ error: "字符串" }, ...)`（104/108/219/227 行），
  违反 `{error:{type,message}}` 形状约定，SPA 会渲染成 "unknown error"。本次未动，避免混进这次修复。
- 测试仍需"本地起 :9999 + DATABASE_URL"的一键脚本，40 条集成测试目前没有回归保护。

## 相关

- `notes/2026-10-18-deploy-warmup-boot-failed-gitignore-and-schema-drift.md` — 另一种 warming failed
- `notes/2026-10-21-gemini-native.md` — 原生协议的 Hono catch-all 坑（重复块就是那时留下的）
- 技能 `openllm-deno-maintenance`：新增"部署历史才是裁判 / PAT 只能用 `deno deploy whoami` 校验"和
  "重复顶层 const = warming failed"两条 pitfall
