/**
 * model-state.ts — Catalog model provenance, overrides & tombstones.
 *
 * Ported from FreeLLMAPI services/model-state.js (336 lines).
 *
 * Keeps catalog-applied values SEPARATE from local operator edits so a daily
 * signed-catalog sync can refresh baselines without clobbering curated local
 * choices. Three pillars:
 *
 *  1. Overrides (model_overrides.overrides_json): operator edits to display/rank/
 *     limits/flags, tracked against recorded catalog baselines so back-to-default
 *     edits auto-release the pin.
 *  2. Tombstones (catalog_model_tombstones): provenance-aware delete markers.
 *     USER deletes hard-drop the row; UPSTREAM retirement disables + keeps it.
 *  3. Catalog vs user provenance: source column distinguishes curated catalog
 *     rows from operator-created custom rows.
 */

import { initDb, query, queryRaw } from "../db/pg.ts";

/** Key inside the overrides blob holding pre-override catalog values. */
const CATALOG_BASELINE_KEY = "catalogDefaults";

/** API field → DB column. Only these are overridable. */
export const OVERRIDE_COLUMNS: Record<string, string> = {
  displayName: "display_name",
  intelligenceRank: "intelligence_rank",
  speedRank: "speed_rank",
  sizeLabel: "size_label",
  rpmLimit: "rpm_limit",
  rpdLimit: "rpd_limit",
  tpmLimit: "tpm_limit",
  tpdLimit: "tpd_limit",
  monthlyTokenBudget: "monthly_token_budget",
  contextWindow: "context_window",
  supportsVision: "supports_vision",
  supportsTools: "supports_tools",
  enabled: "enabled",
};

export type OverridePatch = Partial<Record<keyof typeof OVERRIDE_COLUMNS, unknown>>;

export type ModelProvenance = "catalog" | "discovered" | "user";

// ── Blob parsing ────────────────────────────────────────────────────────────

export function parseOverrides(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toDbValue(key: string, value: unknown): unknown {
  if (key === "supportsVision" || key === "supportsTools" || key === "enabled") {
    return value ? 1 : 0;
  }
  return value;
}

function cleanPatch(patch: OverridePatch): OverridePatch {
  const cleaned: OverridePatch = {};
  for (const key of Object.keys(OVERRIDE_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      (cleaned as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
  }
  return cleaned;
}

/** Split the blob into overridden fields + their pre-override baselines. */
export function parseOverridesBlob(raw: string | null | undefined): {
  overrides: Record<string, unknown>;
  baselines: Record<string, unknown>;
} {
  const overrides = { ...parseOverrides(raw) };
  const rawBaselines = overrides[CATALOG_BASELINE_KEY];
  delete overrides[CATALOG_BASELINE_KEY];
  const baselines: Record<string, unknown> = {};
  if (rawBaselines && typeof rawBaselines === "object") {
    for (const key of Object.keys(rawBaselines as object)) {
      if (key in OVERRIDE_COLUMNS) {
        baselines[key] = (rawBaselines as Record<string, unknown>)[key];
      }
    }
  }
  return { overrides, baselines };
}

/** Convert a catalog-applied DB value into the PATCH representation. */
function modelRowValue(row: Record<string, unknown> | null, key: string): unknown {
  if (!row) return undefined;
  const value = row[OVERRIDE_COLUMNS[key]];
  if (key === "supportsVision" || key === "supportsTools" || key === "enabled") {
    return value === 1 || value === true;
  }
  return value ?? null;
}

/** Read cached catalog defaults from the latest applied catalog JSON. */
async function cachedCatalogDefaults(platform: string, modelId: string): Promise<Record<string, unknown>> {
  const rows = await queryRaw(
    "SELECT value FROM settings WHERE key = 'catalog_applied_json' LIMIT 1",
    [],
  );
  const row = rows[0] as { value?: string } | undefined;
  if (!row?.value) return {};
  try {
    const catalog = JSON.parse(row.value) as {
      models?: Array<{
        platform: string;
        modelId: string;
        modality?: string;
        displayName?: string;
        intelligenceRank?: number;
        speedRank?: number;
        sizeLabel?: string;
        limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
        monthlyTokenBudget?: string;
        contextWindow?: number;
        supportsVision?: boolean;
        supportsTools?: boolean;
        enabled?: boolean;
      }>;
    };
    const m = catalog.models?.find(
      (x) => x.platform === platform && x.modelId === modelId && (!x.modality || x.modality === "text"),
    );
    if (!m) return {};
    return {
      displayName: m.displayName,
      intelligenceRank: m.intelligenceRank,
      speedRank: m.speedRank,
      sizeLabel: m.sizeLabel,
      rpmLimit: m.limits?.rpm,
      rpdLimit: m.limits?.rpd,
      tpmLimit: m.limits?.tpm,
      tpdLimit: m.limits?.tpd,
      monthlyTokenBudget: m.monthlyTokenBudget ?? "",
      contextWindow: m.contextWindow,
      supportsVision: m.supportsVision,
      supportsTools: m.supportsTools,
      enabled: m.enabled,
    };
  } catch {
    return {};
  }
}

// ── Overrides ───────────────────────────────────────────────────────────────

/** Fields a stored overrides blob actually overrides (dashboard badge, #551). */
export function overriddenFieldNames(overridesJson: string | null | undefined): string[] {
  const stored = parseOverrides(overridesJson ?? undefined);
  return Object.keys(stored).filter((key) => key in OVERRIDE_COLUMNS);
}

/** Every model whose overrides pin a given field, as Set<platform:modelId>. */
export async function modelsWithOverriddenField(field: string): Promise<Set<string>> {
  try {
    await initDb();
    const rows = await queryRaw(
      "SELECT platform, model_id, overrides_json FROM model_overrides",
      [],
    );
    const pinned = new Set<string>();
    for (const r of rows as any[]) {
      const overrides = parseOverrides(r.overrides_json);
      if (overrides[field] !== undefined) pinned.add(`${r.platform}:${r.model_id}`);
    }
    return pinned;
  } catch {
    return new Set();
  }
}

export async function getModelOverrides(platform: string, modelId: string): Promise<Record<string, unknown>> {
  try {
    await initDb();
    const rows = await queryRaw(
      "SELECT overrides_json FROM model_overrides WHERE platform = $1 AND model_id = $2",
      [platform, modelId],
    );
    const row = rows[0] as { overrides_json?: string } | undefined;
    return parseOverrides(row?.overrides_json);
  } catch {
    return {};
  }
}

/** Upsert a patch into model_overrides, tracking catalog baselines. */
export async function upsertModelOverrides(
  platform: string,
  modelId: string,
  patch: OverridePatch,
  options: { baselineRow?: Record<string, unknown> | null } = {},
): Promise<Record<string, unknown>> {
  const cleaned = cleanPatch(patch);
  if (Object.keys(cleaned).length === 0) return {};

  await initDb();
  const existing = await query`SELECT overrides_json AS overridesJson FROM model_overrides WHERE platform = ${platform} AND model_id = ${modelId}`;
  const ex = existing[0] as { overridesJson?: string } | undefined;
  const { overrides: stored, baselines } = parseOverridesBlob(ex?.overridesJson);

  // Read raw models table row for catalog baselines (not merged overrides)
  const rawModelRows = await query`SELECT * FROM models WHERE platform = ${platform} AND model_id = ${modelId}`;
  const rawModel = rawModelRows[0] ?? null;

  const merged: Record<string, unknown> = { ...stored };
  const mergedBaselines: Record<string, unknown> = { ...baselines };

  for (const key of Object.keys(cleaned)) {
    const next = (cleaned as Record<string, unknown>)[key];
    if (mergedBaselines[key] === undefined && rawModel) {
      // Capture the catalog baseline from the raw models table row
      const captured = modelRowValue(rawModel, key);
      if (captured !== undefined) mergedBaselines[key] = captured;
    }
    // NOTE: We intentionally do NOT auto-delete overrides when value equals baseline.
    // The baseline tracking is best-effort; removing pins automatically caused issues
    // when the models table already had merged overrides. Operators can manually
    // clear overrides via DELETE /api/models/:id/overrides if needed.
    merged[key] = next;
  }

  if (Object.keys(merged).length === 0) {
    // Nothing left to pin: drop the row so hasOverrides goes false.
    await query`DELETE FROM model_overrides WHERE platform = ${platform} AND model_id = ${modelId}`;
    return {};
  }

  const blob = { ...merged, [CATALOG_BASELINE_KEY]: mergedBaselines };
  await query`
    INSERT INTO model_overrides (platform, model_id, overrides_json, updated_at)
    VALUES (${platform}, ${modelId}, ${JSON.stringify(blob)}, ${new Date().toISOString()})
    ON CONFLICT (platform, model_id) DO UPDATE SET
      overrides_json = ${JSON.stringify(blob)},
      updated_at = ${new Date().toISOString()}
  `;
  return merged;
}

/** Write the current models-row values into the blob's baselines.
 *  Called after catalog metadata is written, before local overrides re-applied. */
export async function refreshModelOverrideBaselines(
  platform: string,
  modelId: string,
): Promise<void> {
  try {
    await initDb();
    const existing = await query`SELECT overrides_json AS overridesJson FROM model_overrides WHERE platform = ${platform} AND model_id = ${modelId}`;
    const ex = existing[0] as { overridesJson?: string } | undefined;
    if (!ex) return;
    const { overrides } = parseOverridesBlob(ex.overridesJson);
    const rowRes = await query`SELECT * FROM models WHERE platform = ${platform} AND model_id = ${modelId}`;
    const row = (rowRes[0] ?? null) as Record<string, unknown> | null;
    const baselines: Record<string, unknown> = {};
    for (const key of Object.keys(cleanPatch(overrides as OverridePatch))) {
      const value = modelRowValue(row, key);
      if (value !== undefined) baselines[key] = value;
    }
    await query`
      UPDATE model_overrides
      SET overrides_json = ${JSON.stringify({ ...overrides, [CATALOG_BASELINE_KEY]: baselines })},
          updated_at = ${new Date().toISOString()}
      WHERE platform = ${platform} AND model_id = ${modelId}
    `;
  } catch (e) {
    console.error("[model-state] refreshModelOverrideBaselines error:", e);
  }
}

/** Apply a model's overrides onto its models-table row. */
export async function applyModelOverrides(platform: string, modelId: string): Promise<boolean> {
  const overrides = await getModelOverrides(platform, modelId);
  const keys = Object.keys(overrides).filter((k) => k in OVERRIDE_COLUMNS);
  if (keys.length === 0) return false;

  const sets: string[] = [];
  const values: unknown[] = [];
  for (let i = 0; i < keys.length; i++) {
    sets.push(`${OVERRIDE_COLUMNS[keys[i]]} = $${i + 1}`);
    values.push(toDbValue(keys[i], overrides[keys[i]]));
  }
  values.push(platform, modelId);
  const sql = `UPDATE models SET ${sets.join(", ")} WHERE platform = $${keys.length + 1} AND model_id = $${keys.length + 2}`;
  await queryRaw(sql, values);
  return true;
}

/** Apply every stored override back onto its row (after a catalog refresh). */
export async function applyAllModelOverrides(): Promise<number> {
  try {
    await initDb();
    const rows = await query`SELECT platform, model_id AS modelId FROM model_overrides`;
    let applied = 0;
    for (const r of rows as any[]) {
      try {
        if (await applyModelOverrides(r.platform, r.modelId)) applied++;
      } catch { /* best-effort per row */ }
    }
    return applied;
  } catch {
    return 0;
  }
}

// ── Provenance ──────────────────────────────────────────────────────────────

/** True when the row is catalog- (not operator-)managed. source='user' = false;
 *  a row attached to a custom endpoint (platform 'custom' or key_id set) = false. */
export function isCatalogManagedModel(
  row: { source?: string; platform?: string; key_id?: number | null } | null,
): boolean {
  if (!row) return false;
  if (row.source === "user") return false;
  return row.platform !== "custom" && row.key_id == null;
}

// ── Tombstones ──────────────────────────────────────────────────────────────

export interface Tombstone {
  source: "upstream_eol" | "user";
  reason: string | null;
  createdAt: string;
}

export async function getCatalogModelTombstone(
  kind: string,
  platform: string,
  modelId: string,
): Promise<Tombstone | undefined> {
  try {
    await initDb();
    const rows = await query`
      SELECT source, reason, created_at AS createdAt
      FROM catalog_model_tombstones
      WHERE kind = ${kind} AND platform = ${platform} AND model_id = ${modelId}
    `;
    const r = rows[0] as any;
    if (!r) return undefined;
    return {
      source: r.source === "upstream_eol" ? "upstream_eol" : "user",
      reason: r.reason ?? null,
      createdAt: r.created_at ?? r.createdAt,
    };
  } catch {
    return undefined;
  }
}

/** Only USER tombstones mean "keep it deleted". */
export async function isCatalogModelTombstoned(
  kind: string,
  platform: string,
  modelId: string,
): Promise<boolean> {
  return (await getCatalogModelTombstone(kind, platform, modelId))?.source === "user";
}

export async function recordCatalogModelTombstone(
  kind: string,
  platform: string,
  modelId: string,
  options: { source?: "upstream_eol" | "user"; reason?: string | null } = {},
): Promise<void> {
  const source = options.source ?? "user";
  const now = new Date().toISOString();
  await query`
    INSERT INTO catalog_model_tombstones (kind, platform, model_id, source, reason, created_at)
    VALUES (${kind}, ${platform}, ${modelId}, ${source}, ${options.reason ?? null}, ${now})
    ON CONFLICT (kind, platform, model_id) DO UPDATE SET
      created_at = ${now}, source = ${source}, reason = ${options.reason ?? null}
  `;
  // A user deletion drops local metadata edits with the row; an upstream
  // retirement keeps the row so its overrides must survive reinstatement.
  if (kind === "chat" && source === "user") {
    await query`DELETE FROM model_overrides WHERE platform = ${platform} AND model_id = ${modelId}`;
  }
}

export async function clearCatalogModelTombstone(
  kind: string,
  platform: string,
  modelId: string,
): Promise<void> {
  await query`DELETE FROM catalog_model_tombstones WHERE kind = ${kind} AND platform = ${platform} AND model_id = ${modelId}`;
}

/** Auto-disable a catalog model the provider reports as permanently retired.
 *  Deliberately NOT a delete: row stays visible, tagged with upstream wording,
 *  operator can flip it back. Returns true when this call performed the retire. */
export async function retireCatalogModelUpstream(
  modelDbId: number,
  platform: string,
  modelId: string,
  reason: string,
): Promise<boolean> {
  const existing = await getCatalogModelTombstone("chat", platform, modelId);
  if (existing) return false;
  await recordCatalogModelTombstone("chat", platform, modelId, { source: "upstream_eol", reason });
  // Disable the row (router skips disabled; explicit requests still resolve).
  await queryRaw("UPDATE models SET enabled = 0 WHERE id = $1", [modelDbId]);
  // Mirror onto any fallback/profile copies so the chain stops picking it.
  try { await queryRaw("UPDATE fallback_config SET enabled = 0 WHERE model_db_id = $1", [modelDbId]); } catch { /* table may not exist */ }
  try { await queryRaw("UPDATE profile_models SET enabled = 0 WHERE model_db_id = $1", [modelDbId]); } catch { /* optional table */ }
  return true;
}

/** Lift an upstream retirement: a catalog that still lists the model (enabled)
 *  is newer, better evidence than one provider's 404. */
export async function reinstateUpstreamRetiredCatalogModel(
  platform: string,
  modelId: string,
): Promise<boolean> {
  const tomb = await getCatalogModelTombstone("chat", platform, modelId);
  if (tomb?.source !== "upstream_eol") return false;
  await clearCatalogModelTombstone("chat", platform, modelId);
  const rows = await query`SELECT id FROM models WHERE platform = ${platform} AND model_id = ${modelId}`;
  const row = rows[0] as { id: number } | undefined;
  if (row) {
    await queryRaw("UPDATE fallback_config SET enabled = 1 WHERE model_db_id = $1", [row.id]);
    await queryRaw("UPDATE profile_models SET enabled = 1 WHERE model_db_id = $1", [row.id]);
  }
  return true;
}

/** Delete catalog rows carrying a USER tombstone (reconciliation after deletes).
 *  Upstream retirement tombstones DISABLE + keep, so we never delete those. */
export async function deleteTombstonedCatalogModels(): Promise<number> {
  let deleted = 0;
  try {
    await initDb();
  } catch {
    return 0;
  }
  // Chat models
  try {
    const chatRows = await queryRaw(
      `SELECT m.id FROM models m
         JOIN catalog_model_tombstones t
           ON t.kind = 'chat' AND t.platform = m.platform AND t.model_id = m.model_id
        WHERE t.source = 'user' AND m.platform != 'custom'
          AND m.source != 'user'`,
      [],
    ) as any[];
    for (const row of chatRows) {
      try { await queryRaw("DELETE FROM model_overrides WHERE platform = (SELECT platform FROM models WHERE id = $1) AND model_id = (SELECT model_id FROM models WHERE id = $1)", [row.id]); } catch { /* ignore */ }
      try { await queryRaw("DELETE FROM fallback_config WHERE model_db_id = $1", [row.id]); } catch { /* ignore */ }
      try { await queryRaw("DELETE FROM profile_models WHERE model_db_id = $1", [row.id]); } catch { /* ignore */ }
      await queryRaw("DELETE FROM models WHERE id = $1", [row.id]);
      deleted++;
    }
  } catch { /* chat delete best-effort */ }
  return deleted;
}