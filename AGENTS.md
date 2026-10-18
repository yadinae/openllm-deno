# AGENTS.md — OpenLLM-Deno

AI 网关（Deno Deploy + Hono + Prisma Postgres），FreeLLMAPI 的 Deno 移植版。
线上：https://openllm.yadinae.deno.net

## 笔记位置

本仓库的历史问答与决策记录在 `notes/` 目录：

- `notes/` — 每次重要问答沉淀一篇 `问题 / 权衡 / 结论` 摘要
- 文件命名：`notes/YYYY-MM-DD-<主题slug>.md`
- 索引：`notes/INDEX.md` 按时间倒序列出全部笔记

新会话开始前，如果任务与本项目相关，先读 `notes/INDEX.md`，
再按需读相关笔记，不要依赖模型内置记忆复述已有结论。

## 何时写一篇笔记

一次较长的技术问答结束时（涉及方案选型、踩坑排查、架构决策），
在 `notes/` 新增一篇摘要，正文三段式：

1. **问题** — 当时要解决什么，背景一句话
2. **权衡** — 考虑过的方案与各自的代价
3. **结论** — 最终怎么做、验证结果、遗留风险

结论必须写实际验证过的事实，不写推测。
