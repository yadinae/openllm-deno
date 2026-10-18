# Phase 0: FreeLLMAPI → Deno Deploy (OpenLLM) — 完成

## 已完成
- [x] 品牌重命名：63 文件（源码 + i18n 60 locales），单一事实来源 `src/lib/brand.ts`
- [x] 独立构建区：`~/projects/openllm-web`（不影响上游 freellmapi）
- [x] API 清单彻底对账：185 端点 / 24 前缀 / unmounted 归零（`port/extract_api.py`）
- [x] Discovery 后端：`/api/keys/custom/discover-models`、`/api/keys/discovered-models`
- [x] Model Test 后端：`/api/models/:id/test`（hash lookup → decryptKey → testProvider）
- [x] File-mode fallback：无 DATABASE_URL 时从 data.json 读取（`getAllKeys`、`getAllDiscoveredModels`）
- [x] 修复 `apiKey: ***` 语法错误
- [x] 修复 `db is not defined` 错误

## 线上验证（revision 6pxd0qee1v8s）
| 端点 | 结果 |
|---|---|
| `/health` | `{"ok":true}` |
| `/api/keys` | list [10] |
| `/api/models` | list [581] |
| discover openrouter(keyId=8) | 469 models ✅ |
| discover groq(keyId=4) | 11 models ✅ |
| discover nvidia(keyId=6) | 81 models ✅ |
| discover agnes(keyId=2) | 10 models ✅ |
| test agnes-2.5-flash(hash=1291) | `{"success":true,"latencyMs":8281}` ✅ |

## 待办（Phase 1+）
- 前端集成 Discovery Panel UI（替换 Premium Page）
- 部署 Cron 定时自动发现（可选）
- 端到端测试：前端 → 后端完整链路验证
