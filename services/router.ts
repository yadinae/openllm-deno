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
    const fallbackChain = scored.slice(1, 4).map(this.toFallbackEntry);

    return {
      provider: primary.provider,
      model: primary.model,
      key: primary.key,
      fallback_chain: fallbackChain,
      metadata: {
        score: primary.score,
        reason: `bandit-top1 (latency:${primary.metrics.latency_p50}ms cost:$${primary.metrics.cost_per_1k}/1k quality:${primary.metrics.quality_score} reliability:${primary.metrics.success_rate})`,
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
      dbKeys = keys.map((k: any) => ({
        id: String(k.id),
        db_id: Number(k.id),
        platform: k.platform,
        label: k.label,
        encrypted_key: k.encrypted_key,
        iv: k.iv,
        auth_tag: k.auth_tag,
        status: k.status,
        enabled: k.enabled,
        base_url: k.base_url,
        monthly_request_cap: k.monthly_request_cap ?? 0,
        monthly_token_cap: k.monthly_token_cap ?? 0,
      }));
    } catch (e) {
      console.error("[router] Failed to load keys from DB:", e);
      return candidates;
    }

    // Apply client profile filters
    const allowedModels = ctx.client_profile?.model_scope;
    const preferredProvider = ctx.preferred_provider;
    const excludedProviders = new Set(ctx.excluded_providers ?? []);

    // For each key, get provider adapter and supported models
    for (const key of dbKeys) {
      if (excludedProviders.has(key.platform)) continue;

      const adapter = providerRegistry.get(key.platform);
      if (!adapter) continue;

      // Check cooldown
      if (await this.isInCooldown(key.platform, key.id)) continue;

      // Get models this provider supports
      const models = await this.getProviderModels(adapter, key.platform);
      
      for (const model of models) {
        // Filter by client profile model scope
        if (allowedModels && !allowedModels.includes(model.id)) continue;

        // Filter by preferred provider (if specified, only include that provider)
        if (preferredProvider && key.platform !== preferredProvider) continue;

        // Check if model matches request (for model-specific routing)
        if (ctx.request.model && !this.modelMatches(ctx.request.model, model.id, key.platform)) {
          continue;
        }

        candidates.push({
          provider: adapter,
          model: model.id,
          key,
          platform: key.platform,
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

    // Normalize latency (lower is better): assume 0-10000ms range
    const latencyScore = Math.max(0, 1 - m.latency_p50 / 10000);

    // Normalize cost (lower is better): assume $0-10/1k range
    const costScore = Math.max(0, 1 - m.cost_per_1k / 10);

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

    return (
      weights.latency * latencyScore +
      weights.cost * costScore +
      weights.quality * qualityScore +
      weights.reliability * reliabilityScore +
      strategyBias
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

      // Get recent requests (last 24 hours)
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const rows = await query`
        SELECT latency_ms, status, input_tokens, output_tokens
        FROM requests
        WHERE platform = ${platform} AND model_id = ${modelId}
          AND created_at_ms >= ${since}
        ORDER BY created_at_ms DESC
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
      const successCount = rows.filter((r: any) => r.status === "success").length;
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
    // Try to get from provider's models() method
    try {
      const models = await adapter.models();
      if (models.length > 0) return models;
    } catch {
      // Fall through to database
    }

    // Fallback: get from database
    try {
      await initDb();
      const rows = await query`
        SELECT id, platform, display_name, context_window, is_free, price_note
        FROM discovered_models
        WHERE platform = ${platform} AND enabled = true
      `;
      return rows.map((r: any) => ({
        id: r.model_id,
        display_name: r.display_name,
        family: platform,
        capabilities: { chat: true, streaming: true, tools: true, vision: false, reasoning: false },
        pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD" as const, updated_at: new Date().toISOString() },
        context_window: r.context_window ?? 128000,
        is_free: r.is_free ?? false,
        price_note: r.price_note,
      }));
    } catch {
      return [];
    }
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

  // Try primary
  const primaryKey = `${decision.provider.id}/${decision.model}/${decision.key.id}`;
  tried.add(primaryKey);
  const primaryResult = await decision.provider.chat(request, decision.key);
  if (!primaryResult.error) return primaryResult;

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
    if (!result.error) {
      // Log fallback usage
      console.log(`[router] Fallback used: ${fallback.provider}/${fallback.model} (primary failed: ${primaryResult.error})`);
      return result;
    }
  }

  // All failed - return primary error
  return primaryResult;
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
      encrypted_key: k.encrypted_key,
      iv: k.iv,
      auth_tag: k.auth_tag,
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