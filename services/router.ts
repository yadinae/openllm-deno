/**
 * SmartRouter — Bandit Scoring + Fallback Chain for intelligent provider selection.
 * Phase A Week 2: Core routing engine.
 */

import type {
  ProviderAdapter,
  ProviderConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderResult,
  ApiKey,
  FallbackEntry,
  RoutingContext,
  RoutingDecision,
  ModelInfo,
} from "../providers/types.ts";
import { providerRegistry, getAdapterForPlatform } from "../providers/index.ts";
import { query, initDb } from "../db/pg.ts";

/** Cached metrics for scoring (refreshed periodically) */
interface CachedMetrics {
  latency_p50: number;        // ms
  cost_per_1k: number;        // USD
  quality_score: number;      // 0-1 (from intelligence_rank)
  success_rate: number;       // 0-1
  last_updated: number;
}

const PROVIDER_MODEL_CACHE = new Map<string, { at: number; models: ModelInfo[] }>();
const PROVIDER_MODEL_TTL_MS = 10 * 60 * 1000; // upstream /models lists change rarely

/** `auto` free-first bias, applied in calculateScore. Must exceed the score
 * spread between two healthy candidates so freeness decides. */
const FREE_PREFERENCE = 0.25;

const METRICS_CACHE = new Map<string, CachedMetrics>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Default fallback metrics when no history available */
const DEFAULT_METRICS: CachedMetrics = {
  latency_p50: 2000,
  cost_per_1k: 0.001,
  quality_score: 0.5,
  success_rate: 0.95,
  last_updated: 0,
};

/**
 * SmartRouter — selects optimal provider/model/key using Bandit Scoring
 * and builds a fallback chain for automatic retry on failure.
 */
export class SmartRouter {
  private metricsCache = METRICS_CACHE;

  /**
   * Main routing entry point.
   * Collects all valid (provider, model, key) combinations,
   * scores them, and returns primary + fallback chain.
   */
  async route(ctx: RoutingContext): Promise<RoutingDecision> {
    // 1. Collect all valid candidates
    const candidates = await this.collectCandidates(ctx);
    if (candidates.length === 0) {
      throw new Error("No available providers for request");
    }

    // 2. Score each candidate using Bandit algorithm
    const scored = await Promise.all(
      candidates.map(async (c) => ({
        ...c,
        score: await this.calculateScore(c, ctx),
      }))
    );

    // 3. Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // 4. Primary = top score, Fallback Chain = next 2-3
    const primary = scored[0];
    // Dedupe by key: the top-scored candidates are often many MODELS of one
    // dead key — a chain of them burns every retry on the same broken credential.
    const chainCandidates: ScoredCandidate[] = [];
    const usedKeys = new Set<string>([primary.key.id]);
    for (const c of scored.slice(1)) {
      if (usedKeys.has(c.key.id)) continue;
      usedKeys.add(c.key.id);
      chainCandidates.push(c);
      if (chainCandidates.length >= 6) break;
    }
      const fallbackChain = chainCandidates.map(this.toFallbackEntry);
    console.log(`[router] candidates=${candidates.length} scored=${scored.length} keys=${new Set(scored.map((s2) => s2.key.id)).size} chain=${fallbackChain.length}`);

    return {
      provider: primary.provider,
      model: primary.model,
      key: primary.key,
      fallback_chain: fallbackChain,
      metadata: {
        score: primary.score,
        reason: `bandit-top1 ${primary.free ? "FREE" : "paid"} (latency:${primary.metrics.latency_p50}ms cost:$${primary.metrics.cost_per_1k}/1k quality:${primary.metrics.quality_score} reliability:${primary.metrics.success_rate})`,
      },
    };
  }

  /**
   * Collect all (provider, model, key) combinations that can serve the request.
   * Filters by model support, key status, cooldown, and client profile scope.
   */
  private async collectCandidates(ctx: RoutingContext): Promise<Candidate[]> {
    const candidates: Candidate[] = [];

    // Get all enabled keys from database
    let dbKeys: ApiKey[] = [];
    try {
      await initDb();
      const keys = await query`
        SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url,
               monthly_request_cap, monthly_token_cap
        FROM api_keys
        WHERE enabled = true AND status = 'healthy'
      `;
      dbKeys = (await Promise.all(keys.map(async (k: any) => ({
        id: String(k.id),
        db_id: Number(k.id),
        platform: k.platform,
        label: k.label,
        // Adapters send `key.encrypted_key` as the Bearer token, so it must
        // hold the DECRYPTED secret by the time it reaches provider.chat().
        encrypted_key: await decryptSecret(k),
        iv: "",
        auth_tag: "",
        status: k.status,
        enabled: k.enabled,
        base_url: k.base_url,
        monthly_request_cap: k.monthly_request_cap ?? 0,
        monthly_token_cap: k.monthly_token_cap ?? 0,
      })))).filter((k) => k.encrypted_key);
      if (dbKeys.length === 0 && keys.length > 0) {
        console.warn(`[router] ${keys.length} keys loaded but all dropped by decryption filter`);
      } else if (dbKeys.length < keys.length) {
        const dropped = keys.map((k: any) => String(k.platform)).filter((pl: string) => !dbKeys.some((d) => d.platform === pl));
        console.warn(`[router] decrypt filter: ${dbKeys.length}/${keys.length} keys ok; dropped: ${dropped.join(",")}`);
      }
    } catch (e) {
      console.error("[router] Failed to load keys from DB:", e);
      return candidates;
    }

    // Apply client profile filters
    const allowedModels = ctx.client_profile?.model_scope;
    const preferredProvider = ctx.preferred_provider;
    const excludedProviders = new Set(ctx.excluded_providers ?? []);

    // Virtual model names never match a concrete catalog id.
    const virtualModel = ctx.request.model === "auto" || ctx.request.model === "fusion";

    // For each key, get provider adapter and supported models
    for (const key of dbKeys) {
      if (excludedProviders.has(key.platform)) continue;

      const adapter = providerRegistry.get(key.platform);
      if (!adapter) continue;

      // Check cooldown
      if (await this.isInCooldown(key.platform, key.id)) continue;

      // Filter by preferred provider (if specified, only include that provider)
      if (preferredProvider && key.platform !== preferredProvider) continue;

      // Candidates come from the curated catalog — ranked, chat-capable, with
      // freeness resolved — never from the raw upstream /models order, which is
      // arbitrary and let a TTS model become the routed primary.
      let models: RoutableModel[] = [];
      if (virtualModel) {
        models = await loadRoutableModels(key.platform);
      } else {
        const requested = ctx.request.model ?? "";
        const known = await resolveRequestedModel(key.platform, requested);
        if (known) {
          models = [known];
        } else if (await this.providerServesModel(key.platform, requested)) {
          // The provider lists it but the catalog has no row yet: still servable,
          // just with unknown price.
          models = [{ id: requested.replace(`${key.platform}/`, ""), free: false }];
        }
      }

      for (const model of models) {
        // Filter by client profile model scope
        if (allowedModels && !allowedModels.includes(model.id)) continue;

        // Check if model matches request (for model-specific routing)
        if (!virtualModel && ctx.request.model && !this.modelMatches(ctx.request.model, model.id, key.platform)) {
          continue;
        }

        candidates.push({
          provider: adapter,
          model: model.id,
          key,
          platform: key.platform,
          free: model.free,
          metrics: await this.getMetrics(key.platform, model.id),
        });
      }
    }

    return candidates;
  }

  /**
   * Bandit Scoring Algorithm:
   * score = 0.3 * (1 - normalized_latency) + 0.2 * (1 - normalized_cost) + 0.3 * quality + 0.2 * reliability
   * All components normalized to 0-1 range where 1 is best.
   */
  private async calculateScore(candidate: Candidate, ctx: RoutingContext): Promise<number> {
    const m = candidate.metrics;
    const weights = {
      latency: 0.30,
      cost: 0.20,
      quality: 0.30,
      reliability: 0.20,
    };
    const virtualTRGL = ctx.request.model === "auto" || ctx.request.model === "fusion";

    // Normalize latency (lower is better): assume 0-10000ms range
    const latencyScore = Math.max(0, 1 - m.latency_p50 / 10000);

    // Normalize cost (lower is better): assume $0-10/1k range. A positively
    // known-free model costs 0 — previously cost_per_1k was a constant 0.001,
    // so this term could never distinguish free from paid.
    const costPer1k = candidate.free ? 0 : m.cost_per_1k;
    const costScore = Math.max(0, 1 - costPer1k / 10);

    // Quality from model intelligence_rank (0-1, higher is better)
    const qualityScore = m.quality_score;

    // Reliability = success rate (0-1, higher is better)
    const reliabilityScore = m.success_rate;

    // Apply client profile strategy bias if specified
    let strategyBias = 0;
    if (ctx.client_profile?.priority_strategy === "speed") {
      strategyBias = 0.1 * latencyScore; // Boost speed
    } else if (ctx.client_profile?.priority_strategy === "cost") {
      strategyBias = 0.1 * costScore; // Boost cost efficiency
    } else if (ctx.client_profile?.priority_strategy === "quality") {
      strategyBias = 0.1 * qualityScore; // Boost quality
    }

    // `auto` means "spend nothing when something free works". The bonus is
    // larger than the spread latency/quality jitter can produce, so a free
    // model outranks a paid one — but paid candidates stay in the chain as a
    // last resort instead of dead-ending when every free model is down.
    const freePreference = virtualTRGL && candidate.free ? FREE_PREFERENCE : 0;

    return (
      weights.latency * latencyScore +
      weights.cost * costScore +
      weights.quality * qualityScore +
      weights.reliability * reliabilityScore +
      strategyBias +
      freePreference
    );
  }

  /** Get cached or computed metrics for a provider/model */
  private async getMetrics(platform: string, modelId: string): Promise<CachedMetrics> {
    const cacheKey = `${platform}/${modelId}`;
    const cached = this.metricsCache.get(cacheKey);

    if (cached && Date.now() - cached.last_updated < CACHE_TTL_MS) {
      return cached;
    }

    // Compute from database
    const metrics = await this.computeMetrics(platform, modelId);
    this.metricsCache.set(cacheKey, metrics);
    return metrics;
  }

  /** Compute metrics from historical request data */
  private async computeMetrics(platform: string, modelId: string): Promise<CachedMetrics> {
    try {
      await initDb();

      // Get recent requests (last 24 hours). timestamp is a TEXT column
      // holding ISO-8601 UTC strings, so lexicographic comparison works.
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = await query`
        SELECT latency_ms, status_code as sc, input_tokens, output_tokens
        FROM requests
        WHERE platform = ${platform} AND model = ${modelId}
          AND timestamp >= ${sinceIso}
        ORDER BY timestamp DESC
        LIMIT 1000
      `;

      if (rows.length === 0) {
        // No history - use model config defaults
        return this.getDefaultMetrics(platform, modelId);
      }

      // Calculate latency p50
      const latencies = rows
        .map((r: any) => r.latency_ms)
        .filter((l: number) => l > 0)
        .sort((a: number, b: number) => a - b);
      const latency_p50 = latencies.length > 0
        ? latencies[Math.floor(latencies.length * 0.5)]
        : 2000;

      // Calculate success rate
      const successCount = rows.filter((r: any) => Number(r.sc) > 0 && Number(r.sc) < 400).length;
      const success_rate = successCount / rows.length;

      // Get cost from model config
      const modelRows = await query`
        SELECT rpm_limit, tpm_limit, intelligence_rank, context_window
        FROM models
        WHERE platform = ${platform} AND model_id = ${modelId}
      `;
      const modelConfig = modelRows[0] ?? {};

      // Quality from intelligence_rank (normalize 1-100 to 0-1)
      const quality_score = modelConfig.intelligence_rank
        ? Math.min(1, modelConfig.intelligence_rank / 100)
        : 0.5;

      // Estimate cost from pricing (would need provider pricing table)
      const cost_per_1k = 0.001; // Default, will be improved with pricing table

      return {
        latency_p50,
        cost_per_1k,
        quality_score,
        success_rate,
        last_updated: Date.now(),
      };
    } catch (e) {
      console.error("[router] Failed to compute metrics:", e);
      return DEFAULT_METRICS;
    }
  }

  /** Get default metrics from model configuration */
  private async getDefaultMetrics(platform: string, modelId: string): Promise<CachedMetrics> {
    try {
      await initDb();
      const rows = await query`
        SELECT rpm_limit, tpm_limit, intelligence_rank, context_window
        FROM models
        WHERE platform = ${platform} AND model_id = ${modelId}
      `;
      const config = rows[0] ?? {};

      // Estimate latency from speed_rank (lower rank = faster)
      const speed_rank = config.speed_rank ?? 50;
      const latency_p50 = Math.max(500, speed_rank * 50); // Rough estimate

      const quality_score = config.intelligence_rank
        ? Math.min(1, config.intelligence_rank / 100)
        : 0.5;

      return {
        latency_p50,
        cost_per_1k: 0.001,
        quality_score,
        success_rate: 0.95,
        last_updated: Date.now(),
      };
    } catch {
      return DEFAULT_METRICS;
    }
  }

  /** Get models supported by a provider (from catalog + discovered) */
  private async getProviderModels(adapter: ProviderAdapter, platform: string): Promise<ModelInfo[]> {
    // Cache per platform: collectCandidates runs on EVERY routed request and
    // adapter.models() is a live upstream HTTP call. Without this the router
    // fans out one /models fetch per enabled key per chat completion.
    const cached = PROVIDER_MODEL_CACHE.get(platform);
    if (cached && Date.now() - cached.at < PROVIDER_MODEL_TTL_MS) return cached.models;

    let result: ModelInfo[] = [];

    // Try to get from provider's models() method
    try {
      const models = await adapter.models();
      if (models.length > 0) result = models;
    } catch {
      // Fall through to database
    }

    // Fallback: curated/discovered catalog in the database
    if (result.length === 0) {
      try {
        await initDb();
        // Curated catalog first (ranked, no live call needed), then anything
        // runtime discovery added on top.
        const curatedRows = await query`
          SELECT model_id as mid FROM models
          WHERE platform = ${platform} AND enabled = 1
          ORDER BY intelligence_rank DESC NULLS LAST
          LIMIT 30
        `;
        const discRows = await query`
          SELECT model_id as mid FROM discovered_models
          WHERE platform = ${platform} AND enabled = true
        `;
        const seen = new Set<string>();
        const rows = [...curatedRows, ...discRows].filter((r: any) => {
          if (!r.mid || seen.has(r.mid)) return false;
          seen.add(r.mid);
          return true;
        });
        result = rows.map((r: any) => ({
          id: r.mid,
          display_name: r.mid,
          family: platform,
          capabilities: { chat: true, streaming: true, tools: true, vision: false, reasoning: false },
          pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD" as const, updated_at: new Date().toISOString() },
          context_window: 128000,
          is_free: false,
          price_note: undefined,
        }));
      } catch {
        result = [];
      }
    }

    if (result.length === 0) console.warn(`[router] getProviderModels(${platform}): EMPTY (live_models_failed_or_empty, catalog+discovered gave 0)`);
    if (result.length > 0) PROVIDER_MODEL_CACHE.set(platform, { at: Date.now(), models: result });
    return result;
  }

  /** Check if provider/model/key is in cooldown */
  private async isInCooldown(platform: string, keyId: string): Promise<boolean> {
    try {
      await initDb();
      const rows = await query`
        SELECT expires_at_ms
        FROM rate_limit_cooldowns
        WHERE platform = ${platform} AND key_id = ${keyId}
      `;
      if (rows.length === 0) return false;
      return rows[0].expires_at_ms > Date.now();
    } catch {
      return false;
    }
  }

  /** True when the provider's own model list contains the requested model. */
  private async providerServesModel(platform: string, requestModel: string): Promise<boolean> {
    if (!requestModel) return false;
    const adapter = getAdapterForPlatform(platform);
    if (!adapter) return false;
    const models = await this.getProviderModels(adapter, platform);
    const bare = requestModel.replace(`${platform}/`, "");
    return models.some((m) => m.id === bare || m.id === requestModel);
  }

  /** Check if request model matches candidate model */
  private modelMatches(requestModel: string, candidateModel: string, platform: string): boolean {
    // requestModel format: "platform/model-id" or just "model-id"
    const [reqPlatform, reqModel] = requestModel.includes("/")
      ? requestModel.split("/", 2)
      : ["", requestModel];

    if (reqPlatform && reqPlatform !== platform) return false;
    return reqModel === candidateModel || reqModel === `${platform}/${candidateModel}`;
  }

  /** Convert scored candidate to fallback entry */
  private toFallbackEntry(c: ScoredCandidate, index: number): FallbackEntry {
    return {
      provider: c.platform,
      model: c.model,
      key_id: c.key.id,
      priority: index + 1,
      metadata: {
        score: c.score,
        latency_p50: c.metrics.latency_p50,
        cost_per_1k: c.metrics.cost_per_1k,
      },
    };
  }

  /** Clear metrics cache (call after significant traffic changes) */
  clearCache(): void {
    this.metricsCache.clear();
  }
}

/** Internal candidate type with metadata */
interface Candidate {
  provider: ProviderAdapter;
  model: string;
  key: ApiKey;
  platform: string;
  /** Positively-known-free (see RoutableModel). */
  free: boolean;
  metrics: CachedMetrics;
}

interface ScoredCandidate extends Candidate {
  score: number;
}

/** Global router instance */
export const smartRouter = new SmartRouter();

/**
 * Execute chat with automatic fallback chain retry.
 * Tries primary, then each fallback in order until success or exhausted.
 */
export async function executeWithFallback(
  request: ChatCompletionRequest,
  ctx: RoutingContext
): Promise<ProviderResult> {
  const decision = await smartRouter.route(ctx);
  const tried = new Set<string>();

  // Try primary — the router chose decision.model, so the caller's virtual
  // model name ("auto") must not leak to the provider.
  const primaryKey = `${decision.provider.id}/${decision.model}/${decision.key.id}`;
  tried.add(primaryKey);
  console.log(`[router] primary: ${decision.provider.id}/${decision.model} key=${decision.key.label}`);
  const primaryResult = await decision.provider.chat({ ...request, model: decision.model }, decision.key);
  if (primaryResult.error) await markKeyUnhealthy(decision.key, primaryResult);
  if (primaryResult.error) console.warn(`[router] primary failed: ${String(primaryResult.error).slice(0, 200)}`);
  if (!primaryResult.error) {
    if (primaryResult.response) {
      (primaryResult.response as unknown as Record<string, unknown>)._routed_via = {
        platform: decision.provider.id,
        model: decision.model,
        score: decision.metadata.score,
        reason: decision.metadata.reason,
      };
    }
    return primaryResult;
  }

  // Try fallback chain
  for (const fallback of decision.fallback_chain) {
    const fallbackKey = `${fallback.provider}/${fallback.model}/${fallback.key_id}`;
    if (tried.has(fallbackKey)) continue;
    tried.add(fallbackKey);

    const adapter = providerRegistry.get(fallback.provider);
    if (!adapter) continue;

    // Get the key for this fallback
    const fallbackKeyObj = await getKeyById(fallback.key_id);
    if (!fallbackKeyObj) continue;

    const fallbackRequest = { ...request, model: fallback.model };
    const result = await adapter.chat(fallbackRequest, fallbackKeyObj);
    if (result.error) {
      console.warn(`[router] fallback ${fallback.provider}/${fallback.model} failed: ${String(result.error).slice(0, 200)}`);
      await markKeyUnhealthy(fallbackKeyObj, result);
    }
    if (!result.error) {
      // Log fallback usage
      console.log(`[router] Fallback used: ${fallback.provider}/${fallback.model} (primary failed: ${primaryResult.error})`);
      if (result.response) {
        (result.response as unknown as Record<string, unknown>)._routed_via = {
          platform: fallback.provider,
          model: fallback.model,
          fallback: true,
          primary_error: primaryString(primaryResult.error),
        };
      }
      return result;
    }
  }

  // All failed. Surface the last meaningful upstream error with context so the
  // caller can show the operator WHY the request died instead of a generic
  // "routing failed" / "unknown error". The primary's error is the most
  // specific one we have (it is what made us fall back in the first place).
  const lastError = primaryString(primaryResult.error);
  const failedResult: ProviderResult = {
    error: lastError || "No available channel for this request",
    status: primaryResult.status ?? 502,
    latency_ms: primaryResult.latency_ms,
    provider_metadata: {
      ...primaryResult.provider_metadata,
      exhausted_chain: true,
      attempts: [...tried],
    },
  };
  return failedResult;
}

function primaryString(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

/** Get API key by database ID */
async function getKeyById(keyId: string): Promise<ApiKey | null> {
  try {
    await initDb();
    const rows = await query`
      SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url,
             monthly_request_cap, monthly_token_cap
      FROM api_keys
      WHERE id = ${parseInt(keyId)}
    `;
    if (rows.length === 0) return null;
    const k = rows[0];
    return {
      id: String(k.id),
      db_id: Number(k.id),
      platform: k.platform,
      label: k.label,
      encrypted_key: await decryptSecret(k),
      iv: "",
      auth_tag: "",
      status: k.status,
      enabled: k.enabled,
      base_url: k.base_url,
      monthly_request_cap: k.monthly_request_cap ?? 0,
      monthly_token_cap: k.monthly_token_cap ?? 0,
    };
  } catch {
    return null;
  }
}

const NON_CHAT_MODEL_RE = /guard|moderation|embed|whisper|\/tts|audio|transcri|dall-e|image|draw|rerank|ocr|realtime|vision-|live\b|orpheus|speech|voice/i;

/** A catalogued model the router is allowed to pick, plus what we know of price. */
export interface RoutableModel {
  id: string;
  /** True only when freeness is POSITIVELY known (catalog says free, discovery
   * stamped is_free, or the runtime pricing detector confirmed it). Unknown
   * pricing is deliberately NOT treated as free. */
  free: boolean;
}

const ROUTABLE_CACHE = new Map<string, { at: number; models: RoutableModel[] }>();
const ROUTABLE_TTL_MS = 10 * 60 * 1000;
/** Ranked cap per platform. Ranked, not head-of-list: an upstream /models
 * array is in arbitrary order, so a plain slice() let whatever happened to be
 * first (e.g. groq's Arabic TTS model) become the routed primary. */
const ROUTABLE_CAP_PER_PLATFORM = 25;

/**
 * Models this platform may serve, best-first, with freeness resolved.
 * The curated `models` table is the allowlist (operator-approved, chat-capable,
 * quality-ranked); discovery only contributes models it positively knows are free.
 */
export async function loadRoutableModels(platform: string): Promise<RoutableModel[]> {
  const cached = ROUTABLE_CACHE.get(platform);
  if (cached && Date.now() - cached.at < ROUTABLE_TTL_MS) return cached.models;

  const out = new Map<string, RoutableModel>();
  try {
    await initDb();
    const curated = await query`
      SELECT model_id AS mid,
             (paid_input_per_m IS NOT NULL AND paid_input_per_m > 0) AS paid
        FROM models
       WHERE platform = ${platform} AND enabled = 1
       ORDER BY (paid_input_per_m IS NULL OR paid_input_per_m = 0) DESC NULLS LAST,
                intelligence_rank DESC NULLS LAST
       LIMIT ${ROUTABLE_CAP_PER_PLATFORM * 3}
    `;
    for (const r of curated as any[]) {
      if (r.mid) out.set(r.mid, { id: r.mid, free: !r.paid });
    }
    const disc = await query`
      SELECT model_id AS mid FROM discovered_models
       WHERE platform = ${platform} AND enabled = true AND is_free = true
    `;
    for (const r of disc as any[]) {
      if (!r.mid) continue;
      const prev = out.get(r.mid);
      if (prev) prev.free = true;
      else out.set(r.mid, { id: r.mid, free: true });
    }
  } catch (e) {
    console.warn(`[router] loadRoutableModels(${platform}) catalog failed:`, e instanceof Error ? e.message : e);
  }

  // Runtime pricing detector, best-effort: confirms free models the catalog
  // lists without a price stamp.
  try {
    const { getFreeModelsCached } = await import("../providers/free-detect-service.ts");
    for (const id of await getFreeModelsCached(platform)) {
      const prev = out.get(id);
      if (prev) prev.free = true;
      else out.set(id, { id, free: true });
    }
  } catch { /* optional enhancement */ }

  const models = [...out.values()]
    .filter((m) => !NON_CHAT_MODEL_RE.test(m.id) && !CLIENT_LOCKED_MODEL_RE.test(m.id))
    .slice(0, ROUTABLE_CAP_PER_PLATFORM);
  if (models.length > 0) ROUTABLE_CACHE.set(platform, { at: Date.now(), models });
  return models;
}

/** Resolve an explicitly requested model against the catalog for this platform. */
async function resolveRequestedModel(platform: string, requestModel: string): Promise<RoutableModel | null> {
  const routable = await loadRoutableModels(platform);
  const hit = routable.find((m) => {
    const bare = m.id;
    return requestModel === bare || requestModel === `${platform}/${bare}`
      || requestModel.split("/").slice(1).join("/") === bare;
  });
  if (hit) return hit;
  try {
    await initDb();
    const rows = await query`
      SELECT model_id AS mid,
             (paid_input_per_m IS NOT NULL AND paid_input_per_m > 0) AS paid
        FROM models
       WHERE platform = ${platform} AND model_id = ${requestModel.replace(`${platform}/`, "")}
       LIMIT 1
    `;
    if (rows.length > 0) return { id: (rows[0] as any).mid, free: !(rows[0] as any).paid };
  } catch { /* catalog unavailable */ }
  return null;
}

/** OpenCode zen "-free" models are client-locked to the OpenCode IDE
 * (FreeTierError from any API caller) — never viable as routing targets. */
const CLIENT_LOCKED_MODEL_RE = /-free$/i;

/** Flip an api key to status=error when upstream rejects its credentials,
 * mirroring FreeLLMAPI health probe semantics. collectCandidates filters on
 * status=healthy, so a dead key stops shadowing live ones after one try.
 * Only 401 / 403 authorization errors qualify; rate limits and 5xx stay on
 * the cooldown + fallback path. */
export async function markKeyUnhealthy(key: ApiKey, result: ProviderResult): Promise<void> {
  try {
    const st = Number(result.status ?? 0);
    const msg = typeof result.error === "string" ? result.error : "";
    const authFailure = st === 401 || (st === 403 && (msg.indexOf("oriz") >= 0 || msg.indexOf("Forbidden") >= 0));
    if (!authFailure || !key.db_id) return;
    await query`UPDATE api_keys SET status = 'error', updated_at = now() WHERE id = ${key.db_id} AND status = 'healthy'`;
    console.warn(`[router] marked key ${key.platform}/${key.label} unhealthy (${st}): ${msg.slice(0, 120)}`);
  } catch { /* best-effort */ }
}

/** AES-GCM-decrypt a DB key row into the plaintext secret the adapters use as
 * their Bearer token. Returns "" when the row is un-decryptable (callers must
 * treat "" as unusable). */
export async function decryptSecret(k: {
  encrypted_key?: string | null;
  iv?: string | null;
  auth_tag?: string | null;
}): Promise<string> {
  if (!k.encrypted_key) return "";
  if (!k.iv || !k.auth_tag) return k.encrypted_key; // already-plaintext rows pass through
  try {
    const { decryptKey } = await import("../db/mod.ts");
    return (await decryptKey(k.encrypted_key, k.iv, k.auth_tag)) || "";
  } catch {
    return "";
  }
}