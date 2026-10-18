#!/usr/bin/env python3
"""Mechanically extract the FreeLLMAPI HTTP API surface -> port/inventory.json

Used as the authoritative porting checklist for the Deno rewrite. Never
hand-maintained: rerun after pulling upstream to see what changed.
"""
import json
import os
import re
import subprocess
import sys
import collections

SERVER = os.path.expanduser("~/projects/freellmapi/server/src")
ROUTES = os.path.join(SERVER, "routes")
OUT = os.path.expanduser("~/projects/openllm-deno/port/inventory.json")

VERBS = ("get", "post", "put", "patch", "delete")

# e.g.  fallbackRouter.get('/routing', (req, res) => {
#       geminiRouter.post(/^\/models\/(.+):generateContent$/, ...
#       router.get('/release', async (req, res) => {
CALL = re.compile(
    r"^(?P<indent>\s*)(?P<router>[A-Za-z][A-Za-z0-9]*)\."
    r"(?P<verb>get|post|put|patch|delete)\(\s*"
    r"(?P<first>(?:'[^']*'|\"[^\"]*\"|/.*?/[a-z]*))\s*,"
)

# app.use('/api/keys', requireAuth, keysRouter)          — middleware between prefix and router
# app.use('/api/keys/export', createAdminRateLimiter(X)) — limiter-only line, no router
# app.use(ollamaRouter)                                  — root-mounted, router owns full paths
# The router is always the LAST argument; middleware may carry one level of parens.
_MOUNT_ARG = r"(?:[^,()]|\([^()]*\))*?"
MOUNT = re.compile(
    r"app\.use\(\s*'(?P<prefix>/[^']*)'\s*,"
    r"(?:\s*" + _MOUNT_ARG + r"\s*,)*"      # zero or more middleware
    r"\s*(?P<ident>[A-Za-z][A-Za-z0-9]*)\s*\)"
)
MOUNT_ROOT = re.compile(r"app\.use\(\s*(?P<ident>[A-Za-z][A-Za-z0-9]*Router)\s*\)")


def grep_routes():
    """Return {file: [(lineno, line)]} for every router verb call."""
    hits = collections.defaultdict(list)
    for fn in sorted(os.listdir(ROUTES)):
        if not fn.endswith(".ts") or fn.endswith(".test.ts"):
            continue
        with open(os.path.join(ROUTES, fn), encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if ".get(" in line or ".post(" in line or ".put(" in line \
                        or ".patch(" in line or ".delete(" in line:
                    m = CALL.match(line)
                    if m and m.group("router").endswith("Router") or (
                            m and m.group("router") == "router"):
                        hits[fn].append((i, line, m))
    return hits


def parse_mounts():
    """Map router identifier -> mount prefix, from app.ts.

    Root-mounted routers (`app.use(ollamaRouter)`) map to "" because the router
    itself carries the full path — reporting them as "unmounted" would be a lie.
    """
    app_ts = os.path.join(SERVER, "app.ts")
    if not os.path.exists(app_ts):
        return {}
    mounts = {}
    root_mounted = set()
    with open(app_ts, encoding="utf-8") as fh:
        text = fh.read()
    for line in text.splitlines():
        m = MOUNT.search(line)
        if m:
            mounts[m.group("ident")] = m.group("prefix")
        else:
            m2 = MOUNT_ROOT.search(line)
            if m2:
                root_mounted.add(m2.group("ident"))
    for ident in root_mounted:
        mounts.setdefault(ident, "")
    return mounts


def _camel(snake: str) -> str:
    """client-profiles -> clientProfiles (file names are kebab, identifiers are camel)."""
    head, *rest = snake.split("-")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def main():
    if not os.path.isdir(ROUTES):
        sys.exit(f"not found: {ROUTES}")
    mounts = parse_mounts()
    hits = grep_routes()

    endpoints, skipped = [], []
    for fn, entries in hits.items():
        base = fn[:-3]  # strip .ts
        candidates = [f"{base}Router", f"{_camel(base)}Router", base, _camel(base)]
        prefix = next((mounts[c] for c in candidates if c in mounts), None)
        if prefix is None:
            prefix = f"~unmounted:{base}"
        prefix = prefix if prefix else "(root)"
        for lineno, line, m in entries:
            first = m.group("first")
            kind = "path"
            if first.startswith("/") and not first.startswith("'/"):
                kind = "regex"
                path = "~REGEX:" + first.strip("/").rstrip("igm ")
            else:
                path = first.strip("'\"")
            endpoints.append({
                "file": base,
                "line": lineno,
                "method": m.group("verb").upper(),
                "mount": prefix,
                "path": path,
                "kind": kind,
                "router_ident": m.group("router"),
            })

    by_mount = collections.Counter(e["mount"] for e in endpoints)
    unmounted = sorted({e["mount"] for e in endpoints if e["mount"].startswith("~")})

    payload = {
        "generated_from": SERVER,
        "total_endpoints": len(endpoints),
        "endpoints": endpoints,
        "mounts": mounts,
        "per_prefix": dict(by_mount.most_common()),
        "unmounted_prefixes": unmounted,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)

    print(f"endpoints: {len(endpoints)}   prefixes: {len(by_mount)}")
    for prefix, n in by_mount.most_common():
        print(f"  {prefix:26s} {n}")
    if unmounted:
        print("\nNOT mounted in app.ts (verify):")
        for u in unmounted:
            print("  " + u)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
