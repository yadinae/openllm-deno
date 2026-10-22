#!/usr/bin/env python3
"""把 deno test 的失败分成两类：环境性（没库/没上游）与真回归。

用法: python3 scripts/classify-tests.py /tmp/it-run.log
退出码: 0 = 只有环境性失败, 1 = 存在真回归, 2 = 解析失败
"""
import re
import sys
import collections

ENV_SIGNS = (
    "DATABASE_URL not set",
    "No valid keys",
    "Connection refused",
    "error sending request for url",
    "Requires Postgres",
    "postgres",
    "timed out",
    "Timeout",
)


def strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


def main(path: str) -> int:
    txt = strip_ansi(open(path, encoding="utf-8", errors="replace").read())
    m = re.search(r"(\d+) passed;\s*(\d+) failed", txt)
    if not m:
        m = re.search(r"(\d+) passed / (\d+) failed", txt)
    if not m:
        print("✗ 找不到 test result 汇总行")
        return 2
    passed, failed = int(m.group(1)), int(m.group(2))

    # 失败明细块：`NN) <test name>` 开头，直到下一个 NN) 或分隔线
    tail = txt.split("failures:")[-1]
    blocks = re.split(r"\n\s*\d+\)\s+", tail)[1:]
    env, real = [], []
    for b in blocks:
        name = b.splitlines()[0].strip()
        reason = ""
        for line in b.splitlines()[1:]:
            s = line.strip()
            if s.startswith(("error:", "AssertionError", "TypeError", "ReferenceError")):
                reason = s[:160]
                break
        (env if any(sig in b for sig in ENV_SIGNS) else real).append((name, reason))

    print(f"总计: {passed} passed / {failed} failed")
    print(f"环境性失败（缺 Postgres / 缺上游，非代码问题）: {len(env)}")
    for sig in ("DATABASE_URL not set", "No valid keys", "Connection refused"):
        n = sum(1 for b in blocks if sig in b)
        if n:
            print(f"    · 含 “{sig}”: {n}")
    print(f"真回归（需要修代码或修断言）: {len(real)}")
    groups = collections.Counter()
    for name, reason in real:
        groups[(name.split(":")[0], reason.split(":")[0])] += 1
        print(f"    ✗ {name}\n        {reason}")
    if not real:
        print("  ✓ 没有真回归")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/it-run.log"))
