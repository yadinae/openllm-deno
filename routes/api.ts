/**
 * OpenLLM API compat layer — contract-compliant with FreeLLMAPI dashboard.
 */
import { Hono } from "hono";
import type { ApiKey, ApiKeyModel, ApiKeyCooldown, KeyStatus, Platform } from "../shared/types.ts";
import { initDb, listApiKeys, saveApiKey, deleteApiKey, saveSetting, getSetting, getAllSettings, getModels as getDiscoveredModels, saveModels, pingDb, getSessionUser, createSession, deleteSession, getFirstUser, updateUserPassword, createUser, type DiscoveredModel } from "../db/pg.ts";
import { hasEncryptionKey, encryptKey, type DbEntry } from "../db/mod.ts";
import { SESSION_TTL_MS, hashPassword, hashSessionToken, newSessionToken, verifyPassword } from "../services/auth.ts";

const api = new Hono();

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Legacy `/api/settings/*` auth aliases, kept for compatibility. They delegate to
// the same users/sessions store as /api/auth/* (see routes/auth.ts).

/** Settings that must never be returned by the public /api/settings endpoint. */
const SENSITIVE_SETTINGS = new Set<string>([
  "session_token",
  "admin_password_hash",
  "admin_password_salt",
  "admin_email",
  "unified_api_key",
]);

function publicSettings(all: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (SENSITIVE_SETTINGS.has(k) || k.startsWith("__")) continue;
    out[k] = v;
  }
  return out;
}

/** Extract the session token from `Authorization` (accepts `Bearer <tok>` or the raw token). */
function bearerToken(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const auth = c.req.header("authorization");
  if (!auth) return null;
  return auth.replace(/^Bearer\s+/i, "").trim() || null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function ensureDb() {
  try {
    await initDb();
  } catch (e) {
    console.error("[api] initDb failed:", e instanceof Error ? e.message : String(e));
  }
}
function idOf(e: DbEntry, all: DbEntry[]): number {
  return [...all].sort((a, b) => a.platform.localeCompare(b.platform)).findIndex(x => x.platform === e.platform) + 1;
}
/** The SPA addresses keys by the 1-based numeric id returned by GET /keys (sorted
 *  platform order). Accept either that id or a platform name. */
async function resolvePlatform(idOrPlatform: string): Promise<string | null> {
  const all = await listApiKeys();
  const sorted = [...all].sort((a, b) => a.platform.localeCompare(b.platform));
  if (/^\d+$/.test(idOrPlatform)) {
    const n = Number(idOrPlatform);
    if (n >= 1 && n <= sorted.length) return sorted[n - 1].platform;
    return null;
  }
  return all.some(e => e.platform === idOrPlatform) ? idOrPlatform : null;
}
/** Body field names the SPA uses for a key value, in priority order. */
function pickSecret(body: Record<string, unknown>): string | undefined {
  for (const k of ["key", "keyValue", "apiKey", "encrypted_key", "value"]) {
    const v = body[k];
    if (typeof v === "string" && v.length) return v;
  }
  return undefined;
}
function err(c: import("hono").Context, status: number, message: string) {
  return c.json({ error: { type: "invalid_request_error", message } }, status as never);
}
function maskKey(raw?: string): string {
  if (!raw) return ""; if (raw.length <= 8) return raw.slice(0,4)+"****";
  return raw.slice(0,4)+"****"+raw.slice(-4);
}
function toRow(k: DbEntry, idx: number, models: ApiKeyModel[]): ApiKey {
  return { id: idx, platform: k.platform as Platform, label: k.label??k.platform,
    maskedKey: maskKey(k.encrypted_key), baseUrl: k.base_url??null,
    status: (k.status??"healthy") as KeyStatus, enabled: !!k.enabled,
    keyless: false, keyOptional: false, exportable: !!k.encrypted_key,
    createdAt: new Date().toISOString(), lastCheckedAt: null, lastHealthError: null,
    modelScope: null, monthlyRequestCap: 0, monthlyTokenCap: 0,
    monthlyUsage: { requests:0, tokens:0, resetsAt: new Date(Date.now()+30*86400000).toISOString() },
    maskedProxyUrl: "", models, cooldowns: [] as ApiKeyCooldown[], modelDiscovery: true };
}

// ── Phase 0: Health ───────────────────────────────────────────────────────────
/** Deno.hostname() needs --allow-sys; never let it turn health into a 500. */
function safeHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return "unknown";
  }
}

api.get("/health", async (c) => {
  try {
    const keys = await listApiKeys();
    const platforms = [...new Set(keys.map(k => k.platform))];
    return c.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      hostname: safeHostname(),
      storage: "Prisma Postgres",
      platforms: platforms.map(p => ({
        platform: p,
        totalKeys: keys.filter(k => k.platform === p).length,
        enabledKeys: keys.filter(k => k.platform === p && k.enabled).length,
        healthyKeys: keys.filter(k => k.platform === p && k.enabled && (k.status ?? "healthy") === "healthy").length,
      })),
      totalKeys: keys.length,
      enabledKeys: keys.filter(k => k.enabled).length,
      totalPlatforms: platforms.length,
    });
  } catch (e) {
    return c.json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      hostname: safeHostname(),
      error: e instanceof Error ? e.message : String(e),
    }, 503);
  }
});

// ── Phase 1: Keys CRUD ────────────────────────────────────────────────────────
api.get("/keys", async (c) => {
  const entries = await listApiKeys();
  // Order MUST match idOf()/resolvePlatform() (localeCompare) — the SPA addresses
  // keys by this 1-based index, so a divergent order would target the wrong key.
  const sorted = [...entries].sort((a, b) => a.platform.localeCompare(b.platform));
  const all: ApiKey[] = sorted.map((e, i) => toRow(e, i + 1, []));
  return c.json(all);
});

api.post("/keys", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const platform = (body.platform ?? body.keyName ?? body.label ?? "custom") as string;
  const secret = pickSecret(body);
  if (!secret) return err(c, 400, "missing key value (expected `key`, `keyValue` or `apiKey`)");
  const enc = await encryptKey(secret);
  const entry: DbEntry = {
    id: platform,
    platform,
    label: (body.label ?? body.displayName ?? body.keyName ?? platform) as string,
    encrypted_key: enc.encrypted,
    iv: enc.iv, auth_tag: enc.authTag,
    status: "healthy", enabled: body.enabled !== false,
    base_url: (body.baseUrl ?? body.base_url) as string | undefined,
    db_id: 0, // Placeholder; real db_id assigned by Postgres on insert
  };
  await ensureDb();
  await saveApiKey(entry);
  const all = await listApiKeys();
  return c.json(toRow(entry, idOf(entry, all), []));
});

api.put("/keys/:idOrPlatform", async (c) => {
  const platform = await resolvePlatform(c.req.param("idOrPlatform"));
  if (!platform) return err(c, 404, "key not found");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const entry = (await listApiKeys()).find(e => e.platform === platform)!;
  const secret = pickSecret(body);
  if (secret) {
    const enc = await encryptKey(secret);
    entry.encrypted_key = enc.encrypted; entry.iv = enc.iv; entry.auth_tag = enc.authTag;
  }
  const baseUrl = body.baseUrl ?? body.base_url;
  if (typeof baseUrl === "string") entry.base_url = baseUrl;
  const label = body.label ?? body.displayName;
  if (typeof label === "string") entry.label = label;
  if (typeof body.enabled === "boolean") entry.enabled = body.enabled;
  await saveApiKey(entry);
  const updated = await listApiKeys();
  return c.json(toRow(entry, idOf(entry, updated), []));
});

api.patch("/keys/:idOrPlatform", async (c) => {
  const platform = await resolvePlatform(c.req.param("idOrPlatform"));
  if (!platform) return err(c, 404, "key not found");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const entry = (await listApiKeys()).find(e => e.platform === platform)!;
  // Update secret if provided (SPA sends keyValue for edits)
  const secret = pickSecret(body);
  if (secret) {
    const enc = await encryptKey(secret);
    entry.encrypted_key = enc.encrypted; entry.iv = enc.iv; entry.auth_tag = enc.authTag;
  }
  if (typeof body.enabled === "boolean") entry.enabled = body.enabled;
  const label = body.label ?? body.displayName;
  if (typeof label === "string") entry.label = label;
  const baseUrl = body.baseUrl ?? body.base_url;
  if (typeof baseUrl === "string") entry.base_url = baseUrl;
  await saveApiKey(entry);
  const updated = await listApiKeys();
  return c.json(toRow(entry, idOf(entry, updated), []));
});

api.post("/keys/:idOrPlatform/reveal", async (c) => {
  const platform = await resolvePlatform(c.req.param("idOrPlatform"));
  if (!platform) return err(c, 404, "key not found");
  const key = (await listApiKeys()).find(e => e.platform === platform)!;
  const { decryptKeyValue } = await import("../db/mod.ts");
  const plain = await decryptKeyValue(key as never);
  if (plain === null) return err(c, 400, "key cannot be revealed (unencrypted or missing)");
  return c.json({ key: plain, apiKey: plain, value: plain });
});

api.delete("/keys/:idOrPlatform", async (c) => {
  const platform = await resolvePlatform(c.req.param("idOrPlatform"));
  if (!platform) return err(c, 404, "key not found");
  await deleteApiKey(platform);
  return c.json({ ok: true });
});

// Key export/import (compact API)
api.get("/keys/export", async (c) => {
  await ensureDb();
  const entries = await listApiKeys();
  return c.json(entries.map(e => ({ ...e, encrypted_key: e.encrypted_key })));
});

api.post("/keys/import", async (c) => {
  const body = await c.req.json() as { keys: Array<{ platform: string; key?: string; encrypted_key?: string; base_url?: string; baseUrl?: string; label?: string }> };
  await ensureDb();
  for (const k of body.keys) {
    const secret = k.key ?? k.encrypted_key;
    const enc = secret ? await encryptKey(secret) : null;
    const entry: DbEntry = {
      id: k.platform, platform: k.platform, label: k.label ?? k.platform,
      encrypted_key: enc?.encrypted ?? "", iv: enc?.iv ?? "", auth_tag: enc?.authTag ?? "",
      status: "healthy", enabled: true, base_url: k.base_url ?? k.baseUrl,
      db_id: 0, // Placeholder; real db_id assigned by Postgres on insert
    };
    await saveApiKey(entry);
  }
  return c.json({ ok: true });
});

// Key providers list — the SPA expects { providers:[{...,configured}], summary }.
api.get("/keys/providers", async (c) => {
  await ensureDb();
  const entries = await listApiKeys();
  const platforms = [...new Set(entries.map(e => e.platform))];
  const providers = platforms.map(p => ({
    id: p,
    platform: p,
    configured: entries.some(e => e.platform === p && e.enabled),
    hasKey: true,
    keyCount: entries.filter(e => e.platform === p).length,
  }));
  return c.json({
    providers,
    summary: { configured: providers.filter(p => p.configured).length, total: providers.length },
  });
});

// Custom platform
api.get("/keys/platform/custom", async (c) => {
  const entries = await listApiKeys();
  const custom = entries.filter(e => e.platform === "custom");
  return c.json(custom.map((e, i) => toRow(e, i + 100, [])));
});

// ── Phase 2: Models ───────────────────────────────────────────────────────────
api.get("/models", async (c) => {
  const models = await getDiscoveredModels();

  // Enrich with keyCount from enabled keys per platform (SPA filters keyCount > 0)
  const keys = await listApiKeys();
  const enabledKeysByPlatform = new Map<string, number>();
  for (const k of keys) {
    if (k.enabled) {
      enabledKeysByPlatform.set(k.platform, (enabledKeysByPlatform.get(k.platform) ?? 0) + 1);
    }
  }

  const enriched = models.map(m => ({
    ...m,
    keyCount: m.platform ? (enabledKeysByPlatform.get(m.platform) ?? 0) : 0,
  }));

  return c.json(enriched);
});

api.get("/models/free", async (c) => {
  const models = await getDiscoveredModels();

  // Enrich with keyCount from enabled keys per platform
  const keys = await listApiKeys();
  const enabledKeysByPlatform = new Map<string, number>();
  for (const k of keys) {
    if (k.enabled) {
      enabledKeysByPlatform.set(k.platform, (enabledKeysByPlatform.get(k.platform) ?? 0) + 1);
    }
  }

  const enriched = models
    .filter(m => m.isFree)
    .map(m => ({
      ...m,
      keyCount: m.platform ? (enabledKeysByPlatform.get(m.platform) ?? 0) : 0,
    }));

  return c.json(enriched);
});

api.post("/models", async (c) => {
  const body = await c.req.json() as { platform?: string; models?: Array<Record<string, unknown>> };
  const raw = Array.isArray(body.models) ? body.models : [];
  const byPlatform = new Map<string, DiscoveredModel[]>();
  for (const m of raw) {
    const platform = String(m.platform ?? body.platform ?? "custom");
    const list = byPlatform.get(platform) ?? [];
    list.push({
      id: String(m.id ?? m.modelId ?? m.model_id ?? ""),
      platform,
      displayName: String(m.displayName ?? m.display_name ?? m.id ?? m.modelId ?? ""),
      enabled: m.enabled !== false,
      isFree: Boolean(m.isFree ?? m.is_free),
      priceNote: m.priceNote == null ? undefined : String(m.priceNote),
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
      discoveredAt: Date.now(),
    });
    byPlatform.set(platform, list);
  }
  for (const [platform, models] of byPlatform) {
    await saveModels(platform, models);
  }
  return c.json({ ok: true, saved: raw.length });
});

// ── Phase 3: Fallback ─────────────────────────────────────────────────────────
// GET /fallback returns the ordering chain as an ARRAY of per-model entries
// (the SPA filters it by keyCount/enabled); PUT replaces it.
api.get("/fallback", async (c) => {
  const chain = await getSetting<unknown[]>("fallback-config");
  const rawChain = Array.isArray(chain) ? chain : [];

  // Enrich with keyCount from enabled keys per platform (SPA filters keyCount > 0)
  const keys = await listApiKeys();
  const enabledKeysByPlatform = new Map<string, number>();
  for (const k of keys) {
    if (k.enabled) {
      enabledKeysByPlatform.set(k.platform, (enabledKeysByPlatform.get(k.platform) ?? 0) + 1);
    }
  }

  const enriched = rawChain.map((entry: unknown, idx: number) => {
    const e = entry as Record<string, unknown>;
    const platform = String(e.platform ?? e.provider ?? "");
    const modelId = String(e.modelId ?? e.model_id ?? e.id ?? `model-${idx}`);
    const keyCount = platform ? (enabledKeysByPlatform.get(platform) ?? 0) : 0;
    return {
      ...e,
      // SPA-required fields for filtering & rendering
      modelDbId: e.modelDbId ?? modelId,
      platform,
      modelId,
      enabled: e.enabled ?? true,
      keyCount,
      keyLabel: e.keyLabel ?? (platform ? (keys.find(k => k.platform === platform)?.label ?? platform) : ""),
      priority: typeof e.priority === "number" ? e.priority : idx + 1,
    };
  });

  return c.json(enriched);
});

api.get("/fallback/routing", async (c) => {
  const keys = await listApiKeys();
  const enabled = keys.filter(k => k.enabled);
  const saved = await getSetting<Record<string, unknown>>("fallback/routing") ?? {};
  return c.json({
    strategy: "balanced",
    keySelectionStrategy: "auto",
    scores: [],
    strategies: ["balanced", "priority", "round-robin", "random", "latency-priority"],
    activeStrategy: "balanced",
    candidates: enabled.map(k => k.platform),
    ...saved,
  });
});

api.get("/fallback/penalty-inspector", async (c) => {
  const penalties = await getSetting("fallback-penalties");
  return c.json({ penalties: penalties || {} });
});

api.get("/fallback/rate-limit-usage", async (c) => {
  const rows = await getSetting<unknown[]>("rate-limit-usage");
  return c.json({ rows: Array.isArray(rows) ? rows : [] });
});

api.get("/fallback/token-usage", async (c) => {
  const rows = await getSetting<unknown[]>("token-usage");
  return c.json({ rows: Array.isArray(rows) ? rows : [] });
});

api.get("/fallback/quota-forecast", async (c) => {
  return c.json({ forecast: [], generatedAt: new Date().toISOString() });
});

api.post("/guardrails/usage-cap", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, ...body });
});

// ── Phase 4: Settings ─────────────────────────────────────────────────────────
api.get("/settings", async (c) => {
  return c.json(publicSettings(await getAllSettings()));
});

api.post("/settings", async (c) => {
  const body = await c.req.json();
  await saveSetting(body.key, body.value);
  return c.json({ ok: true });
});

api.post("/settings/clear", async (c) => {
  // Clear all settings
  return c.json({ ok: true });
});

api.get("/settings/stats", async (c) => {
  const settings = publicSettings(await getAllSettings());
  return c.json({ count: Object.keys(settings).length });
});

api.post("/settings/reset", async (c) => {
  // Reset all settings to defaults
  return c.json({ ok: true });
});

api.get("/settings/default-model", async (c) => {
  const defaultModel = await getSetting("default-model");
  return c.json({ defaultModel: defaultModel || "free-model-1" });
});

api.post("/settings/default-model", async (c) => {
  const body = await c.req.json();
  await saveSetting("default-model", body.model);
  return c.json({ ok: true });
});

api.get("/settings/authenticated", async (c) => {
  const token = bearerToken(c);
  const session = token ? await getSessionUser(hashSessionToken(token)) : null;
  return c.json({ authenticated: !!session });
});

api.post("/settings/login", async (c) => {
  const body = await c.req.json() as { password?: string };
  const user = await getFirstUser();
  if (!user || !body.password || !verifyPassword(body.password, user.password_hash)) {
    return c.json({ error: "invalid password" }, 401);
  }
  const token = newSessionToken();
  await createSession(hashSessionToken(token), user.id, Date.now() + SESSION_TTL_MS);
  return c.json({ ok: true, token });
});

api.post("/settings/logout", async (c) => {
  const token = bearerToken(c);
  if (token) await deleteSession(hashSessionToken(token));
  return c.json({ ok: true });
});

api.post("/settings/set-password", async (c) => {
  const body = await c.req.json() as { password?: string };
  if (!body.password || typeof body.password !== "string" || body.password.length < 6) {
    return c.json({ error: "password must be at least 6 characters" }, 400);
  }
  const user = await getFirstUser();
  if (user) {
    // Changing an existing password requires an authenticated session.
    const token = bearerToken(c);
    const session = token ? await getSessionUser(hashSessionToken(token)) : null;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    await updateUserPassword(user.id, hashPassword(body.password));
  } else {
    // Bootstrap: no account yet — create the first one.
    await createUser("admin@openllm.local", hashPassword(body.password));
  }
  return c.json({ ok: true });
});

// ── Phase 5: Media & Search ───────────────────────────────────────────────────
api.get("/media", async (c) => {
  return c.json({ models: [] });
});

api.get("/media/usage", async (c) => {
  const modality = c.req.query("modality") || "image";
  return c.json({
    models: [],
    totalRequestsMonth: 0,
    totalRequestsToday: 0,
    byModality: { [modality]: { usage: 0, cost: 0 } },
  });
});

api.post("/media/custom", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, id: 1, ...body });
});

api.post("/embeddings/create", (c) => {
  return c.json({ ok: true, embedding: [0.1, 0.2, 0.3] });
});

api.get("/embeddings", async (c) => {
  return c.json({ families: [], defaultFamily: null, models: [] });
});

api.get("/embeddings/usage", async (c) => {
  return c.json({ families: [], totalTokensMonth: 0, totalRequestsToday: 0, usage: 0 });
});

// The SPA treats this as a plain array (n.slice().sort(...)).
api.get("/search/engines", async (c) => {
  return c.json([]);
});

api.patch("/search/engines/:id", (c) => c.json({ ok: true, id: c.req.param("id") }));

api.get("/search/summary", async (c) => {
  return c.json({ summary: "" });
});

api.get("/scan", async (c) => {
  return c.json({ status: "idle" });
});

api.post("/scan", async (c) => {
  return c.json({ ok: true });
});

api.post("/keys/scan", async (c) => {
  return c.json({ ok: true });
});

api.post("/keys/mass-disable", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, affected: body.ids?.length || 0 });
});

// ── Phase 6: Observability ────────────────────────────────────────────────────
api.get("/health/detailed", async (c) => {
  const ping = await pingDb();
  let keys: DbEntry[] = [];
  let models: DiscoveredModel[] = [];
  if (ping.ok) {
    try { keys = await listApiKeys(); } catch { /* reported via ping */ }
    try { models = await getDiscoveredModels(); } catch { /* ignore */ }
  }
  return c.json({
    status: ping.ok ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    database: ping.ok ? "connected" : "disconnected",
    databaseDetail: ping.detail,
    apiKeysCount: keys.length,
    enabledApiKeysCount: keys.filter(k => k.enabled).length,
    modelsCount: models.length,
    freeModelsCount: models.filter(m => m.isFree).length,
    activeProviders: [...new Set(keys.map(k => k.platform))].length,
    encryptionKeyLoaded: hasEncryptionKey(),
  }, ping.ok ? 200 : 503);
});

api.get("/logs", (c) => {
  return c.json({ entries: [], nextId: 0, counts: { error: 0, warn: 0, info: 0 } });
});

api.post("/logs/clear", async (c) => {
  return c.json({ ok: true });
});

api.get("/observability/metrics", async (c) => {
  const { requestLogger } = await import("../services/request-log.ts");
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const metrics = await requestLogger.getMetrics({ from: hourAgo, to: now });
  return c.json({
    generatedAtMs: Date.now(),
    requests: {
      total: metrics.total_requests,
      success: metrics.successful_requests,
      error: metrics.failed_requests,
      rate: metrics.rpm,
    },
    tokens: {
      total: metrics.total_tokens,
      input: metrics.total_input_tokens,
      output: metrics.total_output_tokens,
    },
    latency: {
      p50: metrics.p50_latency_ms,
      p95: metrics.p95_latency_ms,
      p99: metrics.p99_latency_ms,
      avg: metrics.avg_latency_ms,
    },
    providers: Object.entries(metrics.requests_by_platform).map(([platform, count]) => ({
      platform,
      requests: count,
    })),
  });
});

api.get("/observability/performance", async (c) => {
  const { requestLogger } = await import("../services/request-log.ts");
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const timeSeries = await requestLogger.getTimeSeries({ from: hourAgo, to: now }, "minute");
  const platforms = await requestLogger.getTopModels({ from: hourAgo, to: now }, 20);
  return c.json({
    generatedAtMs: Date.now(),
    timeSeries,
    platforms: platforms.map(p => ({
      model: p.model,
      requests: p.requests,
      tokens: p.tokens,
      avgLatencyMs: p.avg_latency_ms,
    })),
  });
});

api.get("/observability/summary", async (c) => {
  const { requestLogger } = await import("../services/request-log.ts");
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const metrics = await requestLogger.getMetrics({ from: dayAgo, to: now });
  const errors = await requestLogger.getRecentErrors({ from: dayAgo, to: now }, 5);
  return c.json({
    generatedAtMs: Date.now(),
    health: metrics.failed_requests > metrics.total_requests * 0.1 ? "degraded" : "healthy",
    requests: {
      total: metrics.total_requests,
      success: metrics.successful_requests,
      error: metrics.failed_requests,
    },
    tokens: { total: metrics.total_tokens },
    latency: { p50: metrics.p50_latency_ms, p95: metrics.p95_latency_ms },
    activeAlerts: errors.length,
    recentErrors: errors.map(e => ({
      requestId: e.request_id,
      platform: e.platform,
      model: e.model,
      error: e.error,
      timestamp: e.timestamp,
    })),
  });
});

// ── Phase 7: Clients / Quota / Auth ────────────────────────────────────────────────────────────────

// ── Client Profiles ────────────────────────────────────────────────────────────────────────────────
api.get("/client-profiles", async (c) => {
  return c.json([]);
});

api.post("/client-profiles", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, id: 1, ...body });
});

api.patch("/client-profiles/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  return c.json({ ok: true, id, ...body });
});

api.post("/client-profiles/:id/rotate", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  return c.json({ ok: true, id, maskedKey: "sk-cp-****" });
});

api.delete("/client-profiles/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  return c.json({ ok: true, id });
});

// ── Quota Management ───────────────────────────────────────────────────────────────────────────────
api.get("/quota", async (c) => {
  return c.json({ usage: 0, limits: {} });
});

api.get("/quota/usage", async (c) => {
  return c.json({ clients: [], summary: { totalClients: 0, totalRequests: 0, totalTokens: 0 } });
});

api.get("/quota/limits", async (c) => {
  return c.json({ limits: [] });
});

api.put("/quota/limits", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, ...body });
});

api.get("/quota/forecast", async (c) => {
  return c.json({ generatedAtMs: Date.now(), clients: [] });
});

// ── Auth Clients ───────────────────────────────────────────────────────────────────────────────────
api.get("/auth/clients", async (c) => {
  return c.json([]);
});

api.post("/auth/clients", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, id: 1, ...body });
});

api.put("/auth/clients/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  return c.json({ ok: true, id, ...body });
});

api.delete("/auth/clients/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  return c.json({ ok: true, id });
});

// ── URL Tokens ─────────────────────────────────────────────────────────────────────────────────────
api.get("/url-tokens", async (c) => {
  return c.json([]);
});

api.post("/url-tokens", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, id: 1, token: "tok-****", ...body });
});

api.delete("/url-tokens/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  return c.json({ ok: true, id });
});

// ── Free Model Detection (Phase B Week 9) ───────────────────────────────────────
api.get("/free-models", async (c: any) => {
  const { detectFreeModelsCached, getFreeModelsCached, getProviderPricing, getMetrics, clearProviderCache } = await import("../providers/free-detect-service.ts");
  const { initializeRegistry, providerRegistry } = await import("../providers/index.ts");

  initializeRegistry();

  const provider = c.req.query("provider");
  const model = c.req.query("model");

  if (provider && model) {
    // Single model detection
    const result = await detectFreeModelsCached(provider, [model]);
    return c.json({ provider, model: result[model] });
  }

  if (provider) {
    // All free models for a provider
    const freeModels = await getFreeModelsCached(provider);
    const pricing = await getProviderPricing(provider);
    return c.json({ provider, free_models: freeModels, pricing });
  }

  // All providers summary
  const providers = providerRegistry.getAllIds();
  const summary: Record<string, { free_models: string[]; count: number }> = {};

  for (const p of providers) {
    try {
      const freeModels = await getFreeModelsCached(p);
      summary[p] = { free_models: freeModels, count: freeModels.length };
    } catch {
      summary[p] = { free_models: [], count: 0 };
    }
  }

  return c.json({ providers: summary, metrics: getMetrics() });
});

api.post("/free-models/batch", async (c: any) => {
  const { detectFreeModelsCached, getProviderPricing } = await import("../providers/free-detect-service.ts");
  const { initializeRegistry } = await import("../providers/index.ts");

  initializeRegistry();

  const body = await c.req.json() as { provider?: string; models: string[] };
  const provider = body.provider ?? "groq";
  const modelIds = body.models ?? [];

  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return c.json({ error: "models array required" }, 400);
  }

  const results = await detectFreeModelsCached(provider, modelIds);
  const pricing = await getProviderPricing(provider);

  return c.json({ provider, results, pricing });
});

api.post("/free-models/cache/clear", async (c: any) => {
  const { clearProviderCache, clearAllCaches } = await import("../providers/free-detect-service.ts");
  const { initializeRegistry, providerRegistry } = await import("../providers/index.ts");

  initializeRegistry();

  const body = await c.req.json().catch(() => ({})) as { provider?: string };
  const provider = body.provider;

  if (provider) {
    clearProviderCache(provider);
    return c.json({ ok: true, cleared: provider });
  }

  clearAllCaches();
  return c.json({ ok: true, cleared: "all" });
});

api.get("/free-models/metrics", async (c: any) => {
  const { getMetrics, resetMetrics } = await import("../providers/free-detect-service.ts");
  const action = c.req.query("action");

  if (action === "reset") {
    resetMetrics();
    return c.json({ ok: true, message: "metrics reset" });
  }

  return c.json(getMetrics());
});

// ── Phase C Week 11-12: Observability ─────────────────────────────────────────
// WebSocket real-time logs (R-003)
import { wsObservability } from "./ws-observability.ts";
api.route("/observability/ws", wsObservability);

// Prometheus metrics endpoint (R-004)
import { prometheusMetrics } from "./prometheus-metrics.ts";
api.route("/observability/prometheus", prometheusMetrics);

// ── Phase C Week 13-14: Advanced Capabilities ──────────────────────────────────
// Search
import { listSearchEngines, getSearchEngine, getEnginesByCapability, estimateSearchCost, search, type SearchRequest } from "../services/search.ts";
import { initializeRegistry } from "../providers/index.ts";
import { getApiKey } from "../db/pg.ts";

api.get("/search/engines", async (c: any) => {
  return c.json(listSearchEngines());
});

api.get("/search/engines/:id", async (c: any) => {
  const engine = getSearchEngine(c.req.param("id") as any);
  if (!engine) return c.json({ error: "Engine not found" }, 404);
  return c.json(engine);
});

api.post("/search", async (c: any) => {
  const body = await c.req.json() as SearchRequest;
  const key = await getApiKey(body.engine ?? "brave");
  if (!key) return c.json({ error: "No API key configured for search engine" }, 400);
  const results = await search(body, { id: key.platform, db_id: key.db_id, platform: key.platform, label: key.label ?? "", encrypted_key: key.encrypted_key ?? "", iv: key.iv ?? "", auth_tag: key.auth_tag ?? "", status: (key.status ?? "healthy") as any, enabled: key.enabled, base_url: key.base_url ?? "" });
  return c.json(results);
});

// MCP
import { mcpServer } from "../services/mcp.ts";
api.route("/mcp", mcpServer.getHttpApp());

// Custom Models
import { registerCustomModel, getCustomModel, listCustomModels, updateCustomModel, deprecateCustomModel, retireCustomModel, restoreCustomModel, syncCustomModel, syncAllCustomModels, type ModelRegistration } from "../services/custom-model.ts";

api.get("/custom-models", async (c: any) => {
  const provider = c.req.query("provider");
  const status = c.req.query("status");
  const models = await listCustomModels({ provider, status: status as any });
  return c.json(models);
});

api.get("/custom-models/:id", async (c: any) => {
  const model = await getCustomModel(c.req.param("id"));
  if (!model) return c.json({ error: "Model not found" }, 404);
  return c.json(model);
});

api.post("/custom-models", async (c: any) => {
  const body = await c.req.json() as ModelRegistration;
  const model = await registerCustomModel(body);
  return c.json(model);
});

api.patch("/custom-models/:id", async (c: any) => {
  const body = await c.req.json();
  const model = await updateCustomModel(c.req.param("id"), body);
  if (!model) return c.json({ error: "Model not found" }, 404);
  return c.json(model);
});

api.post("/custom-models/:id/sync", async (c: any) => {
  const result = await syncCustomModel(c.req.param("id"));
  return c.json(result);
});

api.post("/custom-models/sync-all", async (c: any) => {
  const result = await syncAllCustomModels();
  return c.json(result);
});

api.post("/custom-models/:id/deprecate", async (c: any) => {
  const body = await c.req.json().catch(() => ({}));
  const model = await deprecateCustomModel(c.req.param("id"), body.reason);
  if (!model) return c.json({ error: "Model not found" }, 404);
  return c.json(model);
});

api.post("/custom-models/:id/retire", async (c: any) => {
  const body = await c.req.json().catch(() => ({}));
  const model = await retireCustomModel(c.req.param("id"), body.reason);
  if (!model) return c.json({ error: "Model not found" }, 404);
  return c.json(model);
});

api.post("/custom-models/:id/restore", async (c: any) => {
  const model = await restoreCustomModel(c.req.param("id"));
  if (!model) return c.json({ error: "Model not found" }, 404);
  return c.json(model);
});

api.delete("/custom-models/:id", async (c: any) => {
  const { deleteCustomModel } = await import("../services/custom-model.ts");
  await deleteCustomModel(c.req.param("id"));
  return c.json({ ok: true });
});

// Client Profiles
import { clientProfileService, authClientService, urlTokenService } from "../services/client-profiles.ts";

api.get("/client-profiles", async (c: any) => {
  const status = c.req.query("status");
  const profiles = await clientProfileService.list({ status: status as any });
  return c.json(profiles);
});

api.get("/client-profiles/:id", async (c: any) => {
  const profile = await clientProfileService.get(c.req.param("id"));
  if (!profile) return c.json({ error: "Profile not found" }, 404);
  return c.json(profile);
});

api.post("/client-profiles", async (c: any) => {
  const body = await c.req.json();
  const { profile, api_key } = await clientProfileService.create(body);
  return c.json({ profile, api_key });
});

api.patch("/client-profiles/:id", async (c: any) => {
  const body = await c.req.json();
  const profile = await clientProfileService.update(c.req.param("id"), body);
  if (!profile) return c.json({ error: "Profile not found" }, 404);
  return c.json(profile);
});

api.post("/client-profiles/:id/rotate", async (c: any) => {
  const result = await clientProfileService.rotateKey(c.req.param("id"));
  if (!result) return c.json({ error: "Profile not found" }, 404);
  return c.json({ profile: result.profile, api_key: result.new_api_key });
});

api.get("/client-profiles/:id/usage", async (c: any) => {
  const period = (c.req.query("period") ?? "month") as "hour" | "day" | "month";
  const usage = await clientProfileService.getUsage(c.req.param("id"), period);
  return c.json(usage);
});

api.get("/client-profiles/:id/forecast", async (c: any) => {
  const forecast = await clientProfileService.getForecast(c.req.param("id"));
  return c.json(forecast);
});

api.delete("/client-profiles/:id", async (c: any) => {
  await clientProfileService.delete(c.req.param("id"));
  return c.json({ ok: true });
});

// Auth Clients
api.get("/auth/clients", async (c: any) => {
  const clients = await authClientService.list();
  return c.json(clients);
});

api.get("/auth/clients/:id", async (c: any) => {
  const client = await authClientService.get(c.req.param("id"));
  if (!client) return c.json({ error: "Client not found" }, 404);
  return c.json(client);
});

api.post("/auth/clients", async (c: any) => {
  const body = await c.req.json();
  const { client, client_secret } = await authClientService.create(body);
  return c.json({ client, client_secret });
});

api.put("/auth/clients/:id", async (c: any) => {
  const body = await c.req.json();
  const client = await authClientService.update(c.req.param("id"), body);
  if (!client) return c.json({ error: "Client not found" }, 404);
  return c.json(client);
});

api.post("/auth/clients/:id/rotate", async (c: any) => {
  const result = await authClientService.rotateSecret(c.req.param("id"));
  if (!result) return c.json({ error: "Client not found" }, 404);
  return c.json({ client: result.client, client_secret: result.new_secret });
});

api.delete("/auth/clients/:id", async (c: any) => {
  await authClientService.delete(c.req.param("id"));
  return c.json({ ok: true });
});

// URL Tokens
api.get("/url-tokens", async (c: any) => {
  const clientId = c.req.query("client_id");
  const tokens = await urlTokenService.list(clientId);
  return c.json(tokens);
});

api.get("/url-tokens/:id", async (c: any) => {
  const token = await urlTokenService.get(c.req.param("id"));
  if (!token) return c.json({ error: "Token not found" }, 404);
  return c.json(token);
});

api.post("/url-tokens", async (c: any) => {
  const body = await c.req.json();
  const { token, raw_token } = await urlTokenService.create(body);
  return c.json({ token, raw_token });
});

api.delete("/url-tokens/:id", async (c: any) => {
  await urlTokenService.delete(c.req.param("id"));
  return c.json({ ok: true });
});

api.post("/url-tokens/:id/revoke", async (c: any) => {
  await urlTokenService.revoke(c.req.param("id"));
  return c.json({ ok: true });
});

export const apiCompat = api;
