/**
 * Client Profiles & Multi-tenant Service — P-CORE-008.
 * Phase C Week 13-14: 多租户体系.
 *
 * Client Profiles CRUD, Quota limits/forecast, Auth Clients, URL Tokens.
 */

import { query, queryRaw, initDb } from "../db/pg.ts";

export interface ClientProfile {
  id: string;
  name: string;
  description?: string;
  api_key_hash: string; // Hashed
  api_key_prefix: string; // First 8 chars for display
  status: "active" | "suspended" | "revoked";
  quota_limits: QuotaLimits;
  model_scope?: string[]; // Allowed model IDs, empty = all
  priority_strategy: "balanced" | "cost" | "speed" | "quality";
  rate_limits: { rpm: number; tpm: number };
  allowed_ips?: string[];
  webhook_url?: string;
  webhook_events?: string[];
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
  created_by?: string;
}

export interface QuotaLimits {
  monthly_requests?: number;
  monthly_tokens?: number;
  daily_requests?: number;
  daily_tokens?: number;
  per_model?: Record<string, { requests?: number; tokens?: number }>;
}

export interface QuotaUsage {
  client_id: string;
  period: "hour" | "day" | "month";
  requests: number;
  tokens: number;
  by_model: Record<string, { requests: number; tokens: number }>;
  updated_at: string;
}

export interface AuthClient {
  id: string;
  name: string;
  client_id: string;
  client_secret_hash: string;
  client_secret_prefix: string;
  redirect_uris: string[];
  scopes: string[];
  grant_types: ("authorization_code" | "client_credentials" | "refresh_token")[];
  access_token_ttl: number;
  refresh_token_ttl: number;
  status: "active" | "suspended" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface URLToken {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  client_id: string;
  scopes: string[];
  expires_at?: string;
  max_uses?: number;
  current_uses: number;
  allowed_models?: string[];
  rate_limit?: { rpm: number };
  status: "active" | "expired" | "revoked";
  created_at: string;
  last_used_at?: string;
}

export interface QuotaForecast {
  client_id: string;
  current_usage: { requests: number; tokens: number };
  projected_usage: { requests: number; tokens: number };
  days_until_limit: number | null;
  recommended_action: "none" | "warning" | "upgrade";
}

/** Hash API key for storage */
function hashApiKey(key: string): string {
  const crypto = (globalThis as any).crypto;
  const buffer = crypto.subtle.digestSync("SHA-256", new TextEncoder().encode(key));
  const bytes: Uint8Array = new Uint8Array(buffer);
  return Array.from(bytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate random API key */
function generateApiKey(prefix: string = "sk"): string {
  const crypto = (globalThis as any).crypto;
  const bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
  const suffix = Array.from(bytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${suffix}`;
}

/** Generate client ID */
function generateClientId(): string {
  const crypto = (globalThis as any).crypto;
  const bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");
}

/** Client Profile Service */
export class ClientProfileService {
  /** Create a new client profile */
  async create(profile: Omit<ClientProfile, "id" | "api_key_hash" | "api_key_prefix" | "created_at" | "updated_at" | "last_used_at">): Promise<{ profile: ClientProfile; api_key: string }> {
    await initDb();
    
    const apiKey = generateApiKey("sk-client");
    const apiKeyHash = hashApiKey(apiKey);
    const apiKeyPrefix = apiKey.slice(0, 12) + "****";
    
    const now = new Date().toISOString();
    const id = `client_${generateClientId()}`;
    
    const newProfile: ClientProfile = {
      id,
      ...profile,
      api_key_hash: apiKeyHash,
      api_key_prefix: apiKeyPrefix,
      created_at: now,
      updated_at: now,
    };
    
    await query`
      INSERT INTO client_profiles (
        id, name, description, api_key_hash, api_key_prefix, status,
        quota_limits, model_scope, priority_strategy, rate_limits,
        allowed_ips, webhook_url, webhook_events, metadata,
        created_at, updated_at
      ) VALUES (
        ${id}, ${newProfile.name}, ${newProfile.description ?? null},
        ${newProfile.api_key_hash}, ${newProfile.api_key_prefix}, ${newProfile.status},
        ${JSON.stringify(newProfile.quota_limits)}, ${JSON.stringify(newProfile.model_scope ?? [])},
        ${newProfile.priority_strategy}, ${JSON.stringify(newProfile.rate_limits)},
        ${JSON.stringify(newProfile.allowed_ips ?? [])}, ${newProfile.webhook_url ?? null},
        ${JSON.stringify(newProfile.webhook_events ?? [])}, ${JSON.stringify(newProfile.metadata ?? {})},
        ${now}, ${now}
      )
    `;
    
    return { profile: newProfile, api_key: apiKey };
  }

  /** Get client profile by ID */
  async get(id: string): Promise<ClientProfile | null> {
    await initDb();
    const rows = await query`SELECT * FROM client_profiles WHERE id = ${id}`;
    if (rows.length === 0) return null;
    return mapRowToProfile(rows[0]);
  }

  /** Get client profile by API key */
  async getByApiKey(apiKey: string): Promise<ClientProfile | null> {
    await initDb();
    const hash = hashApiKey(apiKey);
    const rows = await query`SELECT * FROM client_profiles WHERE api_key_hash = ${hash}`;
    if (rows.length === 0) return null;
    return mapRowToProfile(rows[0]);
  }

  /** List client profiles */
  async list(filters?: { status?: ClientProfile["status"]; limit?: number; offset?: number }): Promise<ClientProfile[]> {
    await initDb();
    let sql = "SELECT * FROM client_profiles WHERE 1=1";
      const params: any[] = [];
  
      if (filters?.status) {
        sql += " AND status = ?";
        params.push(filters.status);
      }
      sql += " ORDER BY created_at DESC";
      if (filters?.limit) {
        sql += " LIMIT ?";
        params.push(filters.limit);
      }
      if (filters?.offset) {
        sql += " OFFSET ?";
        params.push(filters.offset);
      }
  
      const rows = await queryRaw(sql, params);
    return rows.map(mapRowToProfile);
  }

  /** Update client profile */
  async update(id: string, updates: Partial<Omit<ClientProfile, "id" | "api_key_hash" | "api_key_prefix" | "created_at">>): Promise<ClientProfile | null> {
    await initDb();
    const existing = await this.get(id);
    if (!existing) return null;
    
    const now = new Date().toISOString();
    const updated = { ...existing, ...updates, updated_at: now };
    
    await query`
      UPDATE client_profiles SET
        name = ${updated.name},
        description = ${updated.description ?? null},
        status = ${updated.status},
        quota_limits = ${JSON.stringify(updated.quota_limits)},
        model_scope = ${JSON.stringify(updated.model_scope ?? [])},
        priority_strategy = ${updated.priority_strategy},
        rate_limits = ${JSON.stringify(updated.rate_limits)},
        allowed_ips = ${JSON.stringify(updated.allowed_ips ?? [])},
        webhook_url = ${updated.webhook_url ?? null},
        webhook_events = ${JSON.stringify(updated.webhook_events ?? [])},
        metadata = ${JSON.stringify(updated.metadata ?? {})},
        updated_at = ${now}
      WHERE id = ${id}
    `;
    
    return updated;
  }

  /** Rotate API key */
  async rotateKey(id: string): Promise<{ profile: ClientProfile; new_api_key: string } | null> {
    await initDb();
    const existing = await this.get(id);
    if (!existing) return null;
    
    const newApiKey = generateApiKey("sk-client");
    const newHash = hashApiKey(newApiKey);
    const newPrefix = newApiKey.slice(0, 12) + "****";
    
    await query`
      UPDATE client_profiles 
      SET api_key_hash = ${newHash}, api_key_prefix = ${newPrefix}, updated_at = ${new Date().toISOString()}
      WHERE id = ${id}
    `;
    
    return { profile: { ...existing, api_key_hash: newHash, api_key_prefix: newPrefix }, new_api_key: newApiKey };
  }

  /** Delete client profile */
  async delete(id: string): Promise<boolean> {
    await initDb();
    await query`DELETE FROM client_profiles WHERE id = ${id}`;
    return true;
  }

  /** Record usage for quota tracking */
  async recordUsage(clientId: string, model: string, requests: number, tokens: number): Promise<void> {
    await initDb();
    const now = new Date();
    const hourKey = now.toISOString().slice(0, 13) + ":00:00.000Z";
    const dayKey = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
    const monthKey = now.toISOString().slice(0, 7) + "-01T00:00:00.000Z";
    
    for (const [period, periodKey] of [["hour", hourKey], ["day", dayKey], ["month", monthKey]] as const) {
      await query`
        INSERT INTO quota_usage (client_id, period, period_key, model, requests, tokens, updated_at)
        VALUES (${clientId}, ${period}, ${periodKey}, ${model}, ${requests}, ${tokens}, ${now.toISOString()})
        ON CONFLICT (client_id, period, period_key, model) DO UPDATE SET
          requests = quota_usage.requests + ${requests},
          tokens = quota_usage.tokens + ${tokens},
          updated_at = ${now.toISOString()}
      `;
    }
  }

  /** Get quota usage for a period */
  async getUsage(clientId: string, period: "hour" | "day" | "month"): Promise<QuotaUsage> {
    await initDb();
    const now = new Date();
    let periodKey: string;
    
    switch (period) {
      case "hour": periodKey = now.toISOString().slice(0, 13) + ":00:00.000Z"; break;
      case "day": periodKey = now.toISOString().slice(0, 10) + "T00:00:00.000Z"; break;
      case "month": periodKey = now.toISOString().slice(0, 7) + "-01T00:00:00.000Z"; break;
    }
    
    const rows = await query`
      SELECT model, SUM(requests) as requests, SUM(tokens) as tokens
      FROM quota_usage
      WHERE client_id = ${clientId} AND period = ${period} AND period_key = ${periodKey}
      GROUP BY model
    `;
    
    const by_model: Record<string, { requests: number; tokens: number }> = {};
    let totalRequests = 0;
    let totalTokens = 0;
    
    for (const row of rows) {
      by_model[row.model] = { requests: Number(row.requests), tokens: Number(row.tokens) };
      totalRequests += Number(row.requests);
      totalTokens += Number(row.tokens);
    }
    
    return {
      client_id: clientId,
      period,
      requests: totalRequests,
      tokens: totalTokens,
      by_model,
      updated_at: new Date().toISOString(),
    };
  }

  /** Get quota forecast */
  async getForecast(clientId: string): Promise<QuotaForecast> {
    const profile = await this.get(clientId);
    if (!profile) throw new Error("Client not found");
    
    const monthlyUsage = await this.getUsage(clientId, "month");
    const dailyUsage = await this.getUsage(clientId, "day");
    
    const limits = profile.quota_limits;
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dayOfMonth = new Date().getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    
    let projectedRequests = monthlyUsage.requests;
    let projectedTokens = monthlyUsage.tokens;
    let daysUntilLimit: number | null = null;
    let recommendedAction: QuotaForecast["recommended_action"] = "none";
    
    if (limits.monthly_requests && dailyUsage.requests > 0) {
      projectedRequests += dailyUsage.requests * daysRemaining;
      const pct = projectedRequests / limits.monthly_requests;
      if (pct >= 1) daysUntilLimit = 0;
      else if (pct >= 0.9) daysUntilLimit = Math.ceil((limits.monthly_requests - monthlyUsage.requests) / dailyUsage.requests);
    }
    
    if (limits.monthly_tokens && dailyUsage.tokens > 0) {
      projectedTokens += dailyUsage.tokens * daysRemaining;
      const pct = projectedTokens / limits.monthly_tokens;
      if (pct >= 1 && daysUntilLimit === null) daysUntilLimit = 0;
      else if (pct >= 0.9 && daysUntilLimit === null) daysUntilLimit = Math.ceil((limits.monthly_tokens - monthlyUsage.tokens) / dailyUsage.tokens);
    }
    
    if (daysUntilLimit !== null && daysUntilLimit <= 3) recommendedAction = "warning";
    if (daysUntilLimit !== null && daysUntilLimit <= 0) recommendedAction = "upgrade";
    
    return {
      client_id: clientId,
      current_usage: { requests: monthlyUsage.requests, tokens: monthlyUsage.tokens },
      projected_usage: { requests: projectedRequests, tokens: projectedTokens },
      days_until_limit: daysUntilLimit,
      recommended_action: recommendedAction,
    };
  }
}

/** Auth Client Service */
export class AuthClientService {
  async create(client: Omit<AuthClient, "id" | "client_id" | "client_secret_hash" | "client_secret_prefix" | "created_at" | "updated_at">): Promise<{ client: AuthClient; client_secret: string }> {
    await initDb();
    
    const clientSecret = generateApiKey("sk-auth");
    const clientSecretHash = hashApiKey(clientSecret);
    const clientSecretPrefix = clientSecret.slice(0, 12) + "****";
    const clientId = generateClientId();
    
    const now = new Date().toISOString();
    const newClient: AuthClient = {
      id: `auth_${clientId}`,
      client_id: clientId,
      client_secret_hash: clientSecretHash,
      client_secret_prefix: clientSecretPrefix,
      ...client,
      created_at: now,
      updated_at: now,
    };
    
    await query`
      INSERT INTO auth_clients (
        id, name, client_id, client_secret_hash, client_secret_prefix,
        redirect_uris, scopes, grant_types, access_token_ttl, refresh_token_ttl,
        status, created_at, updated_at
      ) VALUES (
        ${newClient.id}, ${newClient.name}, ${newClient.client_id},
        ${newClient.client_secret_hash}, ${newClient.client_secret_prefix},
        ${JSON.stringify(newClient.redirect_uris)}, ${JSON.stringify(newClient.scopes)},
        ${JSON.stringify(newClient.grant_types)}, ${newClient.access_token_ttl},
        ${newClient.refresh_token_ttl}, ${newClient.status}, ${now}, ${now}
      )
    `;
    
    return { client: newClient, client_secret: clientSecret };
  }

  async get(id: string): Promise<AuthClient | null> {
    await initDb();
    const rows = await query`SELECT * FROM auth_clients WHERE id = ${id}`;
    if (rows.length === 0) return null;
    return mapRowToAuthClient(rows[0]);
  }

  async getByClientId(clientId: string): Promise<AuthClient | null> {
    await initDb();
    const rows = await query`SELECT * FROM auth_clients WHERE client_id = ${clientId}`;
    if (rows.length === 0) return null;
    return mapRowToAuthClient(rows[0]);
  }

  async list(): Promise<AuthClient[]> {
    await initDb();
    const rows = await query`SELECT * FROM auth_clients ORDER BY created_at DESC`;
    return rows.map(mapRowToAuthClient);
  }

  async update(id: string, updates: Partial<Omit<AuthClient, "id" | "client_id" | "client_secret_hash" | "client_secret_prefix" | "created_at">>): Promise<AuthClient | null> {
    await initDb();
    const existing = await this.get(id);
    if (!existing) return null;
    
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    
    await query`
      UPDATE auth_clients SET
        name = ${updated.name},
        redirect_uris = ${JSON.stringify(updated.redirect_uris)},
        scopes = ${JSON.stringify(updated.scopes)},
        grant_types = ${JSON.stringify(updated.grant_types)},
        access_token_ttl = ${updated.access_token_ttl},
        refresh_token_ttl = ${updated.refresh_token_ttl},
        status = ${updated.status},
        updated_at = ${updated.updated_at}
      WHERE id = ${id}
    `;
    
    return updated;
  }

  async rotateSecret(id: string): Promise<{ client: AuthClient; new_secret: string } | null> {
    await initDb();
    const existing = await this.get(id);
    if (!existing) return null;
    
    const newSecret = generateApiKey("sk-auth");
    const newHash = hashApiKey(newSecret);
    const newPrefix = newSecret.slice(0, 12) + "****";
    
    await query`
      UPDATE auth_clients 
      SET client_secret_hash = ${newHash}, client_secret_prefix = ${newPrefix}, updated_at = ${new Date().toISOString()}
      WHERE id = ${id}
    `;
    
    return { client: { ...existing, client_secret_hash: newHash, client_secret_prefix: newPrefix }, new_secret: newSecret };
  }

  async delete(id: string): Promise<boolean> {
    await initDb();
    await query`DELETE FROM auth_clients WHERE id = ${id}`;
    return true;
  }
}

/** URL Token Service */
export class URLTokenService {
  async create(token: Omit<URLToken, "id" | "token_hash" | "token_prefix" | "current_uses" | "created_at" | "last_used_at">): Promise<{ token: URLToken; raw_token: string }> {
    await initDb();
    
    const rawToken = generateApiKey("tok");
    const tokenHash = hashApiKey(rawToken);
    const tokenPrefix = rawToken.slice(0, 12) + "****";
    const id = `tok_${generateClientId()}`;
    
    const now = new Date().toISOString();
    const newToken: URLToken = {
      id,
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      current_uses: 0,
      created_at: now,
      ...token,
    };
    
    await query`
      INSERT INTO url_tokens (
        id, name, token_hash, token_prefix, client_id, scopes,
        expires_at, max_uses, current_uses, allowed_models, rate_limit,
        status, created_at
      ) VALUES (
        ${id}, ${newToken.name}, ${newToken.token_hash}, ${newToken.token_prefix},
        ${newToken.client_id}, ${JSON.stringify(newToken.scopes)},
        ${newToken.expires_at ?? null}, ${newToken.max_uses ?? null}, 0,
        ${JSON.stringify(newToken.allowed_models ?? [])}, ${JSON.stringify(newToken.rate_limit ?? {})},
        ${newToken.status}, ${now}
      )
    `;
    
    return { token: newToken, raw_token: rawToken };
  }

  async get(id: string): Promise<URLToken | null> {
    await initDb();
    const rows = await query`SELECT * FROM url_tokens WHERE id = ${id}`;
    if (rows.length === 0) return null;
    return mapRowToUrlToken(rows[0]);
  }

  async getByToken(rawToken: string): Promise<URLToken | null> {
    await initDb();
    const hash = hashApiKey(rawToken);
    const rows = await query`SELECT * FROM url_tokens WHERE token_hash = ${hash}`;
    if (rows.length === 0) return null;
    return mapRowToUrlToken(rows[0]);
  }

  async list(clientId?: string): Promise<URLToken[]> {
    await initDb();
    let sql = "SELECT * FROM url_tokens WHERE 1=1";
    const params: any[] = [];
    if (clientId) {
      sql += " AND client_id = ?";
      params.push(clientId);
    }
    sql += " ORDER BY created_at DESC";
    const rows = await queryRaw(sql, params);
    return rows.map(mapRowToUrlToken);
  }

  async validateAndConsume(rawToken: string): Promise<URLToken | null> {
    const token = await this.getByToken(rawToken);
    if (!token) return null;
    if (token.status !== "active") return null;
    if (token.expires_at && new Date(token.expires_at) < new Date()) return null;
    if (token.max_uses && token.current_uses >= token.max_uses) return null;
    
    await initDb();
    await query`
      UPDATE url_tokens 
      SET current_uses = current_uses + 1, last_used_at = ${new Date().toISOString()}
      WHERE id = ${token.id}
    `;
    
    return { ...token, current_uses: token.current_uses + 1, last_used_at: new Date().toISOString() };
  }

  async revoke(id: string): Promise<boolean> {
    await initDb();
    await query`UPDATE url_tokens SET status = 'revoked' WHERE id = ${id}`;
    return true;
  }

  async delete(id: string): Promise<boolean> {
    await initDb();
    await query`DELETE FROM url_tokens WHERE id = ${id}`;
    return true;
  }
}

/** Map database row to ClientProfile */
function mapRowToProfile(row: any): ClientProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    api_key_hash: row.api_key_hash,
    api_key_prefix: row.api_key_prefix,
    status: row.status,
    quota_limits: typeof row.quota_limits === "string" ? JSON.parse(row.quota_limits) : row.quota_limits,
    model_scope: typeof row.model_scope === "string" ? JSON.parse(row.model_scope) : row.model_scope,
    priority_strategy: row.priority_strategy,
    rate_limits: typeof row.rate_limits === "string" ? JSON.parse(row.rate_limits) : row.rate_limits,
    allowed_ips: typeof row.allowed_ips === "string" ? JSON.parse(row.allowed_ips) : row.allowed_ips,
    webhook_url: row.webhook_url,
    webhook_events: typeof row.webhook_events === "string" ? JSON.parse(row.webhook_events) : row.webhook_events,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at,
    created_by: row.created_by,
  };
}

/** Map database row to AuthClient */
function mapRowToAuthClient(row: any): AuthClient {
  return {
    id: row.id,
    name: row.name,
    client_id: row.client_id,
    client_secret_hash: row.client_secret_hash,
    client_secret_prefix: row.client_secret_prefix,
    redirect_uris: typeof row.redirect_uris === "string" ? JSON.parse(row.redirect_uris) : row.redirect_uris,
    scopes: typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes,
    grant_types: typeof row.grant_types === "string" ? JSON.parse(row.grant_types) : row.grant_types,
    access_token_ttl: Number(row.access_token_ttl),
    refresh_token_ttl: Number(row.refresh_token_ttl),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Map database row to URLToken */
function mapRowToUrlToken(row: any): URLToken {
  return {
    id: row.id,
    name: row.name,
    token_hash: row.token_hash,
    token_prefix: row.token_prefix,
    client_id: row.client_id,
    scopes: typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes,
    expires_at: row.expires_at,
    max_uses: row.max_uses ? Number(row.max_uses) : undefined,
    current_uses: Number(row.current_uses),
    allowed_models: typeof row.allowed_models === "string" ? JSON.parse(row.allowed_models) : row.allowed_models,
    rate_limit: typeof row.rate_limit === "string" ? JSON.parse(row.rate_limit) : row.rate_limit,
    status: row.status,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

/** Database schema for multi-tenant tables */
export const MULTI_TENANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS client_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  api_key_hash TEXT NOT NULL,
  api_key_prefix TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  quota_limits TEXT NOT NULL,
  model_scope TEXT,
  priority_strategy TEXT NOT NULL CHECK (priority_strategy IN ('balanced', 'cost', 'speed', 'quality')),
  rate_limits TEXT NOT NULL,
  allowed_ips TEXT,
  webhook_url TEXT,
  webhook_events TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS quota_usage (
  client_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('hour', 'day', 'month')),
  period_key TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, period, period_key, model)
);

CREATE TABLE IF NOT EXISTS auth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  client_secret_prefix TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  access_token_ttl INTEGER NOT NULL DEFAULT 3600,
  refresh_token_ttl INTEGER NOT NULL DEFAULT 2592000,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS url_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  allowed_models TEXT,
  rate_limit TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_client_period ON quota_usage(client_id, period, period_key);
CREATE INDEX IF NOT EXISTS idx_auth_clients_client_id ON auth_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_url_tokens_client ON url_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_url_tokens_hash ON url_tokens(token_hash);
` as const;

/** Global service instances */
export const clientProfileService = new ClientProfileService();
export const authClientService = new AuthClientService();
export const urlTokenService = new URLTokenService();