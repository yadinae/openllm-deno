/**
 * Signed-catalog sync — imports FreeLLM API's curated catalog feed.
 *
 * WHY THIS EXISTS:
 * The port's own discovery dumps every row a provider's /models returns,
 * so nothing proves a model is actually free-tier. 531 of 893 catalogued
 * models have no freeness evidence at all. The upstream feed is curated,
 * signed (historically), and anonymously readable; membership in it IS the
 * free-tier guarantee (the payload carries no free flag because everything
 * in it is free).
 *
 * CURRENT STATE (2026-10-20):
 * - Feed endpoint: https://api.freellmapi.co/v1/latest  (no auth required)
 * - Feed structure: { version, generatedAt, tier, models: [...] }
 * - 395 models across 33 platforms, all enabled, all free-tier
 * - NO signature field in the JSON — the historical Ed25519 verification
 *   is no longer needed for the public monthly tier.
 */

import { query, queryRaw, saveSetting, getSetting, initDb } from "../db/pg.ts";

const CATALOG_URL = "https://api.freellmapi.co/v1/latest";
const CATALOG_VERSION_KEY = "catalog_version";
const CATALOG_SYNCED_AT_KEY = "catalog_synced_at";
const CATALOG_SYNC_ERROR_KEY = "catalog_sync_error";

/** Chat model entry from the signed catalog. */
export interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: {
    rpm: number | null;
    rpd: number | null;
    tpm: number | null;
    tpd: number | null;
  };
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  quirks?: Array<{ slug: string; title: string; body: string; severity: string; targets: any[] }>;
}

/** Full catalog payload. */
export interface SignedCatalog {
  version: string;
  generatedAt: string;
  tier: string;
  models: CatalogModel[];
  embeddings?: any[];
  transcriptionModels?: any[];
  videoModels?: any[];
  searchEngines?: any[];
  decisionModels?: any[];
  quirks?: any[];
  platforms?: any[];
}

/** Parse the catalog payload; throws if shape is wrong. */
export function parseCatalogPayload(raw: unknown): SignedCatalog {
  if (!raw || typeof raw !== "object") throw new Error("Catalog: not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "string") throw new Error("Catalog: missing version");
  if (!Array.isArray(o.models)) throw new Error("Catalog: models not an array");
  return o as unknown as SignedCatalog;
}

/** Fetch the signed catalog with timeout. */
export async function fetchSignedCatalog(timeoutMs = 30_000): Promise<SignedCatalog> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(CATALOG_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
    return parseCatalogPayload(json);
  } finally {
    clearTimeout(timer);
  }
}

/** Sync the catalog into the DB. */
export async function syncSignedCatalog(): Promise<{
  ok: boolean;
  version?: string;
  upserted: number;
  retired: number;
  error?: string;
}> {
  await initDb();

  let catalog: SignedCatalog;
  try {
    catalog = await fetchSignedCatalog();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await saveSetting(CATALOG_SYNC_ERROR_KEY, err);
    return { ok: false, upserted: 0, retired: 0, error: err };
  }

  const version = catalog.version;
  const nowIso = new Date().toISOString();
  const feedModels = catalog.models.filter((m) => m.enabled);
  const keys = feedModels.map((m) => `('${m.platform.replace(/'/g, "''")}','${m.modelId.replace(/'/g, "''")}')`).join(",");

  // 1) Upsert catalog models (chat models)
  // We UPDATE all columns from the feed EXCEPT `enabled` (operator choice) and `source` (preserve provenance).
  // `in_catalog` is set TRUE for every feed row.
  let upserted = 0;
  if (feedModels.length > 0) {
    // Build a single multi-row INSERT ... ON CONFLICT DO UPDATE
    const placeholders: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const m of feedModels) {
      placeholders.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
      );
      params.push(
        m.platform,
        m.modelId,
        m.displayName,
        m.intelligenceRank,
        m.speedRank,
        m.sizeLabel,
        m.limits.rpm,
        m.limits.rpd,
        m.limits.tpm,
        m.limits.tpd,
        m.monthlyTokenBudget,
        m.contextWindow,
        m.enabled ? 1 : 0,
        m.supportsVision ? 1 : 0,
        m.supportsTools ? 1 : 0,
        null, // paid_input_per_m — not in catalog
        null, // paid_output_per_m
        "signed-catalog",
        1, // in_catalog
        "", // endpoint_scope
      );
    }
    const sql = `
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
        monthly_token_budget, context_window, enabled, supports_vision,
        supports_tools, paid_input_per_m, paid_output_per_m, source, in_catalog, endpoint_scope
      ) VALUES ${placeholders.join(",")}
      ON CONFLICT (platform, model_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        intelligence_rank = EXCLUDED.intelligence_rank,
        speed_rank = EXCLUDED.speed_rank,
        size_label = EXCLUDED.size_label,
        rpm_limit = EXCLUDED.rpm_limit,
        rpd_limit = EXCLUDED.rpd_limit,
        tpm_limit = EXCLUDED.tpm_limit,
        tpd_limit = EXCLUDED.tpd_limit,
        monthly_token_budget = EXCLUDED.monthly_token_budget,
        context_window = EXCLUDED.context_window,
        -- DO NOT update \`enabled\` — operator choice wins
        supports_vision = EXCLUDED.supports_vision,
        supports_tools = EXCLUDED.supports_tools,
        -- DO NOT update \`paid_input_per_m\` / \`paid_output_per_m\` — catalog has no price
        source = COALESCE(models.source, 'catalog'), -- only set on first insert
        in_catalog = 1,
        endpoint_scope = COALESCE(models.endpoint_scope, '')
    `;
    await queryRaw(sql, params);
    upserted = feedModels.length;
  }

  // 2) Retire models that were in_catalog but are NOT in this feed version
  // They lose free-tier evidence and must drop out of auto-routing.
  const retireSql = `
    UPDATE models
    SET in_catalog = 0
    WHERE in_catalog = 1
      AND (platform, model_id) NOT IN (${keys})
  `;
  const retireResult = await queryRaw(retireSql, []);
  const retired = Array.isArray(retireResult) ? retireResult.length : 0;

  // 3) Persist sync metadata
  await saveSetting(CATALOG_VERSION_KEY, version);
  await saveSetting(CATALOG_SYNCED_AT_KEY, nowIso);
  await saveSetting(CATALOG_SYNC_ERROR_KEY, null);

  console.log(`[catalog-sync] ${version} upserted=${upserted} retired=${retired}`);
  return { ok: true, version, upserted, retired };
}

/** Manual trigger for admin dashboard. */
export async function manualSync(): Promise<{
  ok: boolean;
  version?: string;
  upserted: number;
  retired: number;
  error?: string;
}> {
  return syncSignedCatalog();
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Compatibility layer for routes/premium.ts (legacy license/catalog sync API)
 * These functions read/write the same settings keys but with the old names.
 * They do NOT implement the full Ed25519/license logic — the upstream monthly
 * tier no longer requires it. They exist only so premium.ts compiles.
 * ───────────────────────────────────────────────────────────────────────────── */

export const SETTING_LICENSE_KEY = "premium_license_key";
export const SETTING_LICENSE_STATUS = "premium_license_status";
export const SETTING_APPLIED_VERSION = CATALOG_VERSION_KEY;
export const SETTING_APPLIED_TIER = "catalog_applied_tier";
export const SETTING_APPLIED_JSON = "catalog_applied_json";
export const SETTING_LAST_SYNC_MS = CATALOG_SYNCED_AT_KEY;
export const SETTING_LAST_ERROR = CATALOG_SYNC_ERROR_KEY;

export const DEFAULT_BASE_URL = "https://api.freellmapi.co";
export const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const BOOT_DELAY_MS = 10 * 1000;
export const FETCH_TIMEOUT_MS = 20 * 1000;

// PINNED_CATALOG_PUBKEY kept for compatibility (unused)
export const PINNED_CATALOG_PUBKEY = "";

export function catalogBaseUrl(): string {
  return (Deno.env.get("CATALOG_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function catalogPublicKey(): string {
  return Deno.env.get("CATALOG_PUBKEY") ?? PINNED_CATALOG_PUBKEY;
}

export interface LicenseStatus {
  valid: boolean;
  plan: "annual" | "lifetime" | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

export interface CatalogSyncState {
  baseUrl: string;
  appliedVersion: string | null;
  appliedTier: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
}

export async function getCachedLicenseStatus(): Promise<LicenseStatus | null> {
  const status = await getSetting<LicenseStatus>(SETTING_LICENSE_STATUS);
  return status ?? null;
}

export async function getSyncState(): Promise<CatalogSyncState> {
  const [version, tier, lastSyncMs, lastError] = await Promise.all([
    getSetting<string>(SETTING_APPLIED_VERSION),
    getSetting<string>(SETTING_APPLIED_TIER),
    getSetting<number>(SETTING_LAST_SYNC_MS),
    getSetting<string>(SETTING_LAST_ERROR),
  ]);
  return {
    baseUrl: catalogBaseUrl(),
    appliedVersion: version ?? null,
    appliedTier: tier ?? null,
    lastSyncMs: lastSyncMs ?? null,
    lastError: lastError ?? null,
  };
}

export async function validateLicenseKey(key: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ valid: boolean; reason?: string } | null> {
  try {
    const baseUrl = catalogBaseUrl();
    const url = new URL(`${baseUrl}/v1/license/activate`);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json() as { valid: boolean; reason?: string };
  } catch {
    return null;
  }
}

export async function refreshLicenseStatus(): Promise<LicenseStatus | null> {
  const key = await getSetting<string>(SETTING_LICENSE_KEY);
  if (!key) return null;
  try {
    const result = await validateLicenseKey(key);
    if (!result) return getCachedLicenseStatus();
    const status: LicenseStatus = {
      valid: result.valid,
      plan: null,
      status: result.valid ? "active" : "invalid",
      expiresAt: null,
      cancelAtPeriodEnd: false,
      reason: result.reason,
      checkedAtMs: Date.now(),
    };
    await saveSetting(SETTING_LICENSE_STATUS, status);
    return status;
  } catch {
    return getCachedLicenseStatus();
  }
}

export async function syncCatalog(force = false): Promise<{ success: boolean; error?: string }> {
  try {
    if (!force) {
      const lastSyncMs = await getSetting<number>(SETTING_LAST_SYNC_MS);
      if (lastSyncMs != null && Date.now() - lastSyncMs < SYNC_INTERVAL_MS) {
        return { success: true };
      }
    }
    await refreshLicenseStatus();
    const r = await syncSignedCatalog();
    return { success: r.ok, error: r.error };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[catalog-sync] Error syncing catalog:", errorMsg);
    await saveSetting(SETTING_LAST_ERROR, errorMsg.substring(0, 200));
    return { success: false, error: errorMsg };
  }
}

export function startCatalogSync(): void {
  setTimeout(() => {
    syncCatalog(false).then((result) => {
      if (!result.success) console.warn("[catalog-sync] Initial sync failed:", result.error);
    });
  }, BOOT_DELAY_MS);
  setInterval(() => {
    syncCatalog(false).then((result) => {
      if (!result.success) console.warn("[catalog-sync] Periodic sync failed:", result.error);
    });
  }, SYNC_INTERVAL_MS);
}