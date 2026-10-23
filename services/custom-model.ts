/**
 * Custom Model Lifecycle Service — Register/Sync/Tombstone/Retirement for P-CORE-011.
 * Phase C Week 13-14: 自定义模型全生命周期.
 *
 * Manages custom models from registration to retirement with sync, versioning, and deprecation.
 */

import { query, queryRaw, initDb } from "../db/pg.ts";
import { providerRegistry, initializeRegistry } from "../providers/index.ts";

initializeRegistry();

export interface CustomModel {
  id: string;
  name: string;
  display_name: string;
  provider: string;
  base_model?: string;
  description?: string;
  capabilities: {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    max_context: number;
  };
  pricing: { input_per_1k: number; output_per_1k: number; currency: string };
  config: {
    endpoint?: string;
    api_key_ref?: string;
    parameters?: Record<string, any>;
  };
  // Quota limits (optional, for routing priority / budget enforcement)
  rpm_limit?: number;
  rpd_limit?: number;
  tpm_limit?: number;
  tpd_limit?: number;
  monthly_token_budget?: string;
  status: "active" | "deprecated" | "retired" | "pending_sync";
  version: string;
  sync_status: "synced" | "pending" | "failed";
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
  retired_at?: string;
  tombstone_reason?: string;
}

export interface ModelRegistration {
  name: string;
  display_name: string;
  provider: string;
  base_model?: string;
  description?: string;
  capabilities: CustomModel["capabilities"];
  pricing: CustomModel["pricing"];
  config: CustomModel["config"];
  rpm_limit?: number;
  rpd_limit?: number;
  tpm_limit?: number;
  tpd_limit?: number;
  monthly_token_budget?: string;
}

export interface SyncResult {
  success: boolean;
  models_synced: number;
  models_failed: number;
  errors: Array<{ model_id: string; error: string }>;
}

const MODEL_STATUS_TRANSITIONS: Record<string, string[]> = {
  active: ["deprecated", "retired"],
  deprecated: ["retired", "active"],
  retired: [], // Terminal state
  pending_sync: ["active", "failed"],
};

/** Generate unique model ID */
function generateModelId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `custom/${slug}-${Date.now().toString(36)}`;
}

/** Validate status transition */
function canTransition(from: string, to: string): boolean {
  return MODEL_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Register a new custom model */
export async function registerCustomModel(
  registration: ModelRegistration,
  createdBy?: string
): Promise<CustomModel> {
  await initDb();
  
  const now = new Date().toISOString();
  const modelId = generateModelId(registration.name);
  
  const model: CustomModel = {
    id: modelId,
    name: registration.name,
    display_name: registration.display_name,
    provider: registration.provider,
    base_model: registration.base_model,
    description: registration.description,
    capabilities: registration.capabilities,
    pricing: registration.pricing,
    config: registration.config,
    status: "pending_sync",
    version: "1.0.0",
    sync_status: "pending",
    created_at: now,
    updated_at: now,
  };

  await query`
    INSERT INTO custom_models (
      id, name, display_name, provider, base_model, description,
      capabilities, pricing, config, status, version, sync_status,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      created_at, updated_at
    ) VALUES (
      ${model.id}, ${model.name}, ${model.display_name}, ${model.provider},
      ${model.base_model ?? null}, ${model.description ?? null},
      ${JSON.stringify(model.capabilities)}, ${JSON.stringify(model.pricing)},
      ${JSON.stringify(model.config)}, ${model.status}, ${model.version},
      ${model.sync_status},
      ${model.rpm_limit ?? null}, ${model.rpd_limit ?? null},
      ${model.tpm_limit ?? null}, ${model.tpd_limit ?? null},
      ${model.monthly_token_budget ?? null},
      ${model.created_at}, ${model.updated_at}
    )
  `;

  // Attempt initial sync
  const syncResult = await syncCustomModel(model.id);
  if (!syncResult.success) {
    model.sync_status = "failed";
  } else {
    model.status = "active";
    model.sync_status = "synced";
    model.last_synced_at = now;
  }
  
  await query`
    UPDATE custom_models 
    SET status = ${model.status}, sync_status = ${model.sync_status}, last_synced_at = ${model.last_synced_at ?? null}
    WHERE id = ${model.id}
  `;

  return model;
}

/** Get custom model by ID */
export async function getCustomModel(modelId: string): Promise<CustomModel | null> {
  await initDb();
  const rows = await query`
    SELECT * FROM custom_models WHERE id = ${modelId}
  `;
  if (rows.length === 0) return null;
  return mapRowToModel(rows[0]);
}

/** List custom models with filters */
export async function listCustomModels(filters?: {
  provider?: string;
  status?: CustomModel["status"];
  limit?: number;
  offset?: number;
}): Promise<CustomModel[]> {
  await initDb();
  
  let sql = "SELECT * FROM custom_models WHERE 1=1";
  const params: any[] = [];
  
  if (filters?.provider) {
    sql += " AND provider = ?";
    params.push(filters.provider);
  }
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
  return rows.map(mapRowToModel);
}

/** Update custom model */
export async function updateCustomModel(
  modelId: string,
  updates: Partial<Pick<CustomModel, "display_name" | "description" | "capabilities" | "pricing" | "config">>
): Promise<CustomModel | null> {
  await initDb();
  
  const model = await getCustomModel(modelId);
  if (!model) return null;
  
  const now = new Date().toISOString();
  const newVersion = incrementVersion(model.version);
  
  const updated: CustomModel = {
    ...model,
    ...updates,
    version: newVersion,
    updated_at: now,
    sync_status: "pending", // Requires re-sync
  };
  
  await query`
    UPDATE custom_models 
    SET display_name = ${updated.display_name},
        description = ${updated.description ?? null},
        capabilities = ${JSON.stringify(updated.capabilities)},
        pricing = ${JSON.stringify(updated.pricing)},
        config = ${JSON.stringify(updated.config)},
        version = ${updated.version},
        updated_at = ${updated.updated_at},
        sync_status = ${updated.sync_status},
        rpm_limit = ${updated.rpm_limit ?? null},
        rpd_limit = ${updated.rpd_limit ?? null},
        tpm_limit = ${updated.tpm_limit ?? null},
        tpd_limit = ${updated.tpd_limit ?? null},
        monthly_token_budget = ${updated.monthly_token_budget ?? null}
    WHERE id = ${modelId}
  `;
  
  return updated;
}

/** Sync custom model with provider */
export async function syncCustomModel(modelId: string): Promise<{ success: boolean; error?: string }> {
  await initDb();
  
  const model = await getCustomModel(modelId);
  if (!model) return { success: false, error: "Model not found" };
  
  try {
    const adapter = providerRegistry.get(model.provider);
    if (!adapter) {
      return { success: false, error: `Provider ${model.provider} not found` };
    }
    
    // Test the model endpoint
    const testResult = await adapter.test({
      id: model.id,
      db_id: 0,
      platform: model.provider,
      label: model.name,
      encrypted_key: model.config.api_key_ref ?? "",
      iv: "",
      auth_tag: "",
      status: "healthy",
      enabled: true,
      base_url: model.config.endpoint,
    });
    
    if (!testResult.ok) {
      return { success: false, error: testResult.error ?? "Provider test failed" };
    }
    
    // Update sync status
    const now = new Date().toISOString();
    await query`
      UPDATE custom_models 
      SET sync_status = 'synced', last_synced_at = ${now}, status = 'active'
      WHERE id = ${modelId}
    `;
    
    return { success: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await query`
      UPDATE custom_models 
      SET sync_status = 'failed', status = 'pending_sync'
      WHERE id = ${modelId}
    `;
    return { success: false, error };
  }
}

/** Sync all custom models */
export async function syncAllCustomModels(): Promise<SyncResult> {
  const models = await listCustomModels({ status: "active" });
  
  const result: SyncResult = { success: true, models_synced: 0, models_failed: 0, errors: [] };
  
  for (const model of models) {
    const syncResult = await syncCustomModel(model.id);
    if (syncResult.success) {
      result.models_synced++;
    } else {
      result.models_failed++;
      result.errors.push({ model_id: model.id, error: syncResult.error ?? "Unknown error" });
    }
  }
  
  result.success = result.models_failed === 0;
  return result;
}

/** Deprecate a custom model */
export async function deprecateCustomModel(modelId: string, reason?: string): Promise<CustomModel | null> {
  const model = await getCustomModel(modelId);
  if (!model) return null;
  if (!canTransition(model.status, "deprecated")) {
    throw new Error(`Cannot deprecate model in status: ${model.status}`);
  }
  
  const now = new Date().toISOString();
  await query`
    UPDATE custom_models 
    SET status = 'deprecated', updated_at = ${now}, tombstone_reason = ${reason ?? null}
    WHERE id = ${modelId}
  `;
  
  return getCustomModel(modelId);
}

/** Retire (permanently remove) a custom model */
export async function retireCustomModel(modelId: string, reason?: string): Promise<CustomModel | null> {
  const model = await getCustomModel(modelId);
  if (!model) return null;
  if (!canTransition(model.status, "retired")) {
    throw new Error(`Cannot retire model in status: ${model.status}`);
  }
  
  const now = new Date().toISOString();
  await query`
    UPDATE custom_models 
    SET status = 'retired', updated_at = ${now}, retired_at = ${now}, tombstone_reason = ${reason ?? null}
    WHERE id = ${modelId}
  `;
  
  return getCustomModel(modelId);
}

/** Create tombstone for retired model (soft delete with marker) */
export async function createTombstone(modelId: string, reason: string): Promise<void> {
  await initDb();
  const model = await getCustomModel(modelId);
  if (!model) return;
  
  await query`
    INSERT INTO model_tombstones (model_id, name, provider, reason, retired_at, original_data)
    VALUES (${model.id}, ${model.name}, ${model.provider}, ${reason}, ${new Date().toISOString()}, ${JSON.stringify(model)})
  `;
}

/** Restore a deprecated model */
export async function restoreCustomModel(modelId: string): Promise<CustomModel | null> {
  const model = await getCustomModel(modelId);
  if (!model) return null;
  if (!canTransition(model.status, "active")) {
    throw new Error(`Cannot restore model in status: ${model.status}`);
  }
  
  const now = new Date().toISOString();
  await query`
    UPDATE custom_models 
    SET status = 'active', updated_at = ${now}, tombstone_reason = NULL
    WHERE id = ${modelId}
  `;
  
  return getCustomModel(modelId);
}

/** Delete custom model completely (hard delete) */
export async function deleteCustomModel(modelId: string): Promise<boolean> {
  await initDb();
  const result = await query`
    DELETE FROM custom_models WHERE id = ${modelId}
  `;
  return true; // query doesn't return affected rows easily
}

/** Get model version history (placeholder for future) */
export async function getModelVersions(modelId: string): Promise<Array<{ version: string; created_at: string; changes: string }>> {
  // Would need a separate versions table
  return [];
}

/** Increment semantic version */
function incrementVersion(version: string): string {
  const parts = version.split(".").map(Number);
  parts[2] = (parts[2] ?? 0) + 1;
  return parts.join(".");
}

/** Map database row to CustomModel */
function mapRowToModel(row: any): CustomModel {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    provider: row.provider,
    base_model: row.base_model,
    description: row.description,
    capabilities: typeof row.capabilities === "string" ? JSON.parse(row.capabilities) : row.capabilities,
    pricing: typeof row.pricing === "string" ? JSON.parse(row.pricing) : row.pricing,
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    rpm_limit: row.rpm_limit ?? undefined,
    rpd_limit: row.rpd_limit ?? undefined,
    tpm_limit: row.tpm_limit ?? undefined,
    tpd_limit: row.tpd_limit ?? undefined,
    monthly_token_budget: row.monthly_token_budget ?? undefined,
    status: row.status,
    version: row.version,
    sync_status: row.sync_status,
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    retired_at: row.retired_at,
    tombstone_reason: row.tombstone_reason,
  };
}

/** Load active custom models for a platform, with capabilities parsed for routing. */
export async function loadCustomRoutableModels(platform: string) {
  try {
    await initDb();
    const rows = await query`
      SELECT id, display_name, provider, capabilities, pricing, config,
             rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget
      FROM custom_models
      WHERE provider = ${platform} AND status = 'active'
    `;
    const out = [];
    for (const r of rows as any[]) {
      let caps: any = {};
      try { caps = JSON.parse(r.capabilities); } catch { caps = {}; }
      let pricing: any = {};
      try { pricing = JSON.parse(r.pricing); } catch {}
      const free = pricing.input_per_1k === 0 && pricing.output_per_1k === 0;
      
      const intelRank = 500;
      const sizeLabel = caps.max_context && caps.max_context >= 200_000 ? "Extra Large" :
                        caps.max_context && caps.max_context >= 128_000 ? "Large" :
                        caps.max_context && caps.max_context >= 32_000 ? "Medium" : "Small";
      
      out.push({
        id: r.id,
        provider: r.provider,
        displayName: r.display_name,
        free,
        supportsVision: caps.vision === true,
        supportsTools: caps.tools === true,
        contextWindow: caps.max_context ?? 128000,
        rpmLimit: r.rpm_limit ?? null,
        rpdLimit: r.rpd_limit ?? null,
        tpmLimit: r.tpm_limit ?? null,
        tpdLimit: r.tpd_limit ?? null,
        monthlyTokenBudget: r.monthly_token_budget ?? "",
        intelligenceRank: intelRank,
        sizeLabel,
      });
    }
    return out;
  } catch (e) {
    console.warn(`[custom-model] loadCustomRoutableModels(${platform}) failed:`, e instanceof Error ? e.message : e);
    return [];
  }
}

/** Database schema for custom models (to be added to db/pg.ts) */
export const CUSTOM_MODELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_model TEXT,
  description TEXT,
  capabilities TEXT NOT NULL,
  pricing TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated', 'retired', 'pending_sync')),
  version TEXT NOT NULL DEFAULT '1.0.0',
  sync_status TEXT NOT NULL CHECK (sync_status IN ('synced', 'pending', 'failed')),
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  monthly_token_budget TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  tombstone_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider);
CREATE INDEX IF NOT EXISTS idx_custom_models_status ON custom_models(status);

CREATE TABLE IF NOT EXISTS model_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  reason TEXT,
  retired_at TEXT NOT NULL,
  original_data TEXT NOT NULL
);
` as const;