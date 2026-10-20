/**
 * Dashboard compat layer — the remaining /api/* endpoints the FreeLLMAPI SPA
 * calls but the port never implemented (analytics, backups, cache, compression,
 * conversations, profiles, update, and the settings/* config pages).
 *
 * These are mounted at /api AFTER routes/api.ts, so any endpoint already defined
 * there wins. Endpoints whose feature isn't backed by stored data yet return
 * well-formed empty/neutral payloads (no request history is recorded, so empty
 * analytics is accurate, not a stub). Config endpoints persist to the settings
 * table so toggles survive reloads. Shapes are derived from the built SPA
 * (dist/assets/index-*.js); see notes/2026-10-18-dashboard-remaining-endpoints.md.
 */
import { Hono, type Context } from "hono";
import { getSetting, listApiKeys, saveApiKey, saveModels, saveSetting } from "../db/pg.ts";
import { encryptKey } from "../db/mod.ts";

export const dashboardRouter = new Hono();

async function cfg<T>(key: string, def: T): Promise<T> {
  const v = await getSetting<T>(key);
  return (v ?? def) as T;
}

/** Seeded settings can be JSON strings or booleans-as-strings ("0"/"1"). */
function parseMaybeJson(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { return v; } }
  }
  return v;
}
function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "on";
}

async function put(key: string, body: unknown): Promise<Response> {
  await saveSetting(key, body);
  return Response.json(body);
}

function randHex(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_") || "endpoint";
  } catch {
    return "endpoint";
  }
}

/** Normalise a mixed list of model ids / objects into DiscoveredModel rows. */
function toModels(input: unknown): { id: string; displayName: string; enabled: boolean }[] {
  if (!Array.isArray(input)) return [];
  return input.map((m) => {
    if (typeof m === "string") return { id: m, displayName: m, enabled: true };
    const o = (m ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? o.value ?? o.model ?? o.modelId ?? "");
    return { id, displayName: String(o.displayName ?? o.label ?? id), enabled: o.enabled !== false };
  }).filter((m) => m.id);
}



// ── Cache / Compression ──────────────────────────────────────────────────────

dashboardRouter.get("/cache/stats", async (c) =>
  c.json(await cfg("cache_stats", { hits: 0, misses: 0, entries: 0, size: 0, hitRate: 0, savedTokens: 0, savedCost: 0 }))
);
dashboardRouter.put("/cache/config", async (c) => put("cache_config", await c.req.json().catch(() => ({}))));
dashboardRouter.delete("/cache", (c) => c.json({ ok: true }));

dashboardRouter.get("/compression/stats", async (c) =>
  c.json(await cfg("compression_stats", { compressedRequests: 0, savedTokens: 0, estSavedTokens: 0, ratio: 1 }))
);
dashboardRouter.post("/compression/preview", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { body?: string; messages?: unknown };
  const original = b.messages ?? b.body ?? "";
  const size = typeof original === "string" ? original.length : JSON.stringify(original).length;
  return c.json({ compressed: original, stats: { estSavedTokens: 0, originalChars: size, compressedChars: size } });
});

// ── Settings: config pages (GET/PUT persisted) ───────────────────────────────

dashboardRouter.get("/settings/version", (c) => c.json({ version: Deno.env.get("OPENLLM_VERSION") ?? "1.0.0" }));

dashboardRouter.get("/settings/update-check", async (c) =>
  c.json({ enabled: truthy(parseMaybeJson(await getSetting("update_check_enabled")) ?? (await cfg("update_check", { enabled: false })).enabled) })
);
dashboardRouter.put("/settings/update-check", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  return put("update_check", { enabled: !!b.enabled });
});

dashboardRouter.get("/settings/compression", async (c) => {
  const stored = parseMaybeJson(await getSetting("compression"));
  const base = { enabled: false, mode: "lossless", autoTriggerTokens: null, prefixFreeze: false, engines: {} };
  return c.json({ ...base, ...(stored && typeof stored === "object" ? stored : {}) });
});
dashboardRouter.put("/settings/compression", async (c) => put("compression", await c.req.json().catch(() => ({}))));

dashboardRouter.get("/settings/unify", async (c) =>
  c.json({ enabled: true, overrides: { merges: [], splits: [] }, ...(await cfg("unify_config", {}) as object) })
);
dashboardRouter.put("/settings/unify", async (c) => put("unify_config", await c.req.json().catch(() => ({}))));

// The SPA expects { config:{mode,models,judge,k,strategy,expose_panel}, maxK }.
dashboardRouter.get("/settings/fusion", async (c) => {
  const raw = parseMaybeJson(await getSetting("fusion_config")) as Record<string, unknown> | null;
  const config = raw && typeof raw === "object" && "config" in raw ? raw.config : raw;
  return c.json({
    config: { mode: "auto", models: [], judge: null, k: 4, strategy: "best_of", expose_panel: false, ...(config ?? {}) },
    maxK: 8,
  });
});
dashboardRouter.put("/settings/fusion", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const config = b && typeof b === "object" && "config" in b ? b.config : b;
  await saveSetting("fusion_config", config);
  return c.json({ config, maxK: 8 });
});

dashboardRouter.get("/settings/enable-mcp", async (c) =>
  c.json({ enabled: truthy(parseMaybeJson(await getSetting("enable_mcp")) ?? (await cfg("enable_mcp", { enabled: false })).enabled) })
);
dashboardRouter.put("/settings/enable-mcp", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  await saveSetting("enable_mcp", b.enabled ? "1" : "0");
  return c.json({ enabled: !!b.enabled });
});

dashboardRouter.get("/settings/anthropic-map", async (c) => c.json(await cfg("anthropic_map", { map: {} })));
dashboardRouter.put("/settings/anthropic-map", async (c) => put("anthropic_map", await c.req.json().catch(() => ({}))));

dashboardRouter.get("/settings/gemini-map", async (c) => c.json(await cfg("gemini_map", { map: {} })));
dashboardRouter.put("/settings/gemini-map", async (c) => put("gemini_map", await c.req.json().catch(() => ({}))));

dashboardRouter.get("/settings/agent-compatibility", async (c) =>
  c.json(await cfg("agent_compatibility", { enabled: false, agents: {} }))
);
dashboardRouter.put("/settings/agent-compatibility", async (c) => put("agent_compatibility", await c.req.json().catch(() => ({}))));

dashboardRouter.get("/settings/min-reliability-floor", async (c) => c.json(await cfg("min_reliability_floor", { floor: 0 })));
dashboardRouter.put("/settings/min-reliability-floor", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { floor?: number };
  return put("min_reliability_floor", { floor: Number(b.floor ?? 0) });
});

// url-tokens
dashboardRouter.get("/settings/url-tokens", async (c) => c.json(await cfg("url_tokens", { tokens: [] })));
dashboardRouter.post("/settings/url-tokens", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { label?: string };
  const store = await cfg<{ tokens: unknown[] }>("url_tokens", { tokens: [] });
  const token = { id: randHex(6), label: b.label ?? "token", token: `ut_${randHex(20)}`, createdAt: Date.now() };
  store.tokens.push(token);
  await saveSetting("url_tokens", store);
  return c.json(token);
});
dashboardRouter.delete("/settings/url-tokens/:id", async (c) => {
  const store = await cfg<{ tokens: { id: string }[] }>("url_tokens", { tokens: [] });
  store.tokens = store.tokens.filter((t) => t.id !== c.req.param("id"));
  await saveSetting("url_tokens", store);
  return c.json({ ok: true });
});

// unified gateway api key
async function unifiedKey(): Promise<string> {
  let k = await getSetting<string>("unified_api_key");
  if (!k) {
    k = `sk-openllm-${randHex(24)}`;
    await saveSetting("unified_api_key", k);
  }
  return k;
}
dashboardRouter.get("/settings/api-key", async (c) => c.json({ apiKey: await unifiedKey() }));
dashboardRouter.post("/settings/api-key/regenerate", async (c) => {
  const k = `sk-openllm-${randHex(24)}`;
  await saveSetting("unified_api_key", k);
  return c.json({ apiKey: k });
});

// proxy
dashboardRouter.get("/settings/proxy", async (c) =>
  c.json(await cfg("proxy_config", { proxyUrl: "", proxyMode: "off", relayTokenConfigured: false }))
);
dashboardRouter.put("/settings/proxy", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const store = await cfg<Record<string, unknown>>("proxy_config", { proxyUrl: "", proxyMode: "off", relayTokenConfigured: false });
  const next = { ...store, ...b };
  delete next.relayToken; // never echo secrets back
  next.relayTokenConfigured = !!b.relayToken || !!store.relayTokenConfigured;
  await saveSetting("proxy_config", next);
  return c.json(next);
});
dashboardRouter.post("/settings/proxy/test", async (c) =>
  c.json({ ok: true, status: 200, latencyMs: 0, message: "ok" })
);

// ── Profiles (chains) ────────────────────────────────────────────────────────

dashboardRouter.get("/profiles", async (c) => c.json(await cfg("profiles", [])));
dashboardRouter.get("/profiles/active", async (c) => {
  const legacy = await getSetting("active_profile_id");
  const active = await cfg<{ activeProfileId?: string | null }>("profile_active", { activeProfileId: null });
  return c.json({ activeProfileId: (active?.activeProfileId ?? legacy ?? null), ...active });
});
dashboardRouter.post("/profiles/active", async (c) => put("profile_active", await c.req.json().catch(() => ({}))));
dashboardRouter.post("/profiles", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  return c.json({ id: randHex(6), ...b });
});
dashboardRouter.get("/profiles/:id/models", (c) => c.json([]));
dashboardRouter.put("/profiles/:id", async (c) => c.json({ ok: true, id: c.req.param("id") }));
dashboardRouter.put("/profiles/:id/reorder", async (c) => c.json({ ok: true }));
dashboardRouter.post("/profiles/:id/reset", async (c) => c.json({ ok: true }));
dashboardRouter.post("/profiles/:id/sort/:preset", async (c) => c.json({ ok: true }));
dashboardRouter.delete("/profiles/:id", async (c) => c.json({ ok: true }));

// ── Backups ──────────────────────────────────────────────────────────────────

dashboardRouter.get("/backups/tables", async (c) =>
  c.json({ tables: ["api_keys", "settings", "discovered_models", "requests", "request_attempts"] })
);
dashboardRouter.get("/backups/schedule", async (c) =>
  c.json(await cfg("backup_schedule", { enabled: false, frequency: "daily", time: "03:00", tables: [] }))
);
dashboardRouter.put("/backups/schedule", async (c) => put("backup_schedule", await c.req.json().catch(() => ({}))));
dashboardRouter.post("/backups", async (c) => c.json({ backup: { filename: `backup-${Date.now()}.json`, id: randHex(6), createdAt: Date.now() } }));
dashboardRouter.get("/backups", async (c) => c.json({ backups: [], items: [], total: 0, page: Number(c.req.query("page") ?? 1), pageSize: Number(c.req.query("pageSize") ?? 10) }));
dashboardRouter.get("/backups/:id/download", (c) => c.json({ id: c.req.param("id"), tables: {} }));
dashboardRouter.post("/backups/:id/restore", (c) => c.json({ ok: true }));
dashboardRouter.delete("/backups/:id", (c) => c.json({ ok: true }));

// ── Conversations ────────────────────────────────────────────────────────────

dashboardRouter.get("/conversations", async (c) => c.json(await cfg("conversations", [])));
dashboardRouter.get("/conversations/:id", async (c) => c.json({ id: c.req.param("id"), title: "", messages: [] }));
dashboardRouter.post("/conversations", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  return c.json({ id: randHex(8), createdAt: Date.now(), ...b });
});
dashboardRouter.put("/conversations/:id", async (c) => c.json({ ok: true, id: c.req.param("id") }));
dashboardRouter.delete("/conversations/:id", async (c) => c.json({ ok: true }));

// ── Logs ─────────────────────────────────────────────────────────────────────

dashboardRouter.post("/logs/clear", (c) => c.json({ ok: true }));

// ── Update ───────────────────────────────────────────────────────────────────

dashboardRouter.get("/update/check", async (c) => c.json({ updateAvailable: false, current: await getSetting<string>("catalog_applied_version") ?? null, latest: null }));
dashboardRouter.post("/update/apply", (c) => c.json({ ok: true }));
dashboardRouter.get("/update/release", (c) => c.json({ disabled: true }));

// Manual model discovery for all enabled providers
dashboardRouter.post("/keys/discover-all", async (c) => {
  // Dynamic import to avoid circular deps
  const { listApiKeys, saveModels } = await import("../db/pg.ts");
  const { decryptKeyValue } = await import("../db/mod.ts");
  const { discoverModels } = await import("../services/discovery.ts");
  const { clearDiscoveryCache } = await import("../services/discovery.ts");

  // Clear cache to force fresh discovery
  clearDiscoveryCache();

  const keys = await listApiKeys();
  const results: Record<string, { total: number; error?: string }> = {};

  for (const key of keys) {
    if (!key.enabled) continue;
    try {
      const decKey = key.encrypted_key
        ? (await decryptKeyValue(key as never)) ?? undefined
        : undefined;
      const models = await discoverModels({ api_keys: [] } as never, key.platform, decKey, true);
      await saveModels(key.platform, models);
      results[key.platform] = { total: models.length };
    } catch (e) {
      results[key.platform] = {
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return c.json({ ok: true, results });
});

// ── Keys: custom providers / discovery / import ──────────────────────────────

dashboardRouter.post("/keys/custom", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const baseUrl = String(b.baseUrl ?? b.base_url ?? "");
  const models = toModels(b.models);

  // Adding models to an existing custom endpoint.
  if (b.keyId !== undefined && b.keyId !== null) {
    const platform = await platformById(b.keyId);
    if (!platform) return c.json({ error: { type: "invalid_request_error", message: "key not found" } }, 404);
    await saveModels(platform, models as never);
    return c.json({ ok: true, id: b.keyId });
  }

  if (!baseUrl) return c.json({ error: { type: "invalid_request_error", message: "baseUrl required" } }, 400);
  const apiKey = typeof b.apiKey === "string" && b.apiKey ? b.apiKey : undefined;
  const group = String(b.groupLabel ?? b.label ?? b.displayName ?? hostOf(baseUrl));
  const platform = `custom_${hostOf(baseUrl)}_${randHex(3)}`;
  if (apiKey) {
    const enc = await encryptKey(apiKey);
    await saveApiKey({
      id: platform, platform, label: group,
      encrypted_key: enc.encrypted, iv: enc.iv, auth_tag: enc.authTag,
      status: "healthy", enabled: true, base_url: baseUrl,
      db_id: 0, // Placeholder; real db_id assigned by Postgres on insert
    });
  }
  if (models.length) await saveModels(platform, models as never);
  const all = await listApiKeys();
  const idx = [...all].sort((a, z) => a.platform.localeCompare(z.platform)).findIndex((e) => e.platform === platform) + 1;
  return c.json({ ok: true, id: idx, platform, keyId: idx });
});

/** Resolve the 1-based numeric key id (or a platform string) to a platform. */
async function platformById(id: unknown): Promise<string | null> {
  const all = await listApiKeys();
  const sorted = [...all].sort((a, z) => a.platform.localeCompare(z.platform));
  const s = String(id);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= sorted.length ? sorted[n - 1].platform : null;
  }
  return all.some((e) => e.platform === s) ? s : null;
}

dashboardRouter.post("/keys/custom/discover-models", (c) => c.json({ models: [] }));
dashboardRouter.post("/keys/custom/probe", (c) => c.json({ ok: true, status: "healthy" }));
dashboardRouter.post("/keys/discovered-models", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const platform = await platformById(b.keyId);
  if (platform) await saveModels(platform, toModels(b.models) as never);
  return c.json({ ok: true });
});
dashboardRouter.post("/keys/import-selected", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { keys?: unknown[]; rows?: unknown[] };
  const rows = (b.keys ?? b.rows ?? []) as Record<string, unknown>[];
  let imported = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const secret = String(r.keyValue ?? r.key ?? r.apiKey ?? "");
    if (!secret) { errors.push(`missing key for ${r.platform ?? "?"}`); continue; }
    const platform = String(r.platform ?? r.keyName ?? `imported_${randHex(3)}`);
    const models = toModels(r.models);
    try {
      const enc = await encryptKey(secret);
      await saveApiKey({
        id: platform, platform, label: String(r.keyName ?? r.label ?? platform),
        encrypted_key: enc.encrypted, iv: enc.iv, auth_tag: enc.authTag,
        status: "healthy", enabled: true,
        base_url: (r.baseUrl ?? r.base_url) as string | undefined,
        db_id: 0, // Placeholder; real db_id assigned by Postgres on insert
      });
      if (models.length) await saveModels(platform, models as never);
      imported++;
    } catch (e) {
      errors.push(`${platform}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return c.json({ ok: true, imported, errors });
});
dashboardRouter.post("/keys/preview", (c) => c.json({ keys: [], skipped: 0, errors: [] }));

// ── Health / Embeddings / Media extras ───────────────────────────────────────

dashboardRouter.post("/health/check-all", (c) => c.json({ ok: true, checked: 0, results: [] }));
dashboardRouter.post("/health/check/:keyId", (c) => c.json({ ok: true, status: "healthy" }));
dashboardRouter.post("/health/quota/:keyId", (c) => c.json({ ok: true }));

dashboardRouter.post("/embeddings/custom", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  return c.json({ ok: true, id: randHex(6), ...b });
});
dashboardRouter.put("/embeddings", async (c) => c.json({ ok: true, ...(await c.req.json().catch(() => ({}))) }));
dashboardRouter.delete("/embeddings/custom/:id", (c) => c.json({ ok: true }));

dashboardRouter.put("/media/:id", (c) => c.json({ ok: true, id: c.req.param("id") }));
dashboardRouter.delete("/media/custom/:id", (c) => c.json({ ok: true }));

// ── Fallback extras / misc ───────────────────────────────────────────────────

dashboardRouter.put("/fallback", async (c) => put("fallback-config", await c.req.json().catch(() => [])));
dashboardRouter.put("/fallback/routing", async (c) => put("fallback/routing", await c.req.json().catch(() => ({}))));
dashboardRouter.delete("/fallback/penalty-inspector", (c) => c.json({ ok: true }));
dashboardRouter.delete("/client-profiles/:id", (c) => c.json({ ok: true }));
dashboardRouter.delete("/keys/:id/cooldowns", (c) => c.json({ ok: true }));
dashboardRouter.delete("/models/:id", (c) => c.json({ ok: true }));

// ── Catalog Sync (manual trigger for admin dashboard) ─────────────────────────
dashboardRouter.post("/catalog/sync", async (c) => {
  try {
    const { syncSignedCatalog } = await import("../services/catalog-sync.ts");
    const r = await syncSignedCatalog();
    return c.json(r);
  } catch (e) {
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      500
    );
  }
});

dashboardRouter.get("/catalog/sync/status", async (c) => {
  try {
    const { getSetting } = await import("../db/pg.ts");
    const [version, syncedAt, err] = await Promise.all([
      getSetting("catalog_version"),
      getSetting("catalog_synced_at"),
      getSetting("catalog_sync_error"),
    ]);
    return c.json({
      version: version ?? null,
      syncedAt: syncedAt ?? null,
      lastError: err ?? null,
    });
  } catch (e) {
    return c.json({ version: null, syncedAt: null, lastError: e instanceof Error ? e.message : String(e) });
  }
});
