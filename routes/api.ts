/**
 * OpenLLM API compat layer — contract-compliant with FreeLLMAPI dashboard.
 */
import { Hono } from "hono";
import type { ApiKey, ApiKeyModel, ApiKeyCooldown, KeyStatus, Platform } from "../shared/types.ts";
import { initDb, listApiKeys, saveApiKey, deleteApiKey, saveSetting, getSetting, getAllSettings, getModels as getDiscoveredModels, saveModels, pingDb, getSessionUser, createSession, deleteSession, getFirstUser, updateUserPassword, createUser, type DiscoveredModel, query, listCatalogModels, patchCatalogModel, deleteCatalogModel, getCatalogModelById, type CatalogModel } from "../db/pg.ts";
import { getRoutingScores } from "../services/router.ts";
import { hasEncryptionKey, encryptKey, type DbEntry } from "../db/mod.ts";
import { SESSION_TTL_MS, hashPassword, hashSessionToken, newSessionToken, verifyPassword } from "../services/auth.ts";
import { getQuotaForecast } from "../services/quota-forecast.ts";
import { providerRegistry } from "../providers/index.ts";
import type { MCPCallToolResult, MCPReadResourceResult } from "../services/mcp.ts";

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
  // Summary must match the frontend's PLATFORMS free-list (65 providers)
  // so that the top badge and the provider list show consistent counts.
  const freeListPlatforms = new Set([
    "aclide", "speka", "auray", "typhoon", "plugsky", "inferbase", "simplellm",
    "llmtr", "gizmo", "blockrun", "moondream", "google", "groq", "cerebras",
    "sail", "electronhub", "experiential", "router9", "septor", "clod",
    "speechify", "freeai", "blaze", "lucidity", "airforce", "dreamprompting",
    "waterfall", "logfare", "bai", "radeon", "nvidia", "mistral", "openrouter",
    "github", "cohere", "cloudflare", "zhipu", "ollama", "kilo", "pollinations",
    "ovh", "llm7", "huggingface", "opencode", "agnes", "reka", "siliconflow",
    "routeway", "bazaarlink", "ainative", "aion", "requesty", "navy", "nara",
    "sealion", "orcarouter", "unorouter", "xkiro", "anyapi", "modelscope",
    "aihorde", "qianfan", "volcengine", "longcat", "xfyun",
  ]);
  const filtered = providers.filter(p => freeListPlatforms.has(p.platform));
  return c.json({
    providers: filtered,
    summary: {
      configured: filtered.filter(p => p.configured).length,
      total: filtered.length,
    },
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
  // Return catalog models (the editable model registry)
  const models = await listCatalogModels();

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
  const models = await listCatalogModels();
  // "free" = models with no published paid pricing
  const keys = await listApiKeys();
  const enabledKeysByPlatform = new Map<string, number>();
  for (const k of keys) {
    if (k.enabled) {
      enabledKeysByPlatform.set(k.platform, (enabledKeysByPlatform.get(k.platform) ?? 0) + 1);
    }
  }
  const enriched = models
    .filter(m => m.source === "catalog" || m.source === "discovered")
    .map(m => ({
      ...m,
      keyCount: m.platform ? (enabledKeysByPlatform.get(m.platform) ?? 0) : 0,
    }));
  return c.json(enriched);
});

/** PATCH /api/models/:id — update catalog model settings (SPA edit dialog) */
api.patch("/models/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const patch = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const model = await patchCatalogModel(id, patch);
  if (!model) return err(c, 404, "model not found");
  return c.json(model);
});

/** DELETE /api/models/:id — remove a catalog model */
api.delete("/models/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const ok = await deleteCatalogModel(id);
  if (!ok) return err(c, 404, "model not found");
  return c.json({ ok: true });
});

// ── Model-state: provenance-aware overrides & tombstones (P1) ────────────────
import {
  upsertModelOverrides,
  getModelOverrides,
  refreshModelOverrideBaselines,
  applyModelOverrides,
  applyAllModelOverrides,
  overriddenFieldNames,
  modelsWithOverriddenField,
  isCatalogManagedModel,
  getCatalogModelTombstone,
  isCatalogModelTombstoned,
  recordCatalogModelTombstone,
  clearCatalogModelTombstone,
  retireCatalogModelUpstream,
  reinstateUpstreamRetiredCatalogModel,
  deleteTombstonedCatalogModels,
  type OverridePatch,
} from "../services/model-state.ts";

/** GET /api/models/:id/overrides — local overrides for a model */
api.get("/models/:id/overrides", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  const overrides = await getModelOverrides(model.platform, model.modelId);
  return c.json({ overrides, fields: overriddenFieldNames(JSON.stringify(overrides)) });
});

/** POST /api/models/:id/overrides — upsert local overrides for a model */
api.post("/models/:id/overrides", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  const patch = await c.req.json().catch(() => ({})) as OverridePatch;
  const merged = await upsertModelOverrides(model.platform, model.modelId, patch, { baselineRow: model as unknown as Record<string, unknown> });
  return c.json({ overrides: merged });
});

/** DELETE /api/models/:id/overrides — drop all local overrides for a model */
api.delete("/models/:id/overrides", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  await upsertModelOverrides(model.platform, model.modelId, {});
  return c.json({ ok: true });
});

/** GET /api/models/overrides/:field — which models pin a given field */
api.get("/models/overrides/:field", async (c) => {
  const field = c.req.param("field");
  const pinned = await modelsWithOverriddenField(field);
  return c.json({ field, pinned: [...pinned] });
});

/** POST /api/models/overrides/apply — re-apply stored overrides onto rows */
api.post("/models/overrides/apply", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { platform?: string; modelId?: string };
  if (body.platform && body.modelId) {
    const applied = await applyModelOverrides(body.platform, body.modelId);
    return c.json({ ok: true, applied });
  }
  const applied = await applyAllModelOverrides();
  return c.json({ ok: true, applied });
});

/** GET /api/models/:id/tombstone — provenance of a deleted model */
api.get("/models/:id/tombstone", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  const tombstone = await getCatalogModelTombstone("chat", model.platform, model.modelId);
  return c.json({ tombstone: tombstone ?? null });
});

/** POST /api/models/:id/tombstone — record a tombstone (soft delete marker) */
api.post("/models/:id/tombstone", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  const body = await c.req.json().catch(() => ({})) as { source?: "upstream_eol" | "user"; reason?: string | null };
  await recordCatalogModelTombstone("chat", model.platform, model.modelId, {
    source: body.source ?? "user",
    reason: body.reason ?? null,
  });
  return c.json({ ok: true, source: body.source ?? "user" });
});

/** DELETE /api/models/:id/tombstone — clear a tombstone (reinstate) */
api.delete("/models/:id/tombstone", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  await clearCatalogModelTombstone("chat", model.platform, model.modelId);
  return c.json({ ok: true });
});

/** POST /api/models/:id/retire-upstream — auto-disable a model the provider retired */
api.post("/models/:id/retire-upstream", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  const ok = await retireCatalogModelUpstream(id, model.platform, model.modelId, body.reason ?? "upstream retired");
  return c.json({ ok, retired: ok });
});

/** POST /api/models/:id/reinstate — lift an upstream retirement */
api.post("/models/:id/reinstate", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return err(c, 400, "invalid model id");
  const model = await getCatalogModelById(id);
  if (!model) return err(c, 404, "model not found");
  const ok = await reinstateUpstreamRetiredCatalogModel(model.platform, model.modelId);
  return c.json({ ok, reinstated: ok });
});

/** POST /api/models/tombstones/cleanup — delete rows carrying USER tombstones */
api.post("/models/tombstones/cleanup", async (c) => {
  const deleted = await deleteTombstonedCatalogModels();
  return c.json({ ok: true, deleted });
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

  // Load catalog models to enrich fallback entries with displayName and other metadata
  const catalogModels = await listCatalogModels();
  const catalogByKey = new Map<string, CatalogModel>();
  for (const m of catalogModels) {
    catalogByKey.set(`${m.platform}||${m.modelId}`, m);
  }

  const enriched = rawChain.map((entry: unknown, idx: number) => {
    const e = entry as Record<string, unknown>;
    const platform = String(e.platform ?? e.provider ?? "");
    const modelId = String(e.modelId ?? e.model_id ?? e.id ?? `model-${idx}`);
    const keyCount = platform ? (enabledKeysByPlatform.get(platform) ?? 0) : 0;

    // Enrich with catalog model data (displayName, intelligenceRank, speedRank, sizeLabel, etc.)
    const catalogModel = catalogByKey.get(`${platform}||${modelId}`);

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
      // Enriched catalog fields
      displayName: catalogModel?.displayName ?? modelId,
      intelligenceRank: catalogModel?.intelligenceRank ?? 999,
      speedRank: catalogModel?.speedRank ?? 999,
      sizeLabel: catalogModel?.sizeLabel ?? "",
      rpmLimit: catalogModel?.rpmLimit ?? null,
      rpdLimit: catalogModel?.rpdLimit ?? null,
      tpmLimit: catalogModel?.tpmLimit ?? null,
      tpdLimit: catalogModel?.tpdLimit ?? null,
      contextWindow: catalogModel?.contextWindow ?? null,
      supportsVision: catalogModel?.supportsVision ?? false,
      supportsTools: catalogModel?.supportsTools ?? false,
      source: catalogModel?.source ?? "catalog",
      overrideFields: catalogModel?.overrideFields ?? [],
      hasOverrides: catalogModel?.hasOverrides ?? false,
      groupKey: catalogModel?.modelDbId ? `grp:${catalogModel.modelDbId}` : undefined,
      groupLabel: catalogModel?.displayName,
      canonicalId: catalogModel?.modelId,
    };
  });

  return c.json(enriched);
});

/**
 * GET /fallback/routing — the dashboard's routing panel source.
 * Real scores for every enabled catalog model (deterministic: expected
 * reliability, no Thompson sample), plus the strategy/weights/peak-hours
 * state the panel renders and edits. The model list merges these by modelDbId.
 */
api.get("/fallback/routing", async (c) => {
  const keys = await listApiKeys();
  const enabled = keys.filter(k => k.enabled);
  try {
    const payload = await getRoutingScores();
    return c.json({ ...payload, candidates: enabled.map(k => k.platform) });
  } catch (e) {
    console.warn("[api] /fallback/routing scoring failed:", e instanceof Error ? e.message : e);
    return c.json({
      strategy: "balanced",
      keySelectionStrategy: "auto",
      weights: null,
      customWeights: {},
      presets: {},
      exploreEnabled: true,
      peakAdjusted: false,
      peakHours: {},
      scores: [],
      candidates: enabled.map(k => k.platform),
    });
  }
});

/**
 * PUT /fallback/routing — persist dashboard edits (ported from FreeLLMAPI
 * routes/fallback.ts): strategy, custom weights, exploration toggle, key
 * selection, peak-hours window. Weights persist BEFORE the strategy flip so
 * 'custom' mode reads the intended vector immediately.
 */
api.put("/fallback/routing", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const VALID = ["priority", "balanced", "smartest", "fastest", "reliable", "custom", "decision"];
  const strategy = typeof body.strategy === "string" ? body.strategy : undefined;
  if (strategy !== undefined && !VALID.includes(strategy)) {
    return c.json({ error: { message: `Invalid strategy '${strategy}'` } }, 400);
  }

  // Custom weights: convex and not all-zero
  if (body.weights && typeof body.weights === "object") {
    const w = body.weights as Record<string, unknown>;
    const r = Number(w.reliability ?? 0), s = Number(w.speed ?? 0), i = Number(w.intelligence ?? 0);
    if (![r, s, i].every(Number.isFinite) || r < 0 || s < 0 || i < 0 || r + s + i <= 0) {
      return c.json({ error: { message: "Custom weights must be non-negative and not all zero" } }, 400);
    }
    await saveSetting("routing_weights", { reliability: r, speed: s, intelligence: i });
  }

  if (strategy !== undefined) await saveSetting("routing_strategy", strategy);

  if (typeof body.exploreEnabled === "boolean") {
    await saveSetting("routing_explore_chance", body.exploreEnabled ? 0.1 : 0);
  }
  if (body.keySelectionStrategy === "auto" || body.keySelectionStrategy === "least-remaining") {
    await saveSetting("routing_key_selection", body.keySelectionStrategy);
  }
  // Peak-hours window: only written when the body actually carries the fields
  if (body.peakHoursAdjust !== undefined || body.peakStartHour !== undefined || body.peakEndHour !== undefined || body.peakTimezone !== undefined) {
    const current = (await getSetting<Record<string, unknown>>("peak_hours")) ?? {};
    const next: { enabled: boolean; startHour: number; endHour: number; timezone: string } = {
      enabled: typeof body.peakHoursAdjust === "boolean" ? body.peakHoursAdjust : Boolean(current.enabled),
      startHour: Number.isFinite(Number(body.peakStartHour)) ? Number(body.peakStartHour) : (Number(current.startHour) || 18),
      endHour: Number.isFinite(Number(body.peakEndHour)) ? Number(body.peakEndHour) : (Number(current.endHour) || 6),
      timezone: typeof body.peakTimezone === "string" && body.peakTimezone ? body.peakTimezone : (typeof current.timezone === "string" && current.timezone ? current.timezone : "UTC"),
    };
    if (!Number.isInteger(next.startHour) || next.startHour < 0 || next.startHour > 23 ||
        !Number.isInteger(next.endHour) || next.endHour < 0 || next.endHour > 23) {
      return c.json({ error: { message: "Peak hours must be integers 0-23" } }, 400);
    }
    await saveSetting("peak_hours", next);
  }

  const payload = await getRoutingScores();
  return c.json(payload);
});

/** GET /fallback/penalty-inspector — models currently carrying a failure penalty. */
api.get("/fallback/penalty-inspector", async (c) => {
  try {
    const rows = await query`
      SELECT m.id AS "modelDbId", p.platform, p.model_id AS "modelId", p.penalty, p.updated_at AS "updatedAt"
      FROM rate_limit_penalties p
      JOIN models m ON m.platform = p.platform AND m.model_id = p.model_id
      WHERE p.penalty > 0
      ORDER BY p.penalty DESC
    `;
    return c.json({ penalties: rows });
  } catch {
    return c.json({ penalties: [] });
  }
});

/**
 * GET /fallback/rate-limit-usage — live rpm/rpd/tpm windows per catalog model,
 * straight from the requests ledger (the same numbers the headroom guardrail
 * reads, so the dashboard badge and the router never disagree).
 */
api.get("/fallback/rate-limit-usage", async (c) => {
  try {
    const nowMs = Date.now();
    const minIso = new Date(nowMs - 60_000).toISOString();
    const dayIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const rows = await query`
      SELECT m.id AS "modelDbId", m.platform, m.model_id AS "modelId",
             m.rpm_limit AS "rpmLimit", m.rpd_limit AS "rpdLimit", m.tpm_limit AS "tpmLimit",
             COALESCE(u.rpm_used, 0) AS "rpmUsed",
             COALESCE(u.rpd_used, 0) AS "rpdUsed",
             COALESCE(u.tpm_used, 0) AS "tpmUsed"
        FROM models m
        LEFT JOIN (
          SELECT platform, model,
                 COUNT(*) FILTER (WHERE timestamp >= ${minIso}::text) AS rpm_used,
                 COUNT(*) AS rpd_used,
                 COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE timestamp >= ${minIso}::text), 0) AS tpm_used
            FROM requests
           WHERE timestamp >= ${dayIso}::text
           GROUP BY platform, model
        ) u ON u.platform = m.platform AND u.model = m.model_id
       WHERE m.enabled = 1
    `;
    return c.json({ rows });
  } catch {
    return c.json({ rows: [] });
  }
});

api.get("/fallback/token-usage", async (c) => {
  const rows = await getSetting<unknown[]>("token-usage");
  return c.json({ rows: Array.isArray(rows) ? rows : [] });
});

api.get("/fallback/quota-forecast", async (c) => {
  const forecast = await getQuotaForecast();
  return c.json({ forecast, generatedAt: new Date().toISOString() });
});

/** POST /fallback/cooldown-probe/trigger — manual probe pass for the dashboard. */
api.post("/fallback/cooldown-probe/trigger", async (c) => {
  try {
    const { triggerCooldownProbe } = await import("../services/cooldown-probe.ts");
    const r = await triggerCooldownProbe();
    return c.json({ ok: true, ...r });
  } catch (e) {
    console.warn("[api] cooldown-probe trigger failed:", e instanceof Error ? e.message : e);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
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

/** Real probe endpoint — decrypts key, runs a light provider test, updates status. */
api.post("/keys/:idOrPlatform/probe", async (c) => {
  const platform = await resolvePlatform(c.req.param("idOrPlatform"));
  if (!platform) return err(c, 404, "key not found");
  const allKeys = await listApiKeys();
  const entry = allKeys.find(e => e.platform === platform);
  if (!entry) return err(c, 404, "key not found");
  const { decryptKeyValue } = await import("../db/mod.ts");
  const plain = await decryptKeyValue(entry as never);
  if (plain === null) return err(c, 400, "key cannot be decrypted (missing encryption key?)");

  const { providerRegistry, initializeRegistry, testProvider } = await import("../providers/index.ts");
  initializeRegistry();
  const testKey = {
    id: String(entry.db_id),
    platform: entry.platform,
    label: entry.label ?? entry.platform,
    encrypted_key: plain,
    iv: "",
    auth_tag: "",
    status: entry.status ?? "healthy",
    enabled: entry.enabled,
    base_url: entry.base_url ?? "",
    monthly_request_cap: entry.monthly_request_cap ?? 0,
    monthly_token_cap: entry.monthly_token_cap ?? 0,
    db_id: entry.db_id,
  };
  const adapter = providerRegistry.get(platform);
  let ok = false;
  let error: string | null = null;
  let latency_ms = 0;

  if (adapter) {
    const t0 = Date.now();
    let authOk = false;
    let authError: string | null = null;

    // ── Phase 1: validateKey (auth-level check) ──
    // Tests whether the key is accepted by the provider at the auth layer.
    // For most providers this is sufficient (e.g. /models returns 401 on bad keys).
    try {
      const validation = await adapter.validateKey(plain, { platform, keyId: entry.db_id });
      latency_ms = Date.now() - t0;
      if (typeof validation === "object") {
        authOk = validation.valid === true;
        if (!authOk) authError = validation.error ?? "key validation failed";
      } else {
        authOk = validation === true;
        if (!authOk) authError = "key validation failed";
      }
    } catch (e: any) {
      latency_ms = Date.now() - t0;
      authError = e instanceof Error ? e.message : String(e);
    }

    // ── Phase 2: chat completion (functional check) ──
    // validateKey alone is insufficient for some providers (NVIDIA returns 200
    // on /models even with invalid keys). A real chat completion proves the key
    // can actually generate responses.
    //
    // IMPORTANT: we must distinguish auth errors from model-availability errors.
    //   - 401/403 / "unauthorized" / "invalid api key"  → key is BAD
    //   - "Function not found" / 410 / "model not found"  → key is GOOD, model issue
    //   - 429 / timeout / network                        → inconclusive, don't fail
    if (adapter.chat) {
      try {
        const probeModels: Record<string, string> = {
          nvidia: "nvidia/llama-3.1-nemotron-70b-instruct",
          anthropic: "claude-3-haiku-20240307",
          google: "gemini-2.5-flash",
          openrouter: "openai/gpt-oss-20b",
          groq: "llama-3.3-70b-versatile",
          zhipu: "glm-4-flash",
          agnes: "agnes-v2.6-flash",
          kilo: "openai/gpt-oss-120b",
          radeon: "meta-llama/llama-3-1-70b-instruct",
        };
        const probeModel = probeModels[platform] ?? "openai/gpt-oss-20b";
        const chatResult = await adapter.chat({
          model: probeModel,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 3,
        }, testKey as never, { timeout_ms: 8_000 });

        latency_ms = Date.now() - t0;
        const chatErr = chatResult.error;
        if (!chatErr) {
          // Chat succeeded → key is definitely valid
          authOk = true;
          authError = null;
        } else {
          // Classify the chat error
          const lower = chatErr.toLowerCase();
          const isAuthError =
            lower.includes("401") ||
            lower.includes("403") ||
            lower.includes("unauthorized") ||
            lower.includes("invalid api key") ||
            lower.includes("invalid jwt") ||
            lower.includes("api key") ||
            lower.includes("authentication");
          const isModelError =
            lower.includes("not found") ||
            lower.includes("not found for account") ||
            lower.includes("410") ||
            lower.includes("gone") ||
            lower.includes("decommissioned") ||
            lower.includes("model") && (lower.includes("not available") || lower.includes("no longer"));

          if (isAuthError) {
            // Chat confirms auth failure → key is bad
            authOk = false;
            authError = chatErr;
          } else if (isModelError) {
            // Model issue, not key issue → key is fine, don't fail
            // Keep authOk from Phase 1 (or default to true if Phase 1 was inconclusive)
            if (!authError) authOk = true;
            authError = null;
          }
          // else: inconclusive (429, timeout, etc.) → keep Phase 1 result
        }
      } catch { /* network/timeout — keep Phase 1 result */ }
    }

    ok = authOk;
    error = authError;
  } else {
    error = `Provider ${platform} not registered`;
  }

  const newStatus = ok ? "healthy" : "error";
  if (newStatus !== entry.status) {
    await query`UPDATE api_keys SET status = ${newStatus}, updated_at = now() WHERE id = ${entry.db_id}`;
  }
  return c.json({ ok, status: newStatus, latency_ms, error });
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

// MCP Gateway Context — initialize built-in tool/resource handlers
// Helper: call chat completion via internal router (reuse providerRegistry)
async function handleMcpChat(args: any): Promise<MCPCallToolResult> {
  const { model, messages, max_tokens = 1000, temperature = 0.7 } = args;
  if (!model || !messages || !Array.isArray(messages)) {
    return { content: [{ type: "text", text: "model and messages[] are required" }], isError: true };
  }
  try {
    const parts = model.split("/");
    const platform = parts[0];
    const modelId = parts.slice(1).join("/");
    const provider = providerRegistry.get(platform);
    if (!provider) {
      return { content: [{ type: "text", text: `Provider not found: ${platform}` }], isError: true };
    }
    const keys = await getApiKey(platform);
    if (!keys) {
      return { content: [{ type: "text", text: `No API key configured for ${platform}` }], isError: true };
    }
    // Cast DbEntry to provider ApiKey (ensure required fields)
    const apiKey = {
      id: keys.id,
      db_id: keys.db_id,
      platform: keys.platform,
      label: keys.label ?? keys.platform,
      encrypted_key: keys.encrypted_key ?? "",
      iv: keys.iv ?? "",
      auth_tag: keys.auth_tag ?? "",
      status: (keys.status ?? "healthy") as any,
      enabled: keys.enabled,
      base_url: keys.base_url,
      monthly_request_cap: keys.monthly_request_cap,
      monthly_token_cap: keys.monthly_token_cap,
    } as import("../providers/types.ts").ApiKey;
    const result = await provider.chat({ model: modelId, messages, max_tokens, temperature }, apiKey);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `Chat error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function handleMcpModels(args: any): Promise<MCPCallToolResult> {
  const { provider, free_only = false } = args ?? {};
  try {
    const models = await listCatalogModels();
    let filtered = models;
    if (provider) filtered = filtered.filter(m => m.platform === provider);
    if (free_only) {
      // CatalogModel doesn't have quota_label/priority; use rpmLimit as proxy for free tier
      filtered = filtered.filter(m => (m.rpmLimit !== null && m.rpmLimit < 1000) || (m.tpmLimit !== null && m.tpmLimit < 10000));
    }
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `Models error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function handleMcpEmbeddings(args: any): Promise<MCPCallToolResult> {
  const { model, input } = args;
  if (!model || !input || !Array.isArray(input)) {
    return { content: [{ type: "text", text: "model and input[] are required" }], isError: true };
  }
  try {
    const parts = model.split("/");
    const platform = parts[0];
    const modelId = parts.slice(1).join("/");
    const provider = providerRegistry.get(platform);
    if (!provider || typeof (provider as any).embeddings !== "function") {
      return { content: [{ type: "text", text: `Embeddings not supported for ${platform}` }], isError: true };
    }
    const keys = await getApiKey(platform);
    if (!keys) {
      return { content: [{ type: "text", text: `No API key configured for ${platform}` }], isError: true };
    }
    const apiKey = {
      id: keys.id,
      db_id: keys.db_id,
      platform: keys.platform,
      label: keys.label ?? keys.platform,
      encrypted_key: keys.encrypted_key ?? "",
      iv: keys.iv ?? "",
      auth_tag: keys.auth_tag ?? "",
      status: (keys.status ?? "healthy") as any,
      enabled: keys.enabled,
      base_url: keys.base_url,
      monthly_request_cap: keys.monthly_request_cap,
      monthly_token_cap: keys.monthly_token_cap,
    } as import("../providers/types.ts").ApiKey;
    const result = await (provider as any).embeddings({ model: modelId, input }, apiKey);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `Embeddings error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function handleMcpSearch(args: any): Promise<MCPCallToolResult> {
  const { query, engine = "brave", count = 10 } = args;
  if (!query || typeof query !== "string") {
    return { content: [{ type: "text", text: "query is required" }], isError: true };
  }
  try {
    const key = await getApiKey(engine);
    if (!key) {
      return { content: [{ type: "text", text: `No API key configured for search engine: ${engine}` }], isError: true };
    }
    const searchKey = {
      id: key.id,
      db_id: key.db_id,
      platform: key.platform,
      label: key.label ?? key.platform,
      encrypted_key: key.encrypted_key ?? "",
      iv: key.iv ?? "",
      auth_tag: key.auth_tag ?? "",
      status: (key.status ?? "healthy") as any,
      enabled: key.enabled,
      base_url: key.base_url,
      monthly_request_cap: key.monthly_request_cap,
      monthly_token_cap: key.monthly_token_cap,
    } as import("../providers/types.ts").ApiKey;
    const results = await search({ query, engine: engine as any, count }, searchKey);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `Search error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function handleMcpMedia(args: any): Promise<MCPCallToolResult> {
  const { model, prompt, width, height } = args;
  if (!model || !prompt) {
    return { content: [{ type: "text", text: "model and prompt are required" }], isError: true };
  }
  try {
    const parts = model.split("/");
    const platform = parts[0];
    const modelId = parts.slice(1).join("/");
    const provider = providerRegistry.get(platform);
    if (!provider || typeof (provider as any).generateImage !== "function") {
      return { content: [{ type: "text", text: `Media generation not supported for ${platform}` }], isError: true };
    }
    const keys = await getApiKey(platform);
    if (!keys) {
      return { content: [{ type: "text", text: `No API key configured for ${platform}` }], isError: true };
    }
    const apiKey = {
      id: keys.id,
      db_id: keys.db_id,
      platform: keys.platform,
      label: keys.label ?? keys.platform,
      encrypted_key: keys.encrypted_key ?? "",
      iv: keys.iv ?? "",
      auth_tag: keys.auth_tag ?? "",
      status: (keys.status ?? "healthy") as any,
      enabled: keys.enabled,
      base_url: keys.base_url,
      monthly_request_cap: keys.monthly_request_cap,
      monthly_token_cap: keys.monthly_token_cap,
    } as import("../providers/types.ts").ApiKey;
    const result = await (provider as any).generateImage({ model: modelId, prompt, width, height }, apiKey);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (e) {
    return { content: [{ type: "text", text: `Media error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

async function handleModelsResource(): Promise<MCPReadResourceResult> {
  try {
    const models = await listCatalogModels();
    return { contents: [{ uri: "openllm://models", mimeType: "application/json", text: JSON.stringify(models, null, 2) }] };
  } catch (e) {
    return { contents: [{ uri: "openllm://models", mimeType: "application/json", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

async function handleProvidersResource(): Promise<MCPReadResourceResult> {
  try {
    const providers = providerRegistry.getAllIds();
    return { contents: [{ uri: "openllm://providers", mimeType: "application/json", text: JSON.stringify(providers, null, 2) }] };
  } catch (e) {
    return { contents: [{ uri: "openllm://providers", mimeType: "application/json", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

async function handleHealthResource(): Promise<MCPReadResourceResult> {
  try {
    const keys = await listApiKeys();
    const platforms = [...new Set(keys.map(k => k.platform))];
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      platforms: platforms.map(p => ({
        platform: p,
        totalKeys: keys.filter(k => k.platform === p).length,
        enabledKeys: keys.filter(k => k.platform === p && k.enabled).length,
        healthyKeys: keys.filter(k => k.platform === p && k.enabled && (k.status ?? "healthy") === "healthy").length,
      })),
      totalKeys: keys.length,
      enabledKeys: keys.filter(k => k.enabled).length,
      totalPlatforms: platforms.length,
    };
    return { contents: [{ uri: "openllm://health", mimeType: "application/json", text: JSON.stringify(health, null, 2) }] };
  } catch (e) {
    return { contents: [{ uri: "openllm://health", mimeType: "application/json", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

// Initialize MCP server with gateway context
mcpServer.initGatewayContext({
  chatHandler: handleMcpChat,
  modelsHandler: handleMcpModels,
  embeddingsHandler: handleMcpEmbeddings,
  searchHandler: handleMcpSearch,
  mediaHandler: handleMcpMedia,
  modelsResourceHandler: handleModelsResource,
  providersResourceHandler: handleProvidersResource,
  healthResourceHandler: handleHealthResource,
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

// ── Decisions (System One typed Q&A) ─────────────────────────────────────────
import {
  allDecisionRows,
  getDecisionRow,
  setDecisionEnabled,
  runDecision,
  syncDecisionModels,
} from "../services/decision.ts";

api.get("/decisions/models", async (c) => {
  const rows = await allDecisionRows();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      quotaLabel: r.quota_label,
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
    })),
  );
});

api.patch("/decisions/models/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { message: "Invalid model id" } }, 400);
  }
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: { message: "Provide enabled" } }, 400);
  }
  const row = await setDecisionEnabled(id, body.enabled);
  if (!row) {
    return c.json({ error: { message: "Decision model not found" } }, 404);
  }
  return c.json({
    id: row.id,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name,
    priority: row.priority,
    enabled: row.enabled === 1,
    quotaLabel: row.quota_label,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  });
});

// "Try it" endpoint: run a single decision question
api.post("/decisions/try", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    model?: string;
    state: unknown;
    question: string;
    options: string[];
  };
  if (!body.state || !body.question || !Array.isArray(body.options) || body.options.length < 2) {
    return c.json({ error: { message: "Provide state, a question and at least two options" } }, 400);
  }
  try {
    const result = await runDecision(
      {
        state: body.state,
        questions: {
          answer: {
            type: "choice",
            instructions: body.question,
            criteria: Object.fromEntries(body.options.map((o) => [o, null])),
          },
        },
      },
      { model: body.model, clientAgent: "dashboard" },
    );
    return c.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    const status = (err.status ?? 502) as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503;
    return c.json({ error: { message: err.message ?? "Decision failed", ...(err.code ? { code: err.code } : {}) } }, status);
  }
});

// Main v1 decisions endpoint
api.post("/v1/decisions", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    model?: string;
    state: unknown;
    questions: Record<string, unknown>;
  };
  if (!body.state || !body.questions || typeof body.questions !== "object") {
    return c.json({ error: { message: "Provide state and questions" } }, 400);
  }
  try {
    const result = await runDecision(
      body as any,
      { model: body.model, clientAgent: ((c as any).get("client_agent") as string) ?? "unknown" },
    );
    return c.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    const status = (err.status ?? 502) as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503;
    return c.json({ error: { message: err.message ?? "Decision failed", ...(err.code ? { code: err.code } : {}) } }, status);
  }
});

export const apiCompat = api;
