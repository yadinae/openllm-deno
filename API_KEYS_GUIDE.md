# FreeLLMAPI Deno - API Keys 管理指南

## 当前状态

**API Keys 已配置**: 9 个 provider 的加密密钥已从原 FreeLLMAPI 导入

| ID | Platform | 状态 | Masked Key |
|----|----------|------|------------|
| 1 | google | ✅ enabled | 13c71b83...67eb |
| 2 | groq | ✅ enabled | bc1fe421...4dc0 |
| 3 | radeon | ✅ enabled | b5576d07...2c8f |
| 4 | nvidia | ✅ enabled | fd883657...1906 |
| 5 | openrouter | ✅ enabled | 5d98fcb0...b354 |
| 6 | kilo | ✅ enabled | a0cc6c3a...03c8 |
| 7 | zhipu | ✅ enabled | db6c0bc3...63e4 |
| 8 | opencode | ✅ enabled | d23413a2...db1d |
| 9 | agnes | ✅ enabled | 27037da7...607b |

## 如何更新 API Keys

由于 Deno Deploy 的限制，API Keys 需要**手动更新**：

### 方法 1: 通过 Web 界面（推荐）

1. 访问 http://localhost:9999 或 https://openllm-deno.yadinae.deno.net
2. 点击 "管理 API Keys" 按钮
3. 查看当前 keys 状态

### 方法 2: 通过 API

```bash
# 查看所有 keys
curl http://localhost:9999/api/keys | python3 -m json.tool

# 更新单个 key (需要手动编辑 data.json)
curl -X POST http://localhost:9999/api/keys/2/update \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 方法 3: 手动更新 data.json

1. 下载当前 data.json:
   ```bash
   curl http://localhost:9999/api/keys > keys.json
   ```

2. 编辑 `~/projects/openllm-deno/db/data.json`

3. 重新部署:
   ```bash
   cd ~/projects/openllm-deno
   deno deploy . --org yadinae --app openllm-deno --prod
   ```

## 重要提示

⚠️ **API Keys 是加密存储的**，不能直接编辑明文值。如果需要更新密钥：

1. 从原 FreeLLMAPI (http://8.208.28.70:3001) 导出新的 encrypted_key, iv, auth_tag
2. 替换 data.json 中对应 provider 的字段
3. 重新部署

## 可用端点

- `GET /health` - 健康检查
- `GET /v1/models` - 模型列表
- `POST /v1/chat/completions` - 聊天补全
- `GET /api/keys` - 查看 API Keys 状态
- `GET /` - Dashboard

## 服务地址

- **本地**: http://localhost:9999
- **云端**: https://openllm-deno.yadinae.deno.net