/**
 * Signed-catalog sync — imports FreeLLM API's curated catalog feed.
 *
 * WHY THIS EXISTS:
 * The port's own discovery dumps every row a provider's /models returns,
 * so nothing proves a model is actually free-tier. The upstream feed is
 * curated, signed (Ed25519), and anonymously readable; membership in it IS
 * the free-tier guarantee (the payload carries no free flag because
 * everything in it is free).
 *
 * Ported from FreeLLMAPI server/src/services/catalog-sync.ts (56 KB).
 * Adapted for:
 *  - Deno Deploy: Web Crypto API for Ed25519 (no Node crypto module)
 *  - Postgres: async queryRaw instead of SQLite prepare/run
 *  - providerRegistry.getAllIds() instead of hasProvider()
 *  - profile_auto_include table instead of profiles.auto_include_new_models
 *
 * The monthly tier is anonymously readable; a valid license key (Bearer)
 * gets the live tier, refreshed every 2–3 days. The response body is
 * verified against a pinned Ed25519 public key over the exact bytes received;
 * anything unsigned or tampered with is discarded.
 */

import { query, queryRaw, saveSetting, getSetting, initDb } from "../db/pg.ts";
import { providerRegistry } from "../providers/index.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.freellmapi.co";

// The Ed25519 public key the production catalog is signed with. The private
// half was generated on the catalog host and has never left it. Self-hosters
// running their own catalog server can override both via env.
const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=\n-----END PUBLIC KEY-----\n`;

// Catalogs older than this are ignored. Bump to today's date whenever a model
// migration lands, so the bundled DB is always the floor.
export const MIN_CATALOG_VERSION = "2026.06.07";

const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice daily
const BOOT_DELAY_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;

// Settings table keys
export const SETTING_LICENSE_KEY = "premium_license_key";
export const SETTING_LICENSE_STATUS = "premium_license_status";
export const SETTING_APPLIED_VERSION = "catalog_applied_version";
export const SETTING_APPLIED_TIER = "catalog_applied_tier";
export const SETTING_APPLIED_JSON = "catalog_applied_json";
export const SETTING_LAST_SYNC_MS = "catalog_last_sync_ms";
export const SETTING_LAST_ERROR = "catalog_last_error";

// Model source provenance
export const DISCOVERED_MODEL_SOURCE = "discovered";

// ── Platform sets (ported from FreeLLMAPI services/media.ts, search.ts, etc.) ──
// These gate which platforms can receive catalog-managed rows for each modality.

const MEDIA_PLATFORMS = new Set([
  "nvidia", "pollinations", "cloudflare", "siliconflow", "google",
  "speechify", "electronhub", "freeai",
]);

const VIDEO_PLATFORMS = new Set(["pollinations", "huggingface"]);

const TRANSCRIPTION_PLATFORMS = new Set(["groq", "cloudflare", "typhoon"]);

const EMBEDDING_PLATFORMS = new Set([
  "google", "nvidia", "openrouter", "cloudflare", "huggingface",
  "cohere", "sealion", "speka", "electronhub", "inferbase", "auray", "llmtr",
]);

const SEARCH_MODALITY = "search";
const SEARCH_ENGINE_PLATFORMS = new Set([
  "tavily", "exa", "firecrawl", "linkup", "serpsearch", "beatapi",
  "apinex", "router9", "septor", "blockrun", "waterfall", "simplellm",
  "experiential", "lucidity", "dreamprompting",
  "airforce", "logfare", "plugsky", "gizmo", "moonshot", "minimax",
  "reka", "speka", "typhoon", "clod", "auray", "electronhub", "freeai",
  "mistral", "cohere", "google", "huggingface", "inferbase", "llmtr",
  "modelscope", "zhipu", "cerebras",
]);

const DECISION_MODALITY = "decision";
const DECISION_PLATFORMS = new Set([
  "cloudflare", "openrouter", "opencode", "google", "nvidia", "mistral",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LicenseStatus {
  valid: boolean;
  plan: "annual" | "lifetime" | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: "blocker" | "warning" | "info";
  targets: { platform: string | null; modelGlob: string | null }[];
}

interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  monthlyTokenBudget: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  modality?: string;
}

interface CatalogEmbedding {
  family: string;
  platform: string;
  modelId: string;
  displayName: string;
  dimensions: number;
  maxInputTokens: number | null;
  priority: number;
  enabled: boolean;
  quotaLabel: string;
}

interface CatalogTranscriptionModel {
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  subtitleFormats?: string[];
  maxBytes?: number | null;
  requestStyle?: string | null;
  quotaLabel?: string;
}

interface CatalogVideoModel {
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel?: string;
  providerModelId?: string;
}

interface CatalogSearchEngine {
  platform: string;
  engineId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel?: string;
  creditsPerQuery?: number | null;
  features?: { news?: boolean; answer?: boolean; fullContent?: boolean };
  premiumSince?: string;
}

interface CatalogDecisionModel {
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel?: string;
  contextWindow?: number;
  premiumSince?: string;
}

interface Catalog {
  version: string;
  generatedAt: string;
  tier: "live" | "monthly";
  models: CatalogModel[];
  embeddings?: CatalogEmbedding[];
  transcriptionModels?: CatalogTranscriptionModel[];
  videoModels?: CatalogVideoModel[];
  searchEngines?: CatalogSearchEngine[];
  decisionModels?: CatalogDecisionModel[];
  managedPlatforms?: string[];
  quirks: CatalogQuirk[];
}

export interface SyncResult {
  ok: boolean;
  action: "applied" | "up_to_date" | "skipped_older" | "error";
  version?: string;
  tier?: string;
  detail?: string;
  counts?: {
    updated: number;
    inserted: number;
    removed: number;
    skippedUnknownPlatform: number;
    quirks: number;
  };
}

// ── Ed25519 Signature Verification ────────────────────────────────────────────
// Uses Deno Deploy's Web Crypto API (no Node crypto module available).

/** Base64-decode to Uint8Array. */
function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

/** Parse a PEM string → DER Uint8Array. */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return base64Decode(b64);
}

/**
 * Extract the raw 32-byte Ed25519 public key from a PKCS#8 SPKI DER blob.
 *
 * DER layout:
 *   30 len   SEQUENCE (outer)
 *   30 len   SEQUENCE (inner)
 *   06 len   OID 1.3.101.112 (Ed25519)
 *   03 len   BIT STRING
 *   00      unused bits
 *   <32-byte key>
 */
function extractRawEd25519Pubkey(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset] !== 0x30) throw new Error("Expected SEQUENCE");
  // Outer SEQUENCE
  const outerLen = der[offset + 1];
  offset = outerLen < 0x80 ? 2 : 2 + (outerLen & 0x7f);
  // Inner SEQUENCE
  if (der[offset] !== 0x30) throw new Error("Expected inner SEQUENCE");
  const innerLen = der[offset + 1];
  offset += innerLen < 0x80 ? 2 : 2 + (innerLen & 0x7f);
  // OID
  if (der[offset] !== 0x06) throw new Error("Expected OID");
  const oidLen = der[offset + 1];
  offset += oidLen < 0x80 ? 2 + oidLen : 2 + (oidLen & 0x7f);
  // BIT STRING
  if (der[offset] !== 0x03) throw new Error("Expected BIT STRING");
  offset += 2; // tag + length (33 fits in short form for Ed25519)
  offset += 1; // skip unused-bits byte
  return der.slice(offset, offset + 32);
}

/**
 * Verify an Ed25519 signature over the catalog body bytes.
 */
async function verifySignature(
  body: Uint8Array,
  signature: string,
  pubkeyPem: string,
): Promise<boolean> {
  try {
    const der = pemToDer(pubkeyPem);
    const rawKey = extractRawEd25519Pubkey(der);
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const sigBytes = base64Decode(signature);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sigBytes.buffer as ArrayBuffer,
      (body as Uint8Array<ArrayBuffer>).buffer as ArrayBuffer,
    );
  } catch (e) {
    console.warn("[catalog-sync] signature verification error:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ── Public key helpers ────────────────────────────────────────────────────────

export function catalogBaseUrl(): string {
  return (Deno.env.get("CATALOG_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function catalogPublicKey(): string {
  return Deno.env.get("CATALOG_PUBKEY") ?? PINNED_CATALOG_PUBKEY;
}

// ── Shape validation ──────────────────────────────────────────────────────────

const CATALOG_SHAPE_CAP = 8;

/**
 * Why a payload is not a Catalog (#1566): collects path-labeled reasons.
 */
export function catalogShapeProblems(value: unknown): string[] {
  const problems: string[] = [];
  const fail = (msg: string) => { if (problems.length < CATALOG_SHAPE_CAP) problems.push(msg); };
  const c = value as Catalog;
  if (!c || typeof c !== "object") return ["payload is not an object"];
  if (typeof c.version !== "string") fail("version is not a string");
  if (c.tier !== "live" && c.tier !== "monthly") fail(`tier is ${JSON.stringify(c.tier)} (expected "live" or "monthly")`);
  if (!Array.isArray(c.models)) fail("models is not an array");
  if (!Array.isArray(c.quirks)) fail("quirks is not an array");

  const str = (v: unknown) => typeof v === "string";
  const num = (v: unknown) => typeof v === "number";
  const bool = (v: unknown) => typeof v === "boolean";
  const optStr = (v: unknown) => v === undefined || str(v);
  const optNum = (v: unknown) => v === undefined || num(v);
  const nulStr = (v: unknown) => v === undefined || v === null || str(v);
  const nulNum = (v: unknown) => v === undefined || v === null || num(v);

  const each = (name: string, check: (m: any) => string | null) => {
    const arr = (c as any)[name];
    if (arr === undefined) return;
    if (!Array.isArray(arr)) { fail(`${name} is present but not an array`); return; }
    for (let i = 0; i < arr.length; i++) {
      const why = check(arr[i]);
      if (why) {
        fail(`${name}[${i}] ${why}`);
        if (problems.length >= CATALOG_SHAPE_CAP) return;
      }
    }
  };

  each("embeddings", (m) => {
    if (!str(m?.family)) return "family is not a string";
    if (!str(m?.platform)) return "platform is not a string";
    if (!str(m?.modelId)) return "modelId is not a string";
    if (!str(m?.displayName)) return "displayName is not a string";
    if (!num(m?.dimensions)) return "dimensions is not a number";
    if (!num(m?.priority)) return "priority is not a number";
    if (!bool(m?.enabled)) return "enabled is not a boolean";
    return null;
  });
  each("transcriptionModels", (m) => {
    if (!str(m?.platform)) return "platform is not a string";
    if (!str(m?.modelId)) return "modelId is not a string";
    if (!str(m?.displayName)) return "displayName is not a string";
    if (!num(m?.priority)) return "priority is not a number";
    if (!bool(m?.enabled)) return "enabled is not a boolean";
    if (m?.subtitleFormats !== undefined && !(Array.isArray(m.subtitleFormats) && m.subtitleFormats.every((f: unknown) => typeof f === "string"))) return "subtitleFormats is not a string array";
    if (!nulNum(m?.maxBytes)) return "maxBytes is not a number";
    if (!nulStr(m?.requestStyle)) return "requestStyle is not a string";
    return null;
  });
  each("videoModels", (m) => {
    if (!str(m?.platform)) return "platform is not a string";
    if (!str(m?.modelId)) return "modelId is not a string";
    if (!str(m?.displayName)) return "displayName is not a string";
    if (!num(m?.priority)) return "priority is not a number";
    if (!bool(m?.enabled)) return "enabled is not a boolean";
    if (!optStr(m?.quotaLabel)) return "quotaLabel is not a string";
    if (!optStr(m?.providerModelId)) return "providerModelId is not a string";
    return null;
  });
  if (Array.isArray(c.models)) {
    each("models", (m) => {
      if (!str(m?.platform)) return "platform is not a string";
      if (!str(m?.modelId)) return "modelId is not a string";
      if (!str(m?.displayName)) return "displayName is not a string";
      if (!bool(m?.enabled)) return "enabled is not a boolean";
      if (!nulStr(m?.requestStyle)) return "requestStyle is not a string";
      if (!m?.limits || typeof m.limits !== "object") return "limits is missing";
      return null;
    });
  }
  each("searchEngines", (m) => {
    if (!str(m?.platform)) return "platform is not a string";
    if (!str(m?.engineId)) return "engineId is not a string";
    if (!str(m?.displayName)) return "displayName is not a string";
    if (!num(m?.priority)) return "priority is not a number";
    if (!bool(m?.enabled)) return "enabled is not a boolean";
    if (!optStr(m?.quotaLabel)) return "quotaLabel is not a string";
    if (!nulNum(m?.creditsPerQuery)) return "creditsPerQuery is not a number";
    if (m?.features !== undefined && !(typeof m.features === "object" && m.features !== null)) return "features is not an object";
    if (!optStr(m?.premiumSince)) return "premiumSince is not a string";
    return null;
  });
  each("decisionModels", (m) => {
    if (!str(m?.platform)) return "platform is not a string";
    if (!str(m?.modelId)) return "modelId is not a string";
    if (!str(m?.displayName)) return "displayName is not a string";
    if (!num(m?.priority)) return "priority is not a number";
    if (!bool(m?.enabled)) return "enabled is not a boolean";
    if (!optStr(m?.quotaLabel)) return "quotaLabel is not a string";
    if (!optNum(m?.contextWindow)) return "contextWindow is not a number";
    if (!optStr(m?.premiumSince)) return "premiumSince is not a string";
    return null;
  });
  if (c.managedPlatforms !== undefined) {
    if (!Array.isArray(c.managedPlatforms)) fail("managedPlatforms is not an array");
    else if (!c.managedPlatforms.every((p) => typeof p === "string")) fail("managedPlatforms contains a non-string entry");
  }
  if (Array.isArray(c.quirks)) {
    each("quirks", (q) => {
      if (!str(q?.slug)) return "slug is not a string";
      if (!Array.isArray(q?.targets)) return "targets is not an array";
      return null;
    });
  }
  return problems;
}

/** Minimal structural check. catalogShapeProblems is the diagnostic twin. */
function isCatalog(value: unknown): value is Catalog {
  return catalogShapeProblems(value).length === 0;
}

// ── Platform helpers ───────────────────────────────────────────────────────────

/** Every platform a catalog document manages. */
function catalogPlatforms(catalog: Catalog): Set<string> {
  const platforms = new Set<string>();
  for (const m of catalog.models) platforms.add(m.platform);
  for (const m of catalog.embeddings ?? []) platforms.add(m.platform);
  for (const m of catalog.transcriptionModels ?? []) platforms.add(m.platform);
  for (const m of catalog.videoModels ?? []) platforms.add(m.platform);
  for (const e of catalog.searchEngines ?? []) platforms.add(e.platform);
  for (const m of catalog.decisionModels ?? []) platforms.add(m.platform);
  for (const p of catalog.managedPlatforms ?? []) platforms.add(p);
  return platforms;
}

/** Check if a platform is known to the registry (replaces FreeLLMAPI hasProvider). */
function hasProvider(platform: string): boolean {
  return platform === "custom" || providerRegistry.getAllIds().includes(platform);
}

// ── Apply Catalog ─────────────────────────────────────────────────────────────

let appliedPlatformsCache: { raw: string; platforms: Set<string> } | null = null;

/** Platforms the catalog applied on this install manages. */
export function appliedCatalogPlatforms(): Set<string> {
  if (appliedPlatformsCache) return appliedPlatformsCache.platforms;
  return new Set<string>();
}

// ── SQL helpers ─────────────────────────────────────────────────────────────────

/** Quote a string value for inline SQL IN clauses. */
function sqlQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// ── Main apply function ─────────────────────────────────────────────────────────

/**
 * Apply a verified catalog to the local Postgres DB.
 *
 * Rules of engagement with user data (same as FreeLLMAPI):
 *  - metadata (name, ranks, limits, context, capabilities) tracks the catalog
 *    unless the user has an explicit local override;
 *  - catalog enabled=false force-disables (the model is dead upstream), but
 *    enabled=true never re-enables a model the user turned off themselves;
 *  - rows the user created (source='user') are never updated, never deleted,
 *    and never adopted — on a platform:model_id collision the user row wins;
 *  - catalog models the user deleted stay deleted via tombstones;
 *  - models that vanished from the catalog are deleted;
 *  - rows found by built-in model discovery (source='discovered') are a stopgap
 *    that the catalog outranks: once the catalog lists a platform, discovered
 *    rows on it are retired.
 */
export async function applyCatalog(catalog: Catalog): Promise<NonNullable<SyncResult["counts"]>> {
  const counts = { updated: 0, inserted: 0, removed: 0, skippedUnknownPlatform: 0, quirks: 0 };
  const inCatalog = new Set<string>();
  const inMediaCatalog = new Set<string>();
  const inVideoCatalog = new Set<string>();
  const inSearchCatalog = new Set<string>();
  const inDecisionCatalog = new Set<string>();
  const inTranscriptionCatalog = new Set<string>();
  const inEmbeddingCatalog = new Set<string>();

  // Reusable query helpers
  const selectModel = (platform: string, modelId: string) =>
    queryRaw("SELECT id, enabled, source FROM models WHERE platform = $1 AND model_id = $2", [platform, modelId]);

  const selectMedia = (platform: string, modelId: string) =>
    queryRaw("SELECT id, enabled FROM media_models WHERE platform = $1 AND model_id = $2", [platform, modelId]);

  const selectEmbedding = (platform: string, modelId: string) =>
    queryRaw("SELECT id, enabled FROM embedding_models WHERE platform = $1 AND model_id = $2", [platform, modelId]);

  const checkTombstone = (kind: string, platform: string, modelId: string) =>
    queryRaw(
      "SELECT source FROM catalog_model_tombstones WHERE kind = $1 AND platform = $2 AND model_id = $3 AND source = 'user'",
      [kind, platform, modelId],
    );

  // ── Chat models ────────────────────────────────────────────────────────────
  for (const m of catalog.models) {
    if (!hasProvider(m.platform)) { counts.skippedUnknownPlatform++; continue; }

    // Tombstone check — user-deleted models are skipped
    const tomb = await checkTombstone("chat", m.platform, m.modelId);
    if (tomb.length > 0) continue;

    // Reinstate upstream-retired models if catalog still lists them enabled
    if (m.enabled) {
      const upstreamTomb = await queryRaw(
        "SELECT 1 FROM catalog_model_tombstones WHERE kind = 'chat' AND platform = $1 AND model_id = $2 AND source = 'upstream_eol'",
        [m.platform, m.modelId],
      );
      if (upstreamTomb.length > 0) {
        await queryRaw(
          "DELETE FROM catalog_model_tombstones WHERE kind = 'chat' AND platform = $1 AND model_id = $2 AND source = 'upstream_eol'",
          [m.platform, m.modelId],
        );
        const rows = await queryRaw("SELECT id FROM models WHERE platform = $1 AND model_id = $2", [m.platform, m.modelId]);
        const row = rows[0] as { id: number } | undefined;
        if (row) {
          await queryRaw("UPDATE fallback_config SET enabled = 1 WHERE model_db_id = $1", [row.id]);
          await queryRaw("UPDATE profile_models SET enabled = 1 WHERE model_db_id = $1", [row.id]);
        }
      }
    }

    inCatalog.add(`${m.platform}:${m.modelId}`);

    const rows = await selectModel(m.platform, m.modelId);
    const row = rows[0] as { id: number; enabled: number; source: string } | undefined;

    // Collision rule: user hand-added models win (skip entirely)
    if (row && row.source === "user") continue;

    // Adopt discovered rows into catalog ownership
    if (row && row.source === DISCOVERED_MODEL_SOURCE) {
      await queryRaw("UPDATE models SET source = 'catalog' WHERE id = $1", [row.id]);
      counts.updated++;
      continue; // metadata from discovery is fine, just fix provenance
    }

    if (row) {
      // Update existing — catalog disable wins; local disable also wins
      const enabled = m.enabled ? row.enabled : 0;
      await queryRaw(
        `UPDATE models SET
         display_name = $3, intelligence_rank = $4, speed_rank = $5,
         size_label = $6, rpm_limit = $7, rpd_limit = $8, tpm_limit = $9, tpd_limit = $10,
         monthly_token_budget = $11, context_window = $12,
         enabled = $13, supports_vision = $14, supports_tools = $15,
         in_catalog = 1
         WHERE id = $16`,
        [m.platform, m.modelId, m.displayName, m.intelligenceRank, m.speedRank, m.sizeLabel,
         m.limits.rpm, m.limits.rpd, m.limits.tpm, m.limits.tpd,
         m.monthlyTokenBudget ?? "", m.contextWindow,
         enabled, m.supportsVision ? 1 : 0, m.supportsTools ? 1 : 0, row.id],
      );
      counts.updated++;
    } else {
      await queryRaw(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
         size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
         context_window, enabled, supports_vision, supports_tools, source, in_catalog, endpoint_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'catalog', 1, '')`,
        [m.platform, m.modelId, m.displayName, m.intelligenceRank, m.speedRank, m.sizeLabel,
         m.limits.rpm, m.limits.rpd, m.limits.tpm, m.limits.tpd,
         m.monthlyTokenBudget ?? "", m.contextWindow, m.enabled ? 1 : 0,
         m.supportsVision ? 1 : 0, m.supportsTools ? 1 : 0],
      );
      counts.inserted++;
    }
  }

  // ── Video models ─────────────────────────────────────────────────────────────
  if (catalog.videoModels) {
    for (const m of catalog.videoModels) {
      if (!VIDEO_PLATFORMS.has(m.platform)) { counts.skippedUnknownPlatform++; continue; }
      const tomb = await checkTombstone("media", m.platform, m.modelId);
      if (tomb.length > 0) continue;
      inVideoCatalog.add(`${m.platform}:${m.modelId}`);
      const meta = typeof m.providerModelId === "string"
        ? JSON.stringify({ providerModelId: m.providerModelId }) : null;
      const existing = await selectMedia(m.platform, m.modelId);
      const row = existing[0] as { id: number; enabled: number } | undefined;
      if (row) {
        const enabled = m.enabled ? row.enabled : 0;
        await queryRaw(
          `UPDATE media_models SET display_name = $3, modality = 'video', priority = $4,
           quota_label = $5, meta_json = $6, enabled = $7 WHERE id = $8`,
          [m.platform, m.modelId, m.displayName, m.priority, m.quotaLabel ?? "", meta, enabled, row.id],
        );
        counts.updated++;
      } else {
        await queryRaw(
          `INSERT INTO media_models (platform, model_id, display_name, modality, priority, quota_label, meta_json, enabled)
           VALUES ($1, $2, $3, 'video', $4, $5, $6, $7)`,
          [m.platform, m.modelId, m.displayName, m.priority, m.quotaLabel ?? "", meta, m.enabled ? 1 : 0],
        );
        counts.inserted++;
      }
    }
  }

  // ── Search engines ───────────────────────────────────────────────────────────
  if (catalog.searchEngines) {
    for (const e of catalog.searchEngines) {
      if (!SEARCH_ENGINE_PLATFORMS.has(e.platform)) { counts.skippedUnknownPlatform++; continue; }
      if (e.platform === "custom") continue;
      const tomb = await checkTombstone("media", e.platform, e.engineId);
      if (tomb.length > 0) continue;
      inSearchCatalog.add(`${e.platform}:${e.engineId}`);
      const meta: Record<string, unknown> = {};
      if (e.creditsPerQuery !== undefined) meta.creditsPerQuery = e.creditsPerQuery;
      if (e.features && typeof e.features === "object") {
        meta.features = {
          ...(typeof e.features.news === "boolean" ? { news: e.features.news } : {}),
          ...(typeof e.features.answer === "boolean" ? { answer: e.features.answer } : {}),
          ...(typeof e.features.fullContent === "boolean" ? { fullContent: e.features.fullContent } : {}),
        };
      }
      if (typeof e.premiumSince === "string") meta.premiumSince = e.premiumSince;
      const metaJson = JSON.stringify(meta);
      const existing = await selectMedia(e.platform, e.engineId);
      const row = existing[0] as { id: number; enabled: number } | undefined;
      if (row) {
        const enabled = e.enabled ? row.enabled : 0;
        await queryRaw(
          `UPDATE media_models SET display_name = $3, modality = $4, priority = $5,
           quota_label = $6, meta_json = $7, enabled = $8 WHERE id = $9`,
          [e.platform, e.engineId, e.displayName, SEARCH_MODALITY, e.priority, e.quotaLabel ?? "", metaJson, enabled, row.id],
        );
        counts.updated++;
      } else {
        await queryRaw(
          `INSERT INTO media_models (platform, model_id, display_name, modality, priority, quota_label, meta_json, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [e.platform, e.engineId, e.displayName, SEARCH_MODALITY, e.priority, e.quotaLabel ?? "", metaJson, e.enabled ? 1 : 0],
        );
        counts.inserted++;
      }
    }
  }

  // ── Decision models ─────────────────────────────────────────────────────────
  if (catalog.decisionModels) {
    for (const m of catalog.decisionModels) {
      if (!DECISION_PLATFORMS.has(m.platform)) { counts.skippedUnknownPlatform++; continue; }
      const tomb = await checkTombstone("media", m.platform, m.modelId);
      if (tomb.length > 0) continue;
      inDecisionCatalog.add(`${m.platform}:${m.modelId}`);
      const meta: Record<string, unknown> = {};
      if (typeof m.contextWindow === "number") meta.contextWindow = m.contextWindow;
      if (typeof m.premiumSince === "string") meta.premiumSince = m.premiumSince;
      const metaJson = JSON.stringify(meta);
      const existing = await selectMedia(m.platform, m.modelId);
      const row = existing[0] as { id: number; enabled: number } | undefined;
      if (row) {
        const enabled = m.enabled ? row.enabled : 0;
        await queryRaw(
          `UPDATE media_models SET display_name = $3, modality = $4, priority = $5,
           quota_label = $6, meta_json = $7, enabled = $8 WHERE id = $9`,
          [m.platform, m.modelId, m.displayName, DECISION_MODALITY, m.priority, m.quotaLabel ?? "", metaJson, enabled, row.id],
        );
        counts.updated++;
      } else {
        await queryRaw(
          `INSERT INTO media_models (platform, model_id, display_name, modality, priority, quota_label, meta_json, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [m.platform, m.modelId, m.displayName, DECISION_MODALITY, m.priority, m.quotaLabel ?? "", metaJson, m.enabled ? 1 : 0],
        );
        counts.inserted++;
      }
    }
  }

  // ── Embeddings ───────────────────────────────────────────────────────────────
  if (catalog.embeddings) {
    for (const m of catalog.embeddings) {
      if (!EMBEDDING_PLATFORMS.has(m.platform)) { counts.skippedUnknownPlatform++; continue; }
      inEmbeddingCatalog.add(`${m.platform}:${m.modelId}`);
      const existing = await selectEmbedding(m.platform, m.modelId);
      const row = existing[0] as { id: number; enabled: number } | undefined;
      if (row) {
        const enabled = m.enabled ? row.enabled : 0;
        await queryRaw(
          `UPDATE embedding_models SET family = $3, display_name = $4, dimensions = $5,
           max_input_tokens = $6, priority = $7, quota_label = $8, enabled = $9 WHERE id = $10`,
          [m.platform, m.modelId, m.family, m.displayName, m.dimensions, m.maxInputTokens,
           m.priority, m.quotaLabel, enabled, row.id],
        );
        counts.updated++;
      } else {
        await queryRaw(
          `INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, quota_label, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [m.family, m.platform, m.modelId, m.displayName, m.dimensions, m.maxInputTokens,
           m.priority, m.quotaLabel, m.enabled ? 1 : 0],
        );
        counts.inserted++;
      }
    }
  }

  // ── Transcription models ────────────────────────────────────────────────────
  if (catalog.transcriptionModels) {
    for (const m of catalog.transcriptionModels) {
      if (!TRANSCRIPTION_PLATFORMS.has(m.platform)) { counts.skippedUnknownPlatform++; continue; }
      const tomb = await checkTombstone("media", m.platform, m.modelId);
      if (tomb.length > 0) continue;
      inTranscriptionCatalog.add(`${m.platform}:${m.modelId}`);
      const meta: Record<string, unknown> = {};
      if (m.subtitleFormats?.length) meta.subtitleFormats = m.subtitleFormats;
      if (typeof m.maxBytes === "number") meta.maxBytes = m.maxBytes;
      if (typeof m.requestStyle === "string") meta.requestStyle = m.requestStyle;
      const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
      const existing = await selectMedia(m.platform, m.modelId);
      const row = existing[0] as { id: number; enabled: number } | undefined;
      if (row) {
        const enabled = m.enabled ? row.enabled : 0;
        await queryRaw(
          `UPDATE media_models SET display_name = $3, modality = 'transcription', priority = $4,
           quota_label = $5, meta_json = $6, enabled = $7 WHERE id = $8`,
          [m.platform, m.modelId, m.displayName, m.priority, m.quotaLabel ?? "", metaJson, enabled, row.id],
        );
        counts.updated++;
      } else {
        await queryRaw(
          `INSERT INTO media_models (platform, model_id, display_name, modality, priority, quota_label, meta_json, enabled)
           VALUES ($1, $2, $3, 'transcription', $4, $5, $6, $7)`,
          [m.platform, m.modelId, m.displayName, m.priority, m.quotaLabel ?? "", metaJson, m.enabled ? 1 : 0],
        );
        counts.inserted++;
      }
    }
  }

  // ── Cleanup: tombstones, orphans, pruning ──────────────────────────────────

  // Delete user-tombstoned models
  await deleteTombstonedCatalogModelsPort();

  // Ensure every model has a fallback_config row
  await ensureFallbackConfigRows();

  // Ensure all models in fallback_config are in auto-including profiles
  await ensureAllModelsInProfilesPort();

  // ── Prune chat models no longer in catalog ──────────────────────────────────
  const managed = catalogPlatforms(catalog);
  if (inCatalog.size > 0) {
    const pairs = [...inCatalog].map((s) => {
      const [platform, modelId] = s.split(":");
      return [platform, modelId];
    });
    // Build a VALUES clause for the NOT IN subquery
    const pairPlaceholders = pairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
    const pairParams = pairs.flat();

    const rows = await queryRaw(
      `SELECT m.id FROM models m
       WHERE m.platform != 'custom' AND m.key_id IS NULL AND m.source = 'catalog'
         AND (m.platform, m.model_id) NOT IN (${pairPlaceholders})`,
      pairParams,
    ) as Array<{ id: number }>;
    for (const r of rows) {
      await queryRaw("DELETE FROM fallback_config WHERE model_db_id = $1", [r.id]);
      await queryRaw("DELETE FROM models WHERE id = $1", [r.id]);
      counts.removed++;
    }
  }

  // ── Retire discovered rows on catalog-managed platforms (#1348) ──────────────
  const discoveredRows = await queryRaw(
    "SELECT id, platform FROM models WHERE source = $1",
    [DISCOVERED_MODEL_SOURCE],
  ) as Array<{ id: number; platform: string }>;
  for (const d of discoveredRows) {
    if (!managed.has(d.platform)) continue;
    await queryRaw("DELETE FROM fallback_config WHERE model_db_id = $1", [d.id]);
    await queryRaw("DELETE FROM models WHERE id = $1", [d.id]);
    counts.removed++;
  }

  // ── Sweep orphan rows pinned to deleted keys (#1516) ────────────────────────
  const orphanChat = await queryRaw(
    "SELECT id FROM models WHERE key_id IS NOT NULL AND key_id NOT IN (SELECT id FROM api_keys)",
  ) as Array<{ id: number }>;
  for (const o of orphanChat) {
    await queryRaw("DELETE FROM fallback_config WHERE model_db_id = $1", [o.id]);
    await queryRaw("DELETE FROM models WHERE id = $1", [o.id]);
    counts.removed++;
  }
  const orphanEmbed = await queryRaw(
    "DELETE FROM embedding_models WHERE key_id IS NOT NULL AND key_id NOT IN (SELECT id FROM api_keys)",
  );
  counts.removed += (orphanEmbed as any)?. rowCount ?? 0;
  const orphanMedia = await queryRaw(
    "DELETE FROM media_models WHERE key_id IS NOT NULL AND key_id NOT IN (SELECT id FROM api_keys)",
  );
  counts.removed += (orphanMedia as any)?.rowCount ?? 0;

  // ── Prune media models not in catalog ───────────────────────────────────────
  // Image/audio — allowlist modality
  const mediaCandidates = await queryRaw(
    "SELECT id, platform, model_id FROM media_models WHERE modality IN ('image', 'audio')",
  ) as Array<{ id: number; platform: string; model_id: string }>;
  for (const c of mediaCandidates) {
    if (!MEDIA_PLATFORMS.has(c.platform)) continue;
    if (!inMediaCatalog.has(`${c.platform}:${c.model_id}`)) {
      await queryRaw("DELETE FROM media_models WHERE id = $1", [c.id]);
      counts.removed++;
    }
  }

  // Video rows — only when catalog carries the snapshot
  if (catalog.videoModels) {
    const videoCandidates = await queryRaw(
      "SELECT id, platform, model_id FROM media_models WHERE modality = 'video'",
    ) as Array<{ id: number; platform: string; model_id: string }>;
    for (const c of videoCandidates) {
      if (!VIDEO_PLATFORMS.has(c.platform)) continue;
      if (!inVideoCatalog.has(`${c.platform}:${c.model_id}`)) {
        await queryRaw("DELETE FROM media_models WHERE id = $1", [c.id]);
        counts.removed++;
      }
    }
  }

  // Search engines — only when catalog carries the snapshot
  if (catalog.searchEngines) {
    const searchCandidates = await queryRaw(
      "SELECT id, platform, model_id FROM media_models WHERE modality = $1",
      [SEARCH_MODALITY],
    ) as Array<{ id: number; platform: string; model_id: string }>;
    for (const c of searchCandidates) {
      if (!SEARCH_ENGINE_PLATFORMS.has(c.platform)) continue;
      if (c.platform === "custom") continue;
      if (!inSearchCatalog.has(`${c.platform}:${c.model_id}`)) {
        await queryRaw("DELETE FROM media_models WHERE id = $1", [c.id]);
        counts.removed++;
      }
    }
  }

  // Decision models — only when catalog carries the snapshot
  if (catalog.decisionModels) {
    const decisionCandidates = await queryRaw(
      "SELECT id, platform, model_id FROM media_models WHERE modality = $1",
      [DECISION_MODALITY],
    ) as Array<{ id: number; platform: string; model_id: string }>;
    for (const c of decisionCandidates) {
      if (!DECISION_PLATFORMS.has(c.platform)) continue;
      if (!inDecisionCatalog.has(`${c.platform}:${c.model_id}`)) {
        await queryRaw("DELETE FROM media_models WHERE id = $1", [c.id]);
        counts.removed++;
      }
    }
  }

  // Transcription rows — only when catalog carries the snapshot
  if (catalog.transcriptionModels) {
    const sttCandidates = await queryRaw(
      "SELECT id, platform, model_id FROM media_models WHERE modality = 'transcription'",
    ) as Array<{ id: number; platform: string; model_id: string }>;
    for (const c of sttCandidates) {
      if (!TRANSCRIPTION_PLATFORMS.has(c.platform)) continue;
      if (!inTranscriptionCatalog.has(`${c.platform}:${c.model_id}`)) {
        await queryRaw("DELETE FROM media_models WHERE id = $1", [c.id]);
        counts.removed++;
      }
    }
  }

  // Embeddings — only when catalog carries a non-empty snapshot
  if (catalog.embeddings && catalog.embeddings.length > 0) {
    const embeddingCandidates = await queryRaw(
      "SELECT id, platform, model_id FROM embedding_models WHERE platform != 'custom' AND key_id IS NULL",
    ) as Array<{ id: number; platform: string; model_id: string }>;
    for (const c of embeddingCandidates) {
      if (!EMBEDDING_PLATFORMS.has(c.platform)) continue;
      if (!inEmbeddingCatalog.has(`${c.platform}:${c.model_id}`)) {
        await queryRaw("DELETE FROM embedding_models WHERE id = $1", [c.id]);
        counts.removed++;
      }
    }
  }

  // ── Quirks: replace wholesale ──────────────────────────────────────────────
  await queryRaw("DELETE FROM quirk_targets");
  await queryRaw("DELETE FROM quirks");
  const now = Date.now();
  for (const q of catalog.quirks) {
    const res = await queryRaw(
      "INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [q.slug, q.title, q.body ?? "", q.severity ?? "info", now, now],
    );
    const quirkId = (res as Array<{ id: number }>)[0]?.id;
    if (quirkId == null) continue;
    for (const t of q.targets) {
      if (t.platform === null && t.modelGlob === null) continue;
      await queryRaw(
        "INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES ($1, $2, $3)",
        [quirkId, t.platform ?? null, t.modelGlob ?? null],
      );
    }
    counts.quirks++;
  }

  // ── Refresh model override baselines ────────────────────────────────────────
  try {
    const { refreshModelOverrideBaselines, applyAllModelOverrides } =
      await import("../services/model-state.ts");
    let refreshed = 0;
    for (const m of catalog.models) {
      try { await refreshModelOverrideBaselines(m.platform, m.modelId); refreshed++; } catch { /* best-effort */ }
    }
    const applied = await applyAllModelOverrides();
    console.log(`[catalog-sync] override baselines refreshed=${refreshed}, re-applied=${applied}`);
  } catch (e) {
    console.warn("[catalog-sync] model-state integration skipped:", e instanceof Error ? e.message : String(e));
  }

  return counts;
}

// ── Tombstone / profile helpers (Postgres-adapted from FreeLLMAPI) ─────────────

/** Delete models that have a user tombstone. */
async function deleteTombstonedCatalogModelsPort(): Promise<void> {
  // Chat: delete fallback_config rows first, then models
  await queryRaw(`
    WITH tomb AS (
      DELETE FROM catalog_model_tombstones
      WHERE kind = 'chat' AND source = 'user'
      RETURNING platform, model_id
    )
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT m.id FROM models m JOIN tomb t
      ON t.platform = m.platform AND t.model_id = m.model_id
    )
  `);
  await queryRaw(`
    WITH tomb AS (
      SELECT platform, model_id FROM catalog_model_tombstones
      WHERE kind = 'chat' AND source = 'user'
    )
    DELETE FROM models WHERE platform IN (SELECT platform FROM tomb)
      AND model_id IN (SELECT model_id FROM tomb)
  `);
  // Media
  await queryRaw(`
    WITH tomb AS (
      DELETE FROM catalog_model_tombstones
      WHERE kind = 'media' AND source = 'user'
      RETURNING platform, model_id
    )
    DELETE FROM media_models WHERE platform IN (SELECT platform FROM tomb)
      AND model_id IN (SELECT model_id FROM tomb)
  `);
}

/** Ensure every model in `models` has a fallback_config row. */
async function ensureFallbackConfigRows(): Promise<void> {
  const missing = await queryRaw(`
    SELECT m.id FROM models m LEFT JOIN fallback_config f ON m.id = f.model_db_id WHERE f.id IS NULL
  `) as Array<{ id: number }>;
  if (missing.length === 0) return;
  const maxRow = await queryRaw(
    "SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config",
  ) as Array<{ mx: number }>;
  const base = maxRow[0]?.mx ?? 0;
  for (let i = 0; i < missing.length; i++) {
    await queryRaw(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES ($1, $2, 1)",
      [missing[i].id, base + i + 1],
    );
  }
}

/**
 * Ensure every model in fallback_config is also in auto-including profiles.
 * Ported from ensureAllModelsInProfiles — adapted to use profile_auto_include
 * table instead of profiles.auto_include_new_models column.
 */
async function ensureAllModelsInProfilesPort(): Promise<void> {
  const profiles = await queryRaw(`
    SELECT p.id FROM profiles p
    JOIN profile_auto_include pai ON pai.profile_id = p.id
    ORDER BY p.id ASC
  `) as Array<{ id: number }>;
  if (profiles.length === 0) return;

  for (const profile of profiles) {
    const missing = await queryRaw(`
      SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = $1 AND pm.model_db_id = m.id
      WHERE pm.id IS NULL
      ORDER BY f.priority, m.id
    `, [profile.id]) as Array<{ id: number; enabled: number }>;

    if (missing.length === 0) continue;
    const maxRow = await queryRaw(
      "SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = $1",
      [profile.id],
    ) as Array<{ max_priority: number }>;
    const base = maxRow[0]?.max_priority ?? 0;
    for (let i = 0; i < missing.length; i++) {
      await queryRaw(
        "INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)",
        [profile.id, missing[i].id, base + i + 1, missing[i].enabled],
      );
    }
  }
}

// ── Fetch + Verify ────────────────────────────────────────────────────────────

/** Parse the catalog payload; throws if shape is wrong. */
export function parseCatalogPayload(raw: unknown): SignedCatalog {
  if (!raw || typeof raw !== "object") throw new Error("Catalog: not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "string") throw new Error("Catalog: missing version");
  if (!Array.isArray(o.models)) throw new Error("Catalog: models not an array");
  return o as unknown as SignedCatalog;
}

/** Chat model entry from the signed catalog. */
export interface CatalogModelEntry {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
}

/** Full catalog payload (backward-compat alias). */
export interface SignedCatalog {
  version: string;
  generatedAt: string;
  tier: string;
  models: CatalogModelEntry[];
  embeddings?: any[];
  transcriptionModels?: any[];
  videoModels?: any[];
  searchEngines?: any[];
  decisionModels?: any[];
  quirks?: any[];
  platforms?: any[];
}

/** Fetch the signed catalog with Ed25519 signature verification. */
export async function fetchSignedCatalog(timeoutMs = FETCH_TIMEOUT_MS): Promise<SignedCatalog & { raw: string }> {
  const key = await getSetting<string>(SETTING_LICENSE_KEY);
  const applied = await getSetting<string>(SETTING_APPLIED_VERSION);

  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  const url = new URL(`${catalogBaseUrl()}/v1/latest`);
  if (applied) url.searchParams.set("since", applied);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal, headers });
    if (res.status === 304) throw new Error("CATALOG_NOT_MODIFIED");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const signature = res.headers.get("x-catalog-signature");
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (signature) {
      const pubkey = catalogPublicKey();
      const verified = await verifySignature(bytes, signature, pubkey);
      if (!verified) throw new Error("catalog signature verification FAILED — discarding response");
    }

    const json = JSON.parse(new TextDecoder().decode(bytes));
    const parsed = parseCatalogPayload(json);
    return { ...parsed, raw: new TextDecoder().decode(bytes) };
  } finally {
    clearTimeout(timer);
  }
}

/** Sync the catalog into the DB — full version with signature verification. */
export async function syncSignedCatalog(): Promise<{
  ok: boolean;
  version?: string;
  upserted: number;
  retired: number;
  error?: string;
}> {
  await initDb();
  const result = await syncCatalog(true);
  return {
    ok: result.ok,
    version: result.version,
    upserted: result.counts?.inserted ?? 0,
    retired: result.counts?.removed ?? 0,
    error: result.detail,
  };
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

// ── License ───────────────────────────────────────────────────────────────────

export interface LicenseActivation {
  valid: boolean;
  plan: string | null;
  status: string | null;
  expiresAt: string | null;
  reason?: string;
}

/** Validate a key with the license service. */
export async function validateLicenseKey(key: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<LicenseActivation | null> {
  try {
    const res = await fetch(`${catalogBaseUrl()}/v1/license/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as LicenseActivation;
  } catch {
    return null;
  }
}

/** Revalidate the stored license against the catalog service and cache the result. */
export async function refreshLicenseStatus(): Promise<LicenseStatus | null> {
  const key = await getSetting<string>(SETTING_LICENSE_KEY);
  if (!key) return null;
  try {
    const result = await validateLicenseKey(key);
    if (!result) return getCachedLicenseStatus();
    const status: LicenseStatus = {
      valid: result.valid,
      plan: result.plan as "annual" | "lifetime" | null,
      status: result.status,
      expiresAt: result.expiresAt,
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

export async function getCachedLicenseStatus(): Promise<LicenseStatus | null> {
  const raw = await getSetting<LicenseStatus>(SETTING_LICENSE_STATUS);
  return raw ?? null;
}

// ── Sync state ─────────────────────────────────────────────────────────────────

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

export interface CatalogSyncState {
  baseUrl: string;
  appliedVersion: string | null;
  appliedTier: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
}

// ── Main sync orchestration ────────────────────────────────────────────────────

/**
 * Fetch the catalog, verify its signature, and apply it if it moves us forward.
 * `force` skips the `since` short-circuit.
 */
export async function syncCatalog(force = false): Promise<SyncResult> {
  const applied = await getSetting<string>(SETTING_APPLIED_VERSION);
  const appliedTier = await getSetting<string>(SETTING_APPLIED_TIER);

  try {
    // Check if we can skip (not modified since last sync)
    if (!force && applied) {
      const lastSyncMs = await getSetting<number>(SETTING_LAST_SYNC_MS);
      // Always fetch to check if 304 — the `since` param handles dedup
    }

    const catalog = await fetchSignedCatalog();

    if (catalog.version < MIN_CATALOG_VERSION) {
      await saveSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      await saveSetting(SETTING_LAST_ERROR, null);
      return { ok: true, action: "skipped_older", version: catalog.version, tier: catalog.tier };
    }

    const sameAsApplied = applied === catalog.version && appliedTier === catalog.tier;
    if (!sameAsApplied) {
      const counts = await applyCatalog(catalog as unknown as Catalog);
      await saveSetting(SETTING_APPLIED_VERSION, catalog.version);
      await saveSetting(SETTING_APPLIED_TIER, catalog.tier);
      await saveSetting(SETTING_APPLIED_JSON, (catalog as any).raw);
      console.log(
        `[catalog-sync] applied ${catalog.tier} v${catalog.version}: ` +
          `${counts.updated} updated, ${counts.inserted} new, ${counts.removed} removed, ` +
          `${counts.quirks} quirks` +
          (counts.skippedUnknownPlatform ? `, ${counts.skippedUnknownPlatform} skipped (unknown platform)` : ""),
      );
      await saveSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      await saveSetting(SETTING_LAST_ERROR, null);
      return { ok: true, action: "applied", version: catalog.version, tier: catalog.tier, counts };
    }

    await saveSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
    await saveSetting(SETTING_LAST_ERROR, null);
    return { ok: true, action: "up_to_date", version: catalog.version, tier: catalog.tier };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "CATALOG_NOT_MODIFIED") {
      await saveSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      await saveSetting(SETTING_LAST_ERROR, null);
      return { ok: true, action: "up_to_date", version: applied ?? undefined };
    }
    console.warn(`[catalog-sync] ${message}`);
    await saveSetting(SETTING_LAST_ERROR, message);
    return { ok: false, action: "error", detail: message };
  }
}

// ── Offline re-apply ───────────────────────────────────────────────────────────

/**
 * Re-apply the cached (already signature-verified) catalog after boot.
 *
 * Migrations re-assert the bundled baseline (INSERT OR IGNORE) while the
 * boot-time network sync 304s on an unchanged version and so would NOT
 * re-apply. Without this step every restart drifts the DB back toward the
 * baseline.
 */
export async function reapplyCachedCatalog(): Promise<{ reapplied: boolean; version?: string }> {
  await initDb();
  try {
    const raw = await getSetting<string>(SETTING_APPLIED_JSON);
    if (!raw) {
      // Legacy upgrade: clear applied version so next sync fetches full catalog
      const hasVersion = await getSetting<string>(SETTING_APPLIED_VERSION);
      if (hasVersion) {
        await queryRaw("DELETE FROM settings WHERE key = $1", [SETTING_APPLIED_VERSION]);
      }
      return { reapplied: false };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCatalog(parsed) || (parsed as Catalog).version < MIN_CATALOG_VERSION) return { reapplied: false };
    const counts = await applyCatalog(parsed as Catalog);
    console.log(
      `[catalog-sync] re-applied cached ${(parsed as Catalog).tier} v${(parsed as Catalog).version}: ` +
        `${counts.updated} updated, ${counts.inserted} new, ${counts.removed} removed`,
    );
    appliedPlatformsCache = { raw, platforms: catalogPlatforms(parsed as Catalog) };
    return { reapplied: true, version: (parsed as Catalog).version };
  } catch (err) {
    console.warn(`[catalog-sync] cached catalog re-apply failed: ${err instanceof Error ? err.message : String(err)}`);
    return { reapplied: false };
  }
}

// ── Scheduling ──────────────────────────────────────────────────────────────────
// Uses setTimeout/setInterval so it works both on Deno Deploy and locally.

let _syncTimer: ReturnType<typeof setTimeout> | null = null;
let _syncInterval: ReturnType<typeof setInterval> | null = null;

/** Start the catalog sync: boot delay + periodic polling. */
export function startCatalogSync(): void {
  if (_syncInterval !== null) return;
  if (Deno.env.get("CATALOG_SYNC_DISABLED") === "1") {
    console.log("[catalog-sync] disabled via CATALOG_SYNC_DISABLED=1");
    return;
  }

  // Re-apply cached catalog first (offline-safe)
  reapplyCachedCatalog().catch((e) =>
    console.warn("[catalog-sync] re-apply failed:", e instanceof Error ? e.message : String(e)),
  );

  // Boot delay: let the server settle before first sync
  _syncTimer = setTimeout(() => {
    void syncCatalog(false).then((r) => {
      if (!r.ok) console.warn(`[catalog-sync] initial sync failed: ${r.detail}`);
    }).catch((e) => {
      console.log("[catalog-sync] initial sync errored:", e instanceof Error ? e.message : String(e));
    });
  }, BOOT_DELAY_MS);

  // Periodic sync (every 12 hours)
  _syncInterval = setInterval(() => {
    void syncCatalog(false).then((r) => {
      if (!r.ok) console.warn(`[catalog-sync] periodic sync failed: ${r.detail}`);
    }).catch((e) => {
      console.warn("[catalog-sync] periodic sync errored:", e instanceof Error ? e.message : String(e));
    });
  }, SYNC_INTERVAL_MS);

  console.log(`[catalog-sync] polling ${catalogBaseUrl()} every ${SYNC_INTERVAL_MS / 3600000}h`);
}

/** Stop the catalog sync (for graceful shutdown). */
export function stopCatalogSync(): void {
  if (_syncTimer !== null) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
  if (_syncInterval !== null) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
}
