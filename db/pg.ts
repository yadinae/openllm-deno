/**
 * Postgres persistence for OpenLLM (Deno Deploy + Prisma Postgres)
 *
 * Connection comes from the DATABASE_URL that Deno Deploy injects when a
 * database is assigned to the app. Driver: postgres.js (pure JS, no codegen).
 */

import postgres from "npm:postgres@^3.4.5";
import { getAllKeys, getAllDiscoveredModels } from "./mod.ts";

export interface DbEntry {
  id: string;
  platform: string;
  label?: string;
  encrypted_key?: string;
  iv?: string;
  auth_tag?: string;
  status?: string;
  enabled: boolean;
  base_url?: string;
}

export interface DiscoveredModel {
  id: string;
  platform: string;
  displayName: string;
  enabled: boolean;
  discoveredAt: number;
}

// Phase 2: SCHEMA MIGRATION - Complete original FreeLLMAPI schema
// Tables migrated from SQLite (40+ migrations) to Postgres

type Sql = postgres.Sql;

let _sql: Sql | null = null;
let _ready: Promise<void> | null = null;

/** Connect lazily and create tables once. */
export async function initDb(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL not set (assign a database in Deno Deploy)");

    _sql = postgres(url, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false, // pooler in front of Prisma Postgres rejects named prepared statements
    });

    await _sql`
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        intelligence_rank INTEGER NOT NULL,
        speed_rank INTEGER NOT NULL,
        size_label TEXT NOT NULL DEFAULT '',
        rpm_limit INTEGER,
        rpd_limit INTEGER,
        tpm_limit INTEGER,
        tpd_limit INTEGER,
        monthly_token_budget TEXT NOT NULL DEFAULT '',
        context_window INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        supports_vision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(platform, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_id INTEGER,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS rate_limit_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_id INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, model_id, key_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS fallback_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_db_id INTEGER NOT NULL REFERENCES models(id),
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(model_db_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#6366f1',
        type TEXT NOT NULL DEFAULT 'custom',
        is_favorite INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        auto_sort TEXT,
        layout_config TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS profile_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(profile_id, model_db_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS provider_quota_state (
        platform TEXT NOT NULL,
        key_id INTEGER NOT NULL,
        quota_pool_key TEXT NOT NULL,
        metric TEXT NOT NULL,
        limit_value INTEGER,
        remaining_value INTEGER,
        reset_at TEXT,
        reset_strategy TEXT NOT NULL DEFAULT 'unknown',
        source TEXT NOT NULL DEFAULT 'probe',
        confidence REAL NOT NULL DEFAULT 0,
        notes TEXT,
        observed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, key_id, quota_pool_key, metric)
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_provider_quota_state_platform ON provider_quota_state(platform, key_id, updated_at);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_provider_quota_state_reset_at ON provider_quota_state(reset_at);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS provider_quota_observations (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        key_id INTEGER NOT NULL,
        provider_account_id TEXT,
        model_id TEXT,
        quota_pool_key TEXT NOT NULL,
        metric TEXT NOT NULL,
        status_code INTEGER,
        limit_value INTEGER,
        remaining_value INTEGER,
        reset_at TEXT,
        retry_after_ms INTEGER,
        reset_strategy TEXT NOT NULL DEFAULT 'unknown',
        source TEXT NOT NULL DEFAULT 'probe',
        confidence REAL NOT NULL DEFAULT 0,
        notes TEXT,
        raw_json TEXT,
        endpoint TEXT,
        observed_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_platform ON provider_quota_observations(platform, key_id, observed_at);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_reset_at ON provider_quota_observations(reset_at);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS quirks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        severity TEXT NOT NULL DEFAULT 'info',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS quirk_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quirk_id INTEGER NOT NULL REFERENCES quirks(id) ON DELETE CASCADE,
        platform TEXT,
        model_glob TEXT
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_quirk_targets_quirk ON quirk_targets(quirk_id);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
        kind TEXT NOT NULL DEFAULT 'chat',
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (kind, platform, model_id)
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_platform_model
        ON catalog_model_tombstones(platform, model_id);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS model_overrides (
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_model_tombstones (
        endpoint_scope TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (endpoint_scope, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS playground_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        system_prompt TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_playground_conversations_updated
        ON playground_conversations(updated_at_ms DESC);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY,
        level TEXT CHECK(level IN ('warn','error')),
        source TEXT,
        provider TEXT,
        model TEXT,
        event TEXT,
        request_id TEXT,
        message TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_server_logs_created
        ON server_logs(created_at_ms, id);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        filepath TEXT,
        filesize INTEGER NOT NULL,
        is_full INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        tables_json TEXT NOT NULL DEFAULT '[]'
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS attempt_key_label (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_attempt_id INTEGER NOT NULL,
        key_label TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (request_attempt_id) REFERENCES request_attempts(id) ON DELETE CASCADE
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_attempt_key_label_request ON attempt_key_label(request_attempt_id);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS profile_auto_include (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS idempotency_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        execution_id TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_idempotency_claims_expires
        ON idempotency_claims(expires_at_ms);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS quota_snapshot_freshness (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        last_success_at TEXT NOT NULL,
        reset_cycle_key TEXT NOT NULL,
        quota_state_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS request_hourly (
        hour TEXT PRIMARY KEY,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_request_hourly_hour ON request_hourly(hour);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY,
        level TEXT CHECK(level IN ('warn','error')),
        source TEXT,
        provider TEXT,
        model TEXT,
        event TEXT,
        request_id TEXT,
        message TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_server_logs_created
        ON server_logs(created_at_ms, id);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS search_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        engine_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        key_id INTEGER,
        status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
        latency_ms INTEGER NOT NULL DEFAULT 0,
        result_count INTEGER NOT NULL DEFAULT 0,
        client_agent TEXT,
        error TEXT
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_search_requests_created_at ON search_requests(created_at);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_search_requests_engine_created ON search_requests(engine_id, created_at);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS response_cache (
        cache_key TEXT PRIMARY KEY,
        body_json TEXT NOT NULL,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_id INTEGER,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        last_hit_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_response_cache_expires
        ON response_cache(expires_at_ms);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS key_monthly_usage (
        key_id INTEGER NOT NULL,
        month TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, month)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS key_monthly_budget (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        month TEXT NOT NULL,
        request_cap INTEGER NOT NULL DEFAULT 0,
        token_cap INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (key_id, month)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS request_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_ordinal INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        start_offset_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_request_attempts_request_id
        ON request_attempts(request_id, ordinal);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_endpoint_group_label (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        group_label TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS embedding_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        family TEXT NOT NULL,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        max_input_tokens INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        quota_label TEXT NOT NULL DEFAULT '',
        UNIQUE(platform, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS media_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        modality TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        quota_label TEXT NOT NULL DEFAULT '',
        UNIQUE(platform, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS rate_limit_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_id INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, model_id, key_id)
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_model_tombstones (
        endpoint_scope TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (endpoint_scope, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS models_endpoint_identity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        UNIQUE(platform, model_id, scope)
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_models_endpoint_scope ON models_endpoint_identity(scope);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS client_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        encrypted_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        system_prompt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS api_key_proxy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        proxy_url TEXT NOT NULL,
        proxy_type TEXT NOT NULL DEFAULT 'http',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS backup_tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        backup_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at);
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_endpoint_host_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_endpoint_group_label (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        group_label TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_model_tombstones (
        endpoint_scope TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (endpoint_scope, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_endpoint_host_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_endpoint_group_label (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        group_label TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_model_tombstones (
        endpoint_scope TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (endpoint_scope, model_id)
      )
    `;
    await _sql`
      CREATE TABLE IF NOT EXISTS custom_endpoint_host_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
  })();
}

/** Get the query tag. Always `await initDb()` first. */
async function db(): Promise<Sql | null> {
  if (!Deno.env.get("DATABASE_URL")) return null;
  await initDb();
  return _sql;
}

// ---------------- API keys ----------------

export async function getApiKey(platform: string): Promise<DbEntry | null> {
  const sql = await db();
  if (!sql) return null;
  const rows = await sql`SELECT * FROM api_keys WHERE platform = ${platform}`;
  return rows.length ? rowToEntry(rows[0]) : null;
}

export async function listApiKeys(): Promise<DbEntry[]> {
  const sql = await db();
  if (!sql) {
    // File-mode fallback: read from in-memory keys loaded via loadDb()
    const keys = getAllKeys();
    if (!keys.length) return [];
    return keys.map((k, i) => ({
      id: String(k.id ?? i + 1),
      platform: k.platform,
      label: k.label ?? "",
      encrypted_key: k.encrypted_key ?? "",
      iv: k.iv ?? "",
      auth_tag: k.auth_tag ?? "",
      status: k.status ?? "healthy",
      enabled: k.enabled,
      base_url: k.base_url ?? "",
      updated_at: new Date(),
    }));
  }
  const rows = await sql`SELECT * FROM api_keys ORDER BY platform`;
  return rows.map(rowToEntry);
}

export async function saveApiKey(entry: DbEntry): Promise<void> {
  const sql = await db();
  if (!sql) return;
  // @ts-ignore: postgres.js template literal type issue
  await sql`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, updated_at)
    VALUES (${entry.platform}, ${entry.label ?? null}, ${entry.encrypted_key ?? null},
            ${entry.iv ?? null}, ${entry.auth_tag ?? null}, ${entry.status ?? "healthy"},
            ${entry.enabled}, ${entry.base_url ?? null}, now())
    ON CONFLICT (platform) DO UPDATE SET
      label         = COALESCE(EXCLUDED.label, api_keys.label),
      encrypted_key = COALESCE(EXCLUDED.encrypted_key, api_keys.encrypted_key),
      iv            = COALESCE(EXCLUDED.iv, api_keys.iv),
      auth_tag      = COALESCE(EXCLUDED.auth_tag, api_keys.auth_tag),
      status        = EXCLUDED.status,
      enabled       = EXCLUDED.enabled,
      base_url      = COALESCE(EXCLUDED.base_url, api_keys.base_url),
      updated_at    = now()
  `;
}

export async function deleteApiKey(platform: string): Promise<void> {
  const sql = await db();
  if (!sql) return;
  // @ts-ignore: postgres.js template literal type issue
  await sql`DELETE FROM api_keys WHERE platform = ${platform}`;
}

function rowToEntry(r: Record<string, unknown>): DbEntry {
  return {
    id: String(r.platform),
    platform: String(r.platform),
    label: r.label == null ? undefined : String(r.label),
    encrypted_key: r.encrypted_key == null ? undefined : String(r.encrypted_key),
    iv: r.iv == null ? undefined : String(r.iv),
    auth_tag: r.auth_tag == null ? undefined : String(r.auth_tag),
    status: r.status == null ? undefined : String(r.status),
    enabled: Boolean(r.enabled),
    base_url: r.base_url == null ? undefined : String(r.base_url),
  };
}

// ---------------- Discovered models ----------------

export async function saveModels(platform: string, models: DiscoveredModel[]): Promise<void> {
  const sql = await db();
  if (!sql) return;
  // @ts-ignore: postgres.js template literal type issue
  await sql`DELETE FROM discovered_models WHERE platform = ${platform}`;
  if (models.length === 0) return;

  const CHUNK = 200;
  for (let i = 0; i < models.length; i += CHUNK) {
    const slice = models.slice(i, i + CHUNK);
    // postgres.js v3: sql(array-of-tuples) generates (?,?...),(?,...),...
    const rowTuples = slice.map((m) => [platform, m.id, m.displayName, m.enabled, new Date()]);
    // @ts-ignore: postgres.js template literal type issue
    await sql`
      INSERT INTO discovered_models (platform, model_id, display_name, enabled, discovered_at)
      VALUES ${rowTuples}
      ON CONFLICT (platform, model_id) DO UPDATE SET
        display_name  = EXCLUDED.display_name,
        discovered_at = now()
    `;
  }
}

export async function getModels(platform?: string): Promise<DiscoveredModel[]> {
  const sql = await db();
  if (!sql) {
    // File-mode fallback
    const list = getAllDiscoveredModels();
    return platform
      ? list.filter(m => m.platform === platform)
      : list;
  }
  const rows = platform
    ? await sql`SELECT * FROM discovered_models WHERE platform = ${platform} ORDER BY model_id`
    : await sql`SELECT * FROM discovered_models ORDER BY platform, model_id`;

  return rows.map((r) => ({
    id: String(r.model_id),
    platform: String(r.platform),
    displayName: r.display_name == null ? String(r.model_id) : String(r.display_name),
    enabled: Boolean(r.enabled),
    discoveredAt: r.discovered_at instanceof Date ? r.discovered_at.getTime() : Date.now(),
  }));
}

export async function isFreshDiscovery(platform: string): Promise<boolean> {
  const sql = await db();
  if (!sql) return false;
  const rows =
    await sql`SELECT max(discovered_at) AS newest FROM discovered_models WHERE platform = ${platform}`;
  const newest = rows[0]?.newest;
  if (!newest) return false;
  const t = newest instanceof Date ? newest.getTime() : Number(newest);
  return Date.now() - t < 24 * 60 * 60 * 1000;
}

// ---------------- Settings ----------------

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const sql = await db();
  if (!sql) return;
  await sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES (${key}, ${sql.json(value as never)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const sql = await db();
  if (!sql) return null;
  const rows = await sql`SELECT value FROM settings WHERE key = ${key}`;
  if (!rows.length) return null;
  return rows[0].value as T;
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const sql = await db();
  if (!sql) return {};
  const rows = await sql`SELECT key, value FROM settings ORDER BY key`;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    out[String(r.key)] = r.value;
  }
  return out;
}

// ---------------- Health probe ----------------

export async function pingDb(): Promise<{ ok: boolean; detail: string }> {
  try {
    const sql = await db();
    if (!sql) return { ok: false, detail: "No database" };
    // @ts-ignore: postgres.js template literal type issue
    const one = await sql`SELECT 1 AS one, current_database() AS db`;
    const keys = await sql`SELECT count(*)::int AS n FROM api_keys`;
    const models = await sql`SELECT count(*)::int AS n FROM discovered_models`;
    const settings = await sql`SELECT count(*)::int AS n FROM settings`;
    return {
      ok: Number(one[0]?.one ?? one[0]?._1) === 1,
      detail: `db=${one[0]?.db} api_keys=${keys[0]?.n} models=${models[0]?.n} settings=${settings[0]?.n} ` +
        `raw_one=${JSON.stringify(one)}`,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
