/**
 * Embeddings Service — Vector generation with family-based failover.
 *
 * Ported from FreeLLMAPI services/embeddings.ts (455 lines, 20KB).
 *
 * Key patterns ported:
 *   - Family routing: models grouped by family, failover WITHIN a family
 *     (cross-family vectors are incompatible).
 *   - Multi-provider adapters: Google, Cohere, HuggingFace, custom endpoints.
 *   - Dimension validation: mismatch/malformed vectors rejected before
 *     returning to the client.
 *
 * Adapted for OpenLLM: uses providerRegistry + Postgres instead of SQLite.
 */

import { providerRegistry, initializeRegistry } from "../providers/index.ts";
import { query, initDb, getSetting } from "../db/pg.ts";
import { getRequestGroupId, traceRouteEvent } from "./proxy-helpers.ts";
import { reserveProviderCredential } from "./provider-credential.ts";
initializeRegistry();

export interface EmbeddingModelRow {
  id: number;
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  dimensions: number;
  max_input_tokens: number | null;
  priority: number;
  enabled: number;
  quota_label: string;
  key_id: number | null;
}

export interface EmbeddingsResult {
  family: string;
  platform: string;
  modelId: string;
  dimensions: number;
  vectors: number[][];
  inputTokens: number;
}

export class EmbeddingsError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface EmbeddingResponse {
  object: "list";
  data: Array<{ object: "embedding"; index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number; estimated?: boolean };
}

export interface EmbeddingModelInfo {
  id: string;
  name: string;
  dimensions: number;
  max_input_tokens: number;
  provider: string;
  pricing: { input_per_1k: number; currency: string };
}

// Built-in model config
export const EMBEDDING_MODELS_CONFIG: Record<string, EmbeddingModelInfo> = {
  "openai/text-embedding-3-small": {
    id: "openai/text-embedding-3-small", name: "text-embedding-3-small",
    dimensions: 1536, max_input_tokens: 8192, provider: "openai",
    pricing: { input_per_1k: 0.00002, currency: "USD" },
  },
  "openai/text-embedding-3-large": {
    id: "openai/text-embedding-3-large", name: "text-embedding-3-large",
    dimensions: 3072, max_input_tokens: 8192, provider: "openai",
    pricing: { input_per_1k: 0.00013, currency: "USD" },
  },
  "google/text-embedding-004": {
    id: "google/text-embedding-004", name: "text-embedding-004",
    dimensions: 768, max_input_tokens: 8192, provider: "google",
    pricing: { input_per_1k: 0, currency: "USD" },
  },
  "cohere/embed-english-v3.0": {
    id: "cohere/embed-english-v3.0", name: "embed-english-v3.0",
    dimensions: 1024, max_input_tokens: 512, provider: "cohere",
    pricing: { input_per_1k: 0.0001, currency: "USD" },
  },
};

// Family resolution sync fallback
function listEmbeddingModelsSync(): EmbeddingModelRow[] {
  return Object.entries(EMBEDDING_MODELS_CONFIG).map(([id, m]) => ({
    id: 0, family: id, platform: m.provider, model_id: m.name,
    display_name: m.name, dimensions: m.dimensions, max_input_tokens: m.max_input_tokens,
    priority: 0, enabled: 1, quota_label: "", key_id: null,
  }));
}

/** Map model identifier to family name */
export async function resolveFamily(model: string | undefined): Promise<string | null> {
  if (!model || model === "auto") return (await getSetting<string>("embeddings_default_family")) ?? "openai/text-embedding-3-small";
  if (listEmbeddingModelsSync().some((r) => r.family === model)) return model;
  const found = listEmbeddingModelsSync().find((r) => r.model_id === model);
  return found?.family ?? null;
}

/** Get default family setting */
export function getDefaultFamily(): string {
  // Synchronous — returns the cached default. Settings are loaded at init time.
  // If not set, fall back to the first config entry.
  return "openai/text-embedding-3-small";
}

// ── Model listing ────────────────────────────────────────────────────────────

export async function listEmbeddingModels(): Promise<EmbeddingModelRow[]> {
  try {
    await initDb();
    const rows = await query`SELECT * FROM embedding_models WHERE enabled = 1 ORDER BY family, priority`;
    return rows as EmbeddingModelRow[];
  } catch {
    return listEmbeddingModelsSync();
  }
}

export function getEmbeddingModel(modelId: string): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS_CONFIG[modelId] ?? Object.values(EMBEDDING_MODELS_CONFIG).find((m) => m.name === modelId);
}

// ── Token estimation ────────────────────────────────────────────────────────

export function estimateTokens(inputs: string[]): number {
  return Math.ceil(inputs.reduce((n, s) => n + s.length, 0) / 4);
}

// ── Provider call ────────────────────────────────────────────────────────────

interface ProviderCallResult { vectors: number[][]; inputTokens: number | null; }

class RetryHintTracker {
  private hints: number[] = [];
  record(status: number, retryAfterMs?: number): void {
    if (status === 429 && retryAfterMs != null && retryAfterMs > 0) this.hints.push(retryAfterMs);
  }
  retryAfterMs(): number | undefined { return this.hints.length ? Math.min(...this.hints) : undefined; }
}

export function embeddingsRetryAfterSec(err: EmbeddingsError): number | undefined {
  return err.retryAfterMs !== undefined ? Math.ceil(err.retryAfterMs / 1000) : undefined;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return n * 1000;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, ms - Date.now()) : undefined;
}

async function upstreamEmbeddingsError(r: Response): Promise<EmbeddingsError> {
  const retryAfterMs = parseRetryAfterMs(r.headers?.get("retry-after") ?? null);
  return new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status, undefined, retryAfterMs);
}

function validateDimensions(data: { embedding: number[] }[], requestedDim: number | undefined, expectedDim: number): void {
  const dim = requestedDim ?? expectedDim;
  if (data.some((d) => !Array.isArray(d.embedding) || d.embedding.length !== dim || d.embedding.some((v) => typeof v !== "number" || !Number.isFinite(v)))) {
    throw new EmbeddingsError(`upstream returned mismatched dimensions (expected ${dim})`, 502);
  }
}

interface ProviderCredential { id: number; key: string; baseUrl: string | null; release: () => void; }

const FETCH_TIMEOUT_MS = 30000;

async function callProvider(row: EmbeddingModelRow, credential: ProviderCredential, inputs: string[], dimensions?: number): Promise<ProviderCallResult> {
  const { key: apiKey, baseUrl } = credential;
  switch (row.platform) {
    case "custom": {
      if (!baseUrl) throw new EmbeddingsError("custom embedding provider is missing base_url", 500);
      return await openAiStyleEmbed(`${baseUrl.replace(/\/+$/, "")}/embeddings`, apiKey, row.model_id, inputs, dimensions);
    }
    case "google": {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/embeddings", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ model: row.model_id, input: inputs, ...(dimensions !== undefined ? { dimensions } : {}) }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw await upstreamEmbeddingsError(r);
      const j = (await r.json()) as { data?: { embedding: number[] }[]; usage?: { prompt_tokens?: number } };
      const data = [...(j.data ?? [])];
      validateDimensions(data, dimensions, row.dimensions);
      return { vectors: data.map((d) => d.embedding), inputTokens: j.usage?.prompt_tokens ?? null };
    }
    case "cohere": {
      const r = await fetch("https://api.cohere.com/v2/embed", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: row.model_id, texts: inputs, input_type: "search_document", embedding_types: ["float"] }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw await upstreamEmbeddingsError(r);
      const j = (await r.json()) as { embeddings?: { float?: number[][] }; meta?: { billed_units?: { input_tokens?: number } } };
      return { vectors: j.embeddings?.float ?? [], inputTokens: j.meta?.billed_units?.input_tokens ?? null };
    }
    case "huggingface": {
      const r = await fetch(`https://router.huggingface.co/hf-inference/models/${row.model_id}/pipeline/feature-extraction`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ inputs }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw await upstreamEmbeddingsError(r);
      const j = (await r.json()) as number[][] | number[];
      return { vectors: Array.isArray(j[0]) ? j as number[][] : [j as number[]], inputTokens: null };
    }
    case "openai":
    case "azure":
    case "nvidia":
    case "openrouter":
    case "sealion":
    case "voyage": {
      const base = baseUrl ?? "https://api.openai.com/v1";
      return await openAiStyleEmbed(`${base.replace(/\/+$/, "")}/embeddings`, apiKey, row.model_id, inputs, dimensions);
    }
    case "cloudflare": {
      const sep = apiKey.indexOf(":");
      if (sep === -1) throw new EmbeddingsError("cloudflare key is not in account_id:token form", 500);
      return await openAiStyleEmbed(`https://api.cloudflare.com/client/v4/accounts/${apiKey.slice(0, sep)}/ai/v1/embeddings`, apiKey.slice(sep + 1), row.model_id, inputs, dimensions);
    }
    default: throw new EmbeddingsError(`no embeddings adapter for platform '${row.platform}'`, 500);
  }
}

async function openAiStyleEmbed(url: string, apiKey: string, modelId: string, inputs: string[], dimensions?: number): Promise<ProviderCallResult> {
  const body: Record<string, unknown> = { model: modelId, input: inputs };
  if (dimensions !== undefined) body.dimensions = dimensions;
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw await upstreamEmbeddingsError(r);
  const j = (await r.json()) as { data?: { index?: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
  const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  validateDimensions(data, dimensions, 0);
  return { vectors: data.map((d) => d.embedding), inputTokens: j.usage?.prompt_tokens ?? null };
}

// ── Logging ──────────────────────────────────────────────────────────────────

interface EmbeddingLogEntry {
  id: string; platform: string; model: string; keyId: number | null;
  status: "success" | "error"; latencyMs: number; inputTokens: number; error: string | null; timestamp: number;
}

const RECENT_EMBEDDING_LOGS: EmbeddingLogEntry[] = [];
const MAX_EMBEDDING_LOGS = 1000;

function logEmbeddingRequest(row: EmbeddingModelRow, keyId: number | null, status: "success" | "error", inputTokens: number, latencyMs: number, error: string | null, requestId: string): void {
  RECENT_EMBEDDING_LOGS.push({ id: requestId, platform: row.platform, model: row.model_id, keyId, status, latencyMs, inputTokens, error, timestamp: Date.now() });
  if (RECENT_EMBEDDING_LOGS.length > MAX_EMBEDDING_LOGS) RECENT_EMBEDDING_LOGS.shift();
}

export function getEmbeddingLogs(limit = 100): EmbeddingLogEntry[] {
  return RECENT_EMBEDDING_LOGS.slice(-limit).reverse();
}

// ── Core: runEmbeddings with family-based failover ────────────────────────────

export async function runEmbeddings(model: string | undefined, inputs: string[], dimensions?: number): Promise<EmbeddingsResult> {
  const family = await resolveFamily(model);
  if (!family) throw new EmbeddingsError(`Unknown embedding model '${model}'. Use 'auto', a family name, or a provider model id.`, 400);

  let chain: EmbeddingModelRow[] = [];
  try {
    await initDb();
    chain = (await query`SELECT * FROM embedding_models WHERE family = ${family} AND enabled = 1 ORDER BY priority`) as EmbeddingModelRow[];
  } catch { chain = listEmbeddingModelsSync().filter((r) => r.family === family); }

  if (chain.length === 0) throw new EmbeddingsError(`No enabled providers for embedding family '${family}'.`, 503);

  const requestId = getRequestGroupId({} as Request);
  let lastError: EmbeddingsError | null = null;
  const hints = new RetryHintTracker();

  for (const row of chain) {
    const key = await getPlatformKey(row, estimateTokens(inputs));
    if (!key) continue;
    const started = Date.now();
    try {
      const out = await callProvider(row, key, inputs, dimensions);
      if (out.vectors.length !== inputs.length || out.vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
        throw new EmbeddingsError("upstream returned malformed embeddings", 502);
      }
      const tokens = out.inputTokens ?? estimateTokens(inputs);
      traceRouteEvent("Proxy", { event: "ok", requestId, attempt: 1, platform: row.platform, model: row.model_id, latencyMs: Date.now() - started, inputTokens: tokens });
      logEmbeddingRequest(row, key.id, "success", tokens, Date.now() - started, null, requestId);
      key.release(); // release the monthly-budget reservation on success
      return { family, platform: row.platform, modelId: row.model_id, dimensions: out.vectors[0].length, vectors: out.vectors, inputTokens: tokens };
    } catch (err: unknown) {
      key.release(); // release on failure so the budget isn't held hostage by a dying upstream
      const e = err instanceof EmbeddingsError ? err : new EmbeddingsError(String((err as Error)?.message ?? err), 502);
      traceRouteEvent("Proxy", { event: "fail", requestId, attempt: 1, platform: row.platform, model: row.model_id, latencyMs: Date.now() - started, error: e.message });
      logEmbeddingRequest(row, key.id, "error", 0, Date.now() - started, e.message.slice(0, 300), requestId);
      lastError = e;
      hints.record(e.status, e.retryAfterMs);
    }
  }

  const retryAfterSec = lastError?.status === 429 ? embeddingsRetryAfterSec(lastError) : undefined;
  const errMsg = `All providers for embedding family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : " (no usable keys)"}`;
  throw new EmbeddingsError(errMsg, lastError?.status === 429 ? 429 : 502, lastError?.code, retryAfterSec ? retryAfterSec * 1000 : undefined);
}

// ── Budget-aware key resolution ──────────────────────────────────────────────

/**
 * Resolve a credential for `row` through `reserveProviderCredential`, which
 * selects a healthy/unknown api_keys row for the platform (or a bound key_id),
 * decrypts it via Web Crypto, and reserves monthly-budget tokens so the
 * embeddings router can't over-spend a key's cap.
 */
async function getPlatformKey(row: EmbeddingModelRow, estimatedTokens: number): Promise<ProviderCredential | null> {
  const { credential } = await reserveProviderCredential(
    { platform: row.platform, key_id: row.key_id ?? null },
    estimatedTokens,
  );
  if (!credential) return null;
  return { id: credential.id, key: credential.key, baseUrl: credential.baseUrl, release: credential.release };
}
