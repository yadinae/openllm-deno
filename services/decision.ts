/**
 * Decision Models — Typed Q&A over the key pool.
 *
 * Decision models answer structured questions (choice/noul/score) instead of
 * generating text. They are catalog entries with modality = 'decision', served
 * on POST /v1/decisions. Routing never consults them; they are a separate
 * surface from chat.
 *
 * Two platforms currently supported:
 * - cloudflare/clef-flash (Workers AI) — key format "account_id:api_token"
 * - openrouter/inception/mercury-decide:free (OpenRouter alpha) — standard key
 */
import { query, initDb } from "../db/pg.ts";
import { providerRegistry } from "../providers/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Inline decryptSecret (avoids circular dependency with router.ts)
// ─────────────────────────────────────────────────────────────────────────────

async function decryptSecret(k: {
  encrypted_key?: string | null;
  iv?: string | null;
  auth_tag?: string | null;
}): Promise<string> {
  if (!k.encrypted_key) return "";
  if (!k.iv || !k.auth_tag) return k.encrypted_key;
  try {
    const { decryptKey } = await import("../db/mod.ts");
    return (await decryptKey(k.encrypted_key, k.iv, k.auth_tag)) || "";
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const DECISION_MODALITY = "decision";

export interface DecisionQuestion {
  type: "choice" | "noul" | "score";
  instructions: unknown;
  criteria?: unknown;
}

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResponse {
  model: string;
  provider: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

export class DecisionError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

export interface DecisionOptions {
  model?: string;
  signal?: AbortSignal;
  clientAgent?: string | null;
  skipPlatforms?: ReadonlySet<string>;
}

export interface DecisionModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  priority: number;
  enabled: number;
  quota_label: string;
  meta_json: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseMeta(raw: string | null): { contextWindow?: number; premiumSince?: string } {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function allDecisionRows(): Promise<DecisionModelRow[]> {
  await initDb();
  const rows = await query`
    SELECT id, platform, model_id, display_name, priority, enabled, quota_label, meta_json
    FROM media_models WHERE modality = ${DECISION_MODALITY} ORDER BY priority, id
  `;
  return rows as DecisionModelRow[];
}

async function getDecisionRow(id: number): Promise<DecisionModelRow | null> {
  await initDb();
  const rows = await query`
    SELECT id, platform, model_id, display_name, priority, enabled, quota_label, meta_json
    FROM media_models WHERE modality = ${DECISION_MODALITY} AND id = ${id}
  `;
  return rows[0] as DecisionModelRow | undefined ?? null;
}

async function setDecisionEnabled(id: number, enabled: boolean): Promise<DecisionModelRow | null> {
  await initDb();
  await query`
    UPDATE media_models SET enabled = ${enabled ? 1 : 0} WHERE id = ${id} AND modality = ${DECISION_MODALITY}
  `;
  return getDecisionRow(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Key loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadKeysForPlatform(platform: string): Promise<Array<{
  id: string;
  db_id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: boolean;
  base_url?: string;
  monthly_request_cap: number;
  monthly_token_cap: number;
}>> {
  await initDb();
  const keys = await query`
    SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url,
           monthly_request_cap, monthly_token_cap
    FROM api_keys
    WHERE platform = ${platform} AND enabled = true AND status = 'healthy'
  `;
  const out = [];
  for (const k of keys as any[]) {
    const decrypted = await decryptSecret(k);
    if (decrypted) {
      out.push({
        id: String(k.id),
        db_id: Number(k.id),
        platform: k.platform,
        label: k.label,
        encrypted_key: decrypted,
        iv: "",
        auth_tag: "",
        status: k.status,
        enabled: k.enabled,
        base_url: k.base_url,
        monthly_request_cap: k.monthly_request_cap ?? 0,
        monthly_token_cap: k.monthly_token_cap ?? 0,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform adapters
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

interface AdapterResult {
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

type Adapter = (
  cred: { id: string; db_id: number; platform: string; label: string; encrypted_key: string },
  modelId: string,
  body: DecisionRequest,
  signal?: AbortSignal,
) => Promise<AdapterResult>;

function usageOf(raw: unknown): AdapterResult["usage"] {
  const u = (raw ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
  return {
    input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
  };
}

function answersOf(raw: unknown, platform: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionError(`${platform} returned no answers`, 502);
  }
  return raw as Record<string, unknown>;
}

function cloudflareKey(key: string): { accountId: string; token: string } {
  const sep = key.indexOf(":");
  if (sep === -1) throw new DecisionError("Cloudflare key must be in format \"account_id:api_token\"", 401);
  return { accountId: key.slice(0, sep), token: key.slice(sep + 1) };
}

const ADAPTERS: Record<string, Adapter> = {
  cloudflare: async (cred, modelId, body, signal) => {
    const { accountId, token } = cloudflareKey(cred.encrypted_key);
    const selector = modelId.split("/").pop() ?? modelId;
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: selector, state: body.state, questions: body.questions }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    const json = await res.json().catch(() => null) as { success?: boolean; result?: { answers?: unknown; usage?: unknown }; errors?: Array<{ message?: string }> };
    if (!json || json.success === false || !json.result) {
      throw new DecisionError(`cloudflare: ${json?.errors?.[0]?.message ?? "no result"}`, 502);
    }
    return { answers: answersOf(json.result.answers, "cloudflare"), usage: usageOf(json.result.usage) };
  },
  openrouter: async (cred, modelId, body, signal) => {
    const res = await fetch(
      "https://openrouter.ai/api/alpha/decisions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cred.encrypted_key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openllm.yadinae.deno.net",
          "X-Title": "OpenLLM-Deno",
        },
        body: JSON.stringify({ model: modelId, state: body.state, questions: body.questions }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    const json = await res.json().catch(() => null) as { answers?: unknown; usage?: unknown; error?: { message?: string } };
    if (json?.error) throw new DecisionError(`openrouter: ${json.error.message ?? "error"}`, 502);
    return { answers: answersOf(json?.answers, "openrouter"), usage: usageOf(json?.usage) };
  },
};

export const DECISION_PLATFORMS = new Set(Object.keys(ADAPTERS));

// ─────────────────────────────────────────────────────────────────────────────
// Decision request logging
// ─────────────────────────────────────────────────────────────────────────────

async function logDecision(
  row: DecisionModelRow,
  keyId: number | null,
  status: "ok" | "error",
  latencyMs: number,
  questionCount: number,
  inputTokens: number,
  clientAgent: string | null,
  error: string | null,
): Promise<void> {
  try {
    await initDb();
    await query`
      INSERT INTO decision_requests (model_id, platform, key_id, status, latency_ms, question_count, input_tokens, client_agent, error)
      VALUES (${row.model_id}, ${row.platform}, ${keyId}, ${status}, ${latencyMs}, ${questionCount}, ${inputTokens}, ${clientAgent}, ${error})
    `;
  } catch (e) {
    console.error("Failed to log decision request:", e);
  }
}

function coolDown(row: DecisionModelRow, keyId: number, e: DecisionError): void {
  console.log(`[decision] cooldown hint: ${row.platform}/${row.model_id} key=${keyId} status=${e.status} retryAfter=${e.retryAfterMs}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main API
// ─────────────────────────────────────────────────────────────────────────────

async function getAllDecisionRows(): Promise<DecisionModelRow[]> {
  await initDb();
  const rows = await query`
    SELECT id, platform, model_id, display_name, priority, enabled, quota_label, meta_json
    FROM media_models WHERE modality = 'decision' ORDER BY priority, id
  `;
  return rows as DecisionModelRow[];
}

export function decisionsAvailable(): boolean {
  return false; // checked per request
}

async function decisionChain(model: string | undefined, skipPlatforms?: ReadonlySet<string>): Promise<DecisionModelRow[]> {
  const enabled = (await allDecisionRows()).filter(r => r.enabled === 1 && ADAPTERS[r.platform]);
  if (!model || model === "auto") return skipPlatforms ? enabled.filter(r => !skipPlatforms.has(r.platform)) : enabled;
  const pinned = enabled.filter(r => r.model_id === model);
  if (pinned.length === 0) {
    const known = (await allDecisionRows()).some(r => r.model_id === model);
    throw new DecisionError(
      known
        ? `Decision model '${model}' is turned off. Turn it on from Models → Decision, or use 'auto'.`
        : `Unknown decision model '${model}'. Use 'auto' or a model id from GET /v1/decisions/models.`,
      400,
    );
  }
  return pinned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry: runDecision
// ─────────────────────────────────────────────────────────────────────────────

export async function runDecision(body: DecisionRequest, opts: DecisionOptions = {}): Promise<DecisionResponse> {
  const chain = await decisionChain(opts.model, opts.skipPlatforms);
  const clientAgent = opts.clientAgent ?? "unknown";
  const questionCount = Object.keys(body.questions).length;

  let lastError: DecisionError | null = null;
  for (const row of chain) {
    const keys = await loadKeysForPlatform(row.platform);
    if (!keys.length) {
      console.warn(`[decision] No healthy keys for ${row.platform}, skipping`);
      continue;
    }
    for (const cred of keys) {
      const adapter = ADAPTERS[row.platform];
      if (!adapter) continue;

      const start = Date.now();
      try {
        const result = await adapter(cred, row.model_id, body, opts.signal);
        await logDecision(row, cred.db_id, "ok", Date.now() - start, questionCount, result.usage.input_tokens, clientAgent, null);
        return { model: row.model_id, provider: row.platform, answers: result.answers, usage: result.usage };
      } catch (e) {
        const err = e as DecisionError;
        await logDecision(row, cred.db_id, "error", Date.now() - start, questionCount, 0, clientAgent, err.message);
        coolDown(row, cred.db_id, err);
        lastError = err;
        if (err.status === 401 || err.status === 403) break;
      }
    }
  }

  throw lastError ?? new DecisionError("No available decision model", 503);
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog sync helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function syncDecisionModels(decisionModels: Array<{
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel: string;
  contextWindow?: number;
  premiumSince?: string;
}>): Promise<{ upserted: number }> {
  await initDb();
  let upserted = 0;
  for (const m of decisionModels) {
    const meta = JSON.stringify({ contextWindow: m.contextWindow, premiumSince: m.premiumSince });
    await query`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
      VALUES (${m.platform}, ${m.modelId}, ${m.displayName}, 'decision', ${m.priority}, ${m.enabled ? 1 : 0}, ${m.quotaLabel}, ${meta})
      ON CONFLICT (platform, model_id) DO UPDATE SET
        display_name = ${m.displayName},
        priority = ${m.priority},
        enabled = ${m.enabled ? 1 : 0},
        quota_label = ${m.quotaLabel},
        meta_json = ${meta}
    `;
    upserted++;
  }
  return { upserted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported helpers for API layer
// ─────────────────────────────────────────────────────────────────────────────

export { allDecisionRows, getDecisionRow, setDecisionEnabled };
