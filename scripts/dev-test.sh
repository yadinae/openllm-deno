#!/usr/bin/env bash
# 一键本地集成测试。
#
# 为什么需要它：tests/ 里的 contract / phase-b / phase-c 用例分两类依赖——
#   1) 一个活着的 HTTP 服务（默认 http://localhost:9999，可用 TEST_BASE_URL 覆盖）
#   2) 部分用例直接调 db/pg.ts，需要 DATABASE_URL
# 以前没有一键脚本，结果 40 条用例长期在"必然失败"的状态下被忽略，等于没有回归保护。
#
# 用法：
#   scripts/dev-test.sh              # 起隔离实例 → 跑测试 → 清理
#   scripts/dev-test.sh --keep       # 保留临时目录与服务日志（调试用）
#   scripts/dev-test.sh --foreground # 只起服务不跑测试（Ctrl-C 停），手动 curl
#   PORT=9000 scripts/dev-test.sh
#   DATABASE_URL=postgres://... scripts/dev-test.sh   # 有库时把 pg 用例也跑上
#
# 隔离性：服务从临时目录运行，读写的是 db/data.json 的**副本**，绝不写回仓库；
# 因此测试不会污染生产种子文件（历史上有过这个坑）。
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
DENO=${DENO:-$HOME/.deno/bin/deno}
PORT=${PORT:-9999}
KEEP=0
FOREGROUND=0
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1 ;;
    --foreground) FOREGROUND=1 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done
[ -x "$DENO" ] || { echo "找不到 deno（$DENO）；用 DENO=/path/to/deno 覆盖"; exit 2; }

TMP=$(mktemp -d -t openllm-it-XXXX)
mkdir -p "$TMP/db"
cp "$REPO/db/data.json" "$TMP/db/data.json"

# ENCRYPTION_KEY 必须与 data.json 里加密的 key 一致，否则本地解密全失败
ENC=""
if [ -f "$REPO/.env" ]; then
  ENC=$(grep -m1 '^ENCRYPTION_KEY=' "$REPO/.env" | cut -d= -f2- | tr -d '"')
fi
[ -n "$ENC" ] || { echo "警告: 没有 ENCRYPTION_KEY，涉及上游密钥的用例会失败"; }

port_pids() {
  ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u
}

# A stale instance from an earlier run silently answers the tests instead of the
# freshly built code — every green/red line then describes the WRONG binary.
# Never test against a server we did not start: reclaim the port first.
free_port() {
  local pids
  pids="$(port_pids)"
  [ -n "$pids" ] || return 0
  for p in $pids; do
    echo "端口 $PORT 被 pid=$p 占用（上一次运行留下的实例）— 先杀掉，避免测到旧代码"
    kill -9 "$p" 2>/dev/null
  done
  for _ in $(seq 1 20); do [ -z "$(port_pids)" ] && return 0; sleep 0.25; done
  echo "✗ 无法释放端口 $PORT"; return 1
}

start_server() {
  free_port || return 1
  ( cd "$TMP" && ENCRYPTION_KEY="***" PORT="$PORT" "$DENO" run -A --no-check "$REPO/main.ts" ) \
    >"$TMP/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 80); do
    if curl -fs "http://localhost:$PORT/livez" >/dev/null 2>&1; then return 0; fi
    kill -0 "$SRV" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

cleanup() {
  [ -n "${SRV:-}" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; }
  # The server is a child of a subshell; killing $SRV alone can orphan the real
  # deno process, which then squats on the port for the next run.
  for p in $(port_pids); do kill -9 "$p" 2>/dev/null; done
  if [ "$KEEP" = 1 ]; then
    echo "保留临时目录: $TMP  (服务日志: $TMP/server.log)"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

echo "▶ 启动本地实例 :$PORT（文件 DB 副本，未设置 DATABASE_URL${DATABASE_URL:+ / 已设置 DATABASE_URL}）"
if ! start_server; then
  echo "✗ 服务启动失败，最后 30 行日志："
  tail -30 "$TMP/server.log"
  exit 1
fi
echo "✓ 实例就绪  pid=$SRV  livez=200"

if [ "$FOREGROUND" = 1 ]; then
  echo "── foreground 模式：base_url=http://localhost:$PORT，Ctrl-C 退出 ──"
  wait "$SRV"
  exit 0
fi

echo
echo "▶ deno test（TEST_BASE_URL=http://localhost:$PORT）"
echo
( cd "$REPO" && TEST_BASE_URL="http://localhost:$PORT" "$DENO" test -A --no-check ) 2>&1 \
  | tee "$TMP/test.log" | grep -Ev '^[[:space:]]*$'

RC=${PIPESTATUS[0]}
echo
echo "── 失败原因分类（这才是回归保护的关键：真断言失败必须能和环境性失败区分开）──"
python3 - "$TMP/test.log" <<'PY'
import re, sys
txt = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
txt = re.sub(r'\x1b\[[0-9;]*m', '', txt)
cats = {
    "需要 Postgres（DATABASE_URL 未设置）": txt.count("DATABASE_URL not set"),
    "需要活的本地服务（连接被拒）": txt.count("Connection refused"),
    "上游网络失败": txt.count("error sending request for url"),
}
rows = [l.strip() for l in txt.splitlines() if ' => ./tests/' in l]
summary = re.search(r'(\d+) passed \| (\d+) failed', txt)
print("  用例条目: %d 条失败明细" % len(rows))
for k, v in cats.items():
    if v: print("  %-40s %d 次" % (k, v))
# 不属于以上任何环境性原因的，才是需要人看的
real = []
for blk in txt.split(" ERRORS ")[-1].split("\n\n"):
    head = [l for l in blk.splitlines() if ' => ./tests/' in l]
    if not head: continue
    if any(t in blk for t in ("DATABASE_URL not set", "Connection refused", "error sending request for url")):
        continue
    real.append(head[0].strip())
if real:
    print("\n  ⚠ 需要人工处理的失败（非环境性）%d 条:" % len(real))
    for r in real[:20]: print("     ", r)
else:
    print("\n  ✓ 没有非环境性失败")
if summary:
    print("\n  汇总: %s passed / %s failed" % (summary.group(1), summary.group(2)))
PY
exit "${RC:-1}"
