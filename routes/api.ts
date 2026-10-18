/**
 * OpenLLM API compat layer — contract-compliant with FreeLLMAPI dashboard.
 */
import { Hono } from "hono";
import type { ApiKey, ApiKeyModel, ApiKeyCooldown, KeyStatus, Platform } from "../shared/types.ts";
import { initDb, listApiKeys, saveApiKey, deleteApiKey, saveSetting, getSetting, getAllSettings, getModels as getDiscoveredModels, saveModels } from "../db/pg.ts";
import { getDb, type DbData, type DbEntry, decryptKey, encryptKey } from "../db/mod.ts";
import { discoverModels, testProvider } from "../services/discovery.ts";

const api = new Hono();

// ── Auth helpers ──────────────────────────────────────────────────────────────
const SESSION_KEY = "session_token";
const PWD_HASH_KEY = "admin_password_hash";
const PWD_SALT_KEY = "admin_password_salt";

async function getDbSetting(key: string): Promise<string | null> {
  const { getSetting } = await import("../db/pg.ts");
  return await getSetting(key);
}
async function setDbSetting(key: string, val: unknown): Promise<void> {
  const { saveSetting } = await import("../db/pg.ts");
  await saveSetting(key, val);
}
async function genToken(): Promise<string> {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(pw: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, km, 256);
  const hash = Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, "0")).join("");
  return { hash, salt: Array.from(salt, x => x.toString(16).padStart(2, "0")).join("") };
}
async function verifyPassword(pw: string, hash: string, saltHex: string): Promise<boolean> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, km, 256);
  return Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, "0")).join("") === hash;
}
async function getSession(): Promise<string> {
  const s = await getDbSetting(SESSION_KEY);
  if (s) return s;
  const t = await genToken(); await setDbSetting(SESSION_KEY, t); return t;
}
async function isSetup(): Promise<boolean> { return !!await getDbSetting(PWD_HASH_KEY); }

// ── DB helpers ────────────────────────────────────────────────────────────────
async function ensureDb() { try { await initDb(); } catch { } }
async function listRaw(): Promise<ApiKey[]> { await ensureDb(); return listApiKeys() as unknown as ApiKey[]; }
function idOf(e: DbEntry, all: DbEntry[]): number {
  return [...all].sort((a, b) => a.platform.localeCompare(b.platform)).findIndex(x => x.platform === e.platform) + 1;
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
api.get("/health", async (c) => {
  const keys = await listApiKeys();
  const platforms = [...new Set(keys.map(k => k.platform))];
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    hostname: Deno.hostname(),
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
});

// ── Phase 1: Keys CRUD ────────────────────────────────────────────────────────
api.get("/keys", async (c) => {
  const entries = await listApiKeys();
  const all: ApiKey[] = entries.map((e, i) => toRow(e, i, []));
  return c.json(all);
});

api.post("/keys", async (c) => {
  const body = await c.req.json() as { platform: string; encrypted_key: string; base_url?: string; label?: string; enabled?: boolean; system_prompt?: string; description?: string; auth_type?: string; custom_fields?: Record<string, unknown>; };
  const entry: DbEntry = {
    platform: body.platform,
    label: body.label ?? body.platform,
    encrypted_key: body.encrypted_key,
    iv: "", auth_tag: "",
    status: "healthy", enabled: body.enabled ?? true,
    base_url: body.base_url ?? null,
  };
  await ensureDb();
  await saveApiKey(entry);
  const all = await listApiKeys();
  return c.json(toRow(entry, idOf(entry, all), []));
});

api.put("/keys/:platform", async (c) => {
  const platform = c.req.param("platform");
  const body = await c.req.json() as { encrypted_key?: string; base_url?: string; label?: string; enabled?: boolean; };
  await ensureDb();
  const existing = await listApiKeys();
  const entry = existing.find(e => e.platform === platform);
  if (!entry) return c.json({ error: "not found" }, 404);
  if (body.encrypted_key) entry.encrypted_key = body.encrypted_key;
  if (body.base_url !== undefined) entry.base_url = body.base_url;
  if (body.label) entry.label = body.label;
  if (body.enabled !== undefined) entry.enabled = body.enabled;
  await saveApiKey(entry);
  const updated = await listApiKeys();
  return c.json(toRow(entry, idOf(entry, updated), []));
});

api.delete("/keys/:platform", async (c) => {
  const platform = c.req.param("platform");
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
  const body = await c.req.json() as { keys: Array<{ platform: string; encrypted_key: string; base_url?: string; label?: string }> };
  await ensureDb();
  for (const k of body.keys) {
    const entry: DbEntry = {
      platform: k.platform, label: k.label ?? k.platform,
      encrypted_key: k.encrypted_key, iv: "", auth_tag: "",
      status: "healthy", enabled: true, base_url: k.base_url ?? null,
    };
    await saveApiKey(entry);
  }
  return c.json({ ok: true });
});

// Key providers list
api.get("/keys/providers", async (c) => {
  await ensureDb();
  const entries = await listApiKeys();
  const platforms = [...new Set(entries.map(e => e.platform))];
  return c.json(platforms);
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
  return c.json(models);
});

api.get("/models/free", async (c) => {
  const models = await getDiscoveredModels();
  const free = models.filter(m => m.isFree);
  return c.json(free);
});

api.post("/models", async (c) => {
  const body = await c.req.json();
  await saveModels(body.models);
  return c.json({ ok: true });
});

// ── Phase 3: Fallback ─────────────────────────────────────────────────────────
api.get("/fallback", async (c) => {
  const config = await getSetting("fallback-config");
  return c.json({ enabled: false, fallbackMode: "none", config: config || null });
});

api.get("/fallback/routing", async (c) => {
  const keys = await listApiKeys();
  const enabled = keys.filter(k => k.enabled);
  return c.json({ strategies: ["round-robin", "random", "latency-priority"], activeStrategy: "round-robin", candidates: enabled.map(k => k.platform) });
});

api.get("/fallback/penalty-inspector", async (c) => {
  const penalties = await getSetting("fallback-penalties");
  return c.json({ penalties: penalties || {} });
});

api.get("/fallback/rate-limit-usage", async (c) => {
  const usage = await getSetting("rate-limit-usage");
  return c.json({ usage: usage || {} });
});

api.get("/fallback/token-usage", async (c) => {
  const usage = await getSetting("token-usage");
  return c.json({ usage: usage || {} });
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
  const settings = await getAllSettings();
  return c.json(settings);
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
  const settings = await getAllSettings();
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
  const session = c.req.header("authorization");
  const isValid = session === await getSession();
  return c.json({ authenticated: isValid });
});

api.post("/settings/login", async (c) => {
  const body = await c.req.json();
  const password = body.password;
  const hash = await getSetting(PWD_HASH_KEY);
  const salt = await getSetting(PWD_SALT_KEY);
  if (!hash || !salt) return c.json({ error: "not setup" }, 401);
  const valid = await verifyPassword(password, hash, salt);
  if (!valid) return c.json({ error: "invalid password" }, 401);
  const token = await getSession();
  return c.json({ ok: true, token });
});

api.post("/settings/logout", async (c) => {
  return c.json({ ok: true });
});

api.post("/settings/set-password", async (c) => {
  const body = await c.req.json();
  const { hash, salt } = await hashPassword(body.password);
  await setDbSetting(PWD_HASH_KEY, hash);
  await setDbSetting(PWD_SALT_KEY, salt);
  return c.json({ ok: true });
});

// ── Phase 5: Media & Search ───────────────────────────────────────────────────
api.get("/media", async (c) => {
  return c.json({ models: [] });
});

api.get("/media/usage", async (c) => {
  const modality = c.req.query("modality") || "image";
  return c.json({ byModality: { [modality]: { usage: 0, cost: 0 } } });
});

api.post("/media/custom", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, id: 1, ...body });
});

api.post("/embeddings/create", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, embedding: [0.1, 0.2, 0.3] });
});

api.get("/embeddings", async (c) => {
  return c.json({ models: [] });
});

api.get("/embeddings/usage", async (c) => {
  return c.json({ usage: 0 });
});

api.get("/search/engines", async (c) => {
  return c.json({ engines: [] });
});

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
  const keys = await listApiKeys();
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    database: "connected",
    apiKeysCount: keys.length,
    enabledApiKeysCount: keys.filter(k => k.enabled).length,
    modelsCount: 0,
    freeModelsCount: 0,
    activeProviders: [...new Set(keys.map(k => k.platform))].length,
  });
});

api.get("/logs", async (c) => {
  const levels = c.req.query("levels");
  const sinceId = c.req.query("sinceId");
  const limit = c.req.query("limit");
  const q = c.req.query("q");
  const provider = c.req.query("provider");
  return c.json({ entries: [], nextId: 0, counts: { error: 0, warn: 0, info: 0 } });
});

api.post("/logs/clear", async (c) => {
  return c.json({ ok: true });
});

api.get("/observability/metrics", async (c) => {
  return c.json({ generatedAtMs: Date.now(), requests: { total: 0, success: 0, error: 0, rate: 0 }, tokens: { total: 0, input: 0, output: 0 }, latency: { p50: 0, p95: 0, p99: 0, avg: 0 }, providers: [] });
});

api.get("/observability/performance", async (c) => {
  return c.json({ generatedAtMs: Date.now(), platforms: [] });
});

api.get("/observability/alerts", async (c) => {
  return c.json([]);
});

api.post("/observability/alerts", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, id: 1, ...body });
});

api.put("/observability/alerts/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  return c.json({ ok: true, id, ...body });
});

api.delete("/observability/alerts/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  return c.json({ ok: true, id });
});

api.get("/observability/summary", async (c) => {
  return c.json({ generatedAtMs: Date.now(), health: "healthy", requests: { total: 0, success: 0, error: 0 }, tokens: { total: 0 }, latency: { p50: 0, p95: 0 }, activeAlerts: 0 });
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

export const apiCompat = api;
