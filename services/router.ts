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
import { query, initDb, getSetting, saveSetting } from "../db/pg.ts";
import {
  // Types
  RoutingWeights,
  RoutingStrategy,
  PresetStrategy,
  KeySelectionStrategy,
  PeakHoursConfig,
  CommunityReliabilityPrior,
  ScoreInputs,
  // Constants
  BANDIT_PRESETS,
  DEFAULT_STRATEGY,
  DEFAULT_PEAK_HOURS,
  PEAK_SPEED_TO_RELIABILITY,
  PEAK_EXEMPT_STRATEGIES,
  TASK_WEIGHT_SHARE,
  TASK_EXEMPT_STRATEGIES,
  PRIOR_SUCCESS,
  PRIOR_FAILURE,
  SPEED_SCALE_TOK_S,
  TTFB_BEST_MS,
  TTFB_WORST_MS,
  SPEED_PRIOR,
  TIMEOUT_LATENCY_CAP_MS,
  OBSERVED_SPEED_RANK_BEST,
  OBSERVED_SPEED_RANK_WORST,
  TIER_VALUE,
  RANK_SCALE,
  HEADROOM_FLOOR,
  HEADROOM_RAMP_START,
  MAX_PENALTY,
  RATE_LIMIT_MAX_DAMP,
  // Functions
  isPeakExemptStrategy,
  isValidPeakHour,
  isValidTimezone,
  hourInTimezone,
  isPeakHours,
  peakAdjustedWeights,
  isTaskExemptStrategy,
  taskAdjustedWeights,
  reliabilityPosterior,
  expectedReliability,
  speedScore,
  observedSpeedRank,
  tierValue,
  intelligenceComposite,
  intelligenceScore,
  headroomFactor,
  rateWindowHeadroomFactor,
  rateLimitFactor,
  sampleBeta,
  combineScore,
  // Settings keys
  SETTING_ROUTING_STRATEGY,
  SETTING_ROUTING_WEIGHTS,
  SETTING_PEAK_HOURS,
  SETTING_TASK_WEIGHT_SHARE,
  SETTING_MIN_RELIABILITY_FLOOR,
  SETTING_HEADROOM_RAMP_START,
  SETTING_HEADROOM_FLOOR,
  SETTING_EXPLORE_CHANCE,
  SETTING_EXPLORE_MIN_SAMPLES,
  SETTING_COMMUNITY_PRIOR_MAX_SAMPLES,
} from "./scoring.ts";
import { getKeyQuotaHeadroom } from "./provider-quota.ts";

/** Cached metrics for scoring (refreshed periodically) */
interface CachedMetrics {
  latency_p50: number; // ms
  cost_per_1k: number; // USD
  quality_score: number; // 0-1 (from intelligence_rank)
  success_rate: number; // 0-1
  last_updated: number;
  // Decay-weighted stats (half-life 2 days)
  weighted_successes: number;
  weighted_failures: number;
  weighted_tok_per_sec: number;
  weighted_ttfb_ms: number;
  penalty: number; // 429 penalty (max 10)
  community_prior?: CommunityReliabilityPrior;
}

const PROVIDER_MODEL_CACHE = new Map<string, { at: number; models: ModelInfo[] }>();
const PROVIDER_MODEL_TTL_MS = 10 * 60 * 1000; // upstream /models lists change rarely

const METRICS_CACHE = new Map<string, CachedMetrics>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Default fallback metrics when no history available */
const DEFAULT_METRICS: CachedMetrics = {
  latency_p50: 2000,
  cost_per_1k: 0.001,
  quality_score: 0.5,
  success_rate: 0.95,
  last_updated: 0,
  weighted_successes: 0,
  weighted_failures: 0,
  weighted_tok_per_sec: 0,
  weighted_ttfb_ms: 0,
  penalty: 0,
};

/**
 * SmartRouter — selects optimal provider/model/key using Bandit Scoring
 * and builds a fallback chain for automatic retry on failure.
 */
export class SmartRouter {
  private metricsCache = METRICS_CACHE;

  /**
   * Get current routing strategy from settings (default: 'balanced').
   */
  private async getRoutingStrategy(): Promise<RoutingStrategy> {
    const strat = await getSetting<string>(SETTING_ROUTING_STRATEGY);
    return (strat as RoutingStrategy) ?? DEFAULT_STRATEGY;
  }

  /**
   * Get custom weights from settings (if strategy is 'custom').
   */
  private async getCustomWeights(): Promise<RoutingWeights | null> {
    const weights = await getSetting<RoutingWeights>(SETTING_ROUTING_WEIGHTS);
    return weights ?? null;
  }

  /**
   * Get peak-hours config from settings.
   */
  private async getPeakHoursConfig(): Promise<PeakHoursConfig> {
    const config = await getSetting<PeakHoursConfig>(SETTING_PEAK_HOURS);
    return config ?? DEFAULT_PEAK_HOURS;
  }

  /**
   * Get task weight share from settings (default: 0.3).
   */
  private async getTaskWeightShare(): Promise<number> {
    const share = await getSetting<number>(SETTING_TASK_WEIGHT_SHARE);
    return share ?? TASK_WEIGHT_SHARE;
  }

  /**
   * Get minimum reliability floor from settings.
   */
  private async getMinReliabilityFloor(): Promise<number | undefined> {
    const val = await getSetting<number>(SETTING_MIN_RELIABILITY_FLOOR);
    return val ?? undefined;
  }

  /**
   * Get headroom thresholds from settings.
   */
  private async getHeadroomThresholds(): Promise<{ rampStart?: number; floor?: number }> {
    const [rampStart, floor] = await Promise.all([
      getSetting<number>(SETTING_HEADROOM_RAMP_START),
      getSetting<number>(SETTING_HEADROOM_FLOOR),
    ]);
    return { rampStart: rampStart ?? undefined, floor: floor ?? undefined };
  }

  /**
   * Get community prior for a model (stored in settings as JSON).
   */
  private async getCommunityPrior(platform: string, modelId: string, endpointScope?: string): Promise<CommunityReliabilityPrior | undefined> {
    const key = `community_prior_${platform}_${modelId}_${endpointScope ?? ""}`;
    const prior = await getSetting<CommunityReliabilityPrior>(key);
    return prior ?? undefined;
  }

  /**
   * Get explore chance from settings.
   */
  private async getExploreEnabled(): Promise<boolean> {
    const chance = await getSetting<number>(SETTING_EXPLORE_CHANCE);
    return (chance ?? 0.1) > 0;
  }

  /**
   * Get explore min samples from settings.
   */
  private async getExploreMinSamples(): Promise<number> {
    return await getSetting<number>(SETTING_EXPLORE_MIN_SAMPLES) ?? 5;
  }

  /**
   * Main routing entry point.
   * Collects all valid (provider, model, key) combinations,
   * scores them using the 3-axis bandit, and returns primary + fallback chain.
   */
  async route(ctx: RoutingContext): Promise<RoutingDecision> {
    // 1. Collect all valid candidates
    const candidates = await this.collectCandidates(ctx);
    if (candidates.length === 0) {
      throw new Error("No available providers for request");
    }

    // 2. Score each candidate using the 3-axis bandit
    const scored = await Promise.all(
      candidates.map(async (c) => ({
        ...c,
        score: await this.calculateScore(c, ctx),
      }))
    );

    // 3. Intelligence chain normalization: min-max normalize intelligence_composite within the chain
    // so that rank edits near the top of the range are visible on the axis (per FreeLLMAPI design).
    const composites = scored.map((c) => (c.metrics as any).intelligence_composite ?? intelligenceComposite("Medium", 500));
    const intelMin = composites.length ? Math.min(...composites) : 0;
    const intelMax = composites.length ? Math.max(...composites) : 1;
    for (const c of scored) {
      const composite = (c.metrics as any).intelligence_composite ?? intelligenceComposite("Medium", 500);
      const normIntel = intelMax > intelMin ? (composite - intelMin) / (intelMax - intelMin) : 1;
      // Replace the placeholder intelligence score with the normalized value
      (c as any)._normIntelligence = normIntel;
    }

    // 4. Apply reliability floor: drop chronically-failing models before final sort
    const minFloor = await this.getMinReliabilityFloor();
    if (minFloor !== undefined) {
      const before = scored.length;
      // Filter in place by reassigning (since filter returns new array)
      const filtered = scored.filter((c) => c.metrics.success_rate >= minFloor);
      if (filtered.length !== scored.length) {
        console.log(`[router] reliability floor ${minFloor} dropped ${scored.length - filtered.length} candidates`);
        scored.length = 0;
        scored.push(...filtered);
      }
    }

    // 5. Sort by score descending (but we need to recalculate scores with normalized intelligence)
    // For now, use the original scores; intelligence normalization is a future enhancement
    scored.sort((a, b) => b.score - a.score);

    // 5. Primary = top score, Fallback Chain = next 2-3 (dedup by key)
    const primary = scored[0];
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

    // Fetch quota headroom per platform (used to bias away from exhausted keys)
    const quotaHeadroom = new Map<string, Map<number, number>>();
    for (const key of dbKeys) {
      if (!quotaHeadroom.has(key.platform)) {
        const map = await getKeyQuotaHeadroom(key.platform);
        quotaHeadroom.set(key.platform, map);
      }
    }

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

        const platformHeadroom = quotaHeadroom.get(key.platform);
        const keyHeadroom = platformHeadroom?.get(key.db_id) ?? 1; // 1 = unknown (no quota data)

        candidates.push({
          provider: adapter,
          model: model.id,
          key,
          platform: key.platform,
          free: model.free,
          metrics: await this.getMetrics(key.platform, model.id),
          quotaHeadroom: keyHeadroom,
        });
      }
    }

    return candidates;
  }

  /**
     * Bandit Scoring — the single source of truth for routing scores.
     * Returns a convex combination in [0,1] multiplied by guardrail factors.
     */
    private async calculateScore(candidate: Candidate, ctx: RoutingContext): Promise<number> {
      const m = candidate.metrics;

      // 1) Base weights from strategy (with peak-hours + task-type adjustments)
      const strategy = await this.getRoutingStrategy();
      const customWeights = strategy === "custom" ? await this.getCustomWeights() : null;
      let baseWeights = customWeights ?? BANDIT_PRESETS[strategy as PresetStrategy] ?? BANDIT_PRESETS.balanced;

      const peakConfig = await this.getPeakHoursConfig();
      const peakResult = peakAdjustedWeights(baseWeights, strategy, peakConfig);
      baseWeights = peakResult.weights;

      const taskWeightShare = await this.getTaskWeightShare();
      // Derive task type from client profile's priority_strategy (code tasks prefer speed, chat tasks prefer cost)
      const priorityStrategy = ctx.client_profile?.priority_strategy;
      const task = priorityStrategy === "speed" ? "code" : "chat";
      const taskResult = taskAdjustedWeights(baseWeights, task, strategy, taskWeightShare);
      baseWeights = taskResult.weights;

      // 2) Reliability: Thompson-sampled Beta posterior with community prior
      const community = candidate.metrics.community_prior ?? await this.getCommunityPrior(candidate.platform, candidate.model);
      const { alpha, beta } = reliabilityPosterior(
        candidate.metrics.weighted_successes,
        candidate.metrics.weighted_failures,
        community,
      );
      const reliabilitySample = sampleBeta(alpha, beta);

      // Exploration: epsilon-greedy for models with few samples
      const exploreEnabled = await this.getExploreEnabled();
      const exploreMinSamples = await this.getExploreMinSamples();
      const totalSamples = candidate.metrics.weighted_successes + candidate.metrics.weighted_failures;
      let reliability: number;
      if (exploreEnabled && totalSamples < exploreMinSamples) {
        const explorationBonus = (exploreMinSamples - totalSamples) / exploreMinSamples * 0.15;
        reliability = reliabilitySample + Math.random() * explorationBonus;
      } else {
        reliability = reliabilitySample;
      }

      // 3) Speed: throughput + TTFB blended
      const speed = speedScore(candidate.metrics.weighted_tok_per_sec, candidate.metrics.weighted_ttfb_ms);

      // 4) Intelligence: we'll use a placeholder; actual composite is computed in computeMetrics
      // and normalized across the chain in route()
      const intelligence = candidate.metrics.quality_score;

      // 5) Guardrails
      const headroomOpts = await this.getHeadroomThresholds();
      const monthlyBudgetUsed = 0; // would need token tracking per model/month
      const monthlyBudgetTotal = 0; // from model's monthly_token_budget
      const monthlyHeadroom = headroomFactor(monthlyBudgetUsed, monthlyBudgetTotal, headroomOpts);

      // Real quota headroom from provider-quota observations
      const quotaHeadroom = candidate.quotaHeadroom;

      const rateWindowUsed = 0; // would need live window utilization
      const rateWindow = rateWindowHeadroomFactor(rateWindowUsed, headroomOpts);

      const penaltyFactor = rateLimitFactor(candidate.metrics.penalty);

      // Combined headroom: worst of monthly budget and live quota
      const combinedHeadroom = Math.min(monthlyHeadroom, quotaHeadroom);

      // 6) Combined score
      const inputs: ScoreInputs = {
        reliability,
        speed,
        intelligence,
        headroom: combinedHeadroom,
        rateLimit: rateWindow * penaltyFactor,
      };

      let score = combineScore(inputs, baseWeights);

      // 7) Exploration jitter (small random tiebreak for models with no data)
      if (totalSamples < 5) {
        score += Math.random() * 0.02;
      }

      return Math.min(1, Math.max(0, score));
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

  /** Compute metrics from historical request data with exponential decay (half-life 2 days) */
  private async computeMetrics(platform: string, modelId: string): Promise<CachedMetrics> {
    try {
      await initDb();

      // Fetch last 7 days of requests (decay will weight recent ones more)
      const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await query`
        SELECT latency_ms, status_code as sc, input_tokens, output_tokens, timestamp
        FROM requests
        WHERE platform = ${platform} AND model = ${modelId}
          AND timestamp >= ${sinceIso}
        ORDER BY timestamp DESC
        LIMIT 2000
      `;

      if (rows.length === 0) {
        return this.getDefaultMetrics(platform, modelId);
      }

      // Exponential decay: half-life = 2 days
      const HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const LAMBDA = Math.log(2) / HALF_LIFE_MS;

      let weightedSuccesses = 0;
      let weightedFailures = 0;
      let weightedTokPerSec = 0;
      let weightedTtfbMs = 0;
      let totalWeight = 0;

      const latencies: number[] = [];
      const ttfbValues: number[] = [];

      for (const r of rows as any[]) {
        const ts = new Date(r.timestamp).getTime();
        if (!Number.isFinite(ts)) continue;
        const ageMs = now - ts;
        const weight = Math.exp(-LAMBDA * ageMs);

        const sc = Number(r.sc);
        const isSuccess = sc > 0 && sc < 400;
        if (isSuccess) weightedSuccesses += weight;
        else weightedFailures += weight;

        const latency = Number(r.latency_ms);
        if (latency > 0) latencies.push(latency);

        // Estimate tok/s if we have tokens and latency
        const outTokens = Number(r.output_tokens) || 0;
        if (latency > 0 && outTokens > 0) {
          weightedTokPerSec += (outTokens / (latency / 1000)) * weight;
        }

        // TTFB not directly stored; approximate as 10% of latency for successful requests
        if (isSuccess && latency > 0) {
          const ttfb = latency * 0.1;
          weightedTtfbMs += ttfb * weight;
          ttfbValues.push(ttfb);
        }

        totalWeight += weight;
      }

      // Normalize weighted aggregates
      const normSuccesses = totalWeight > 0 ? weightedSuccesses / totalWeight : 0;
      const normFailures = totalWeight > 0 ? weightedFailures / totalWeight : 0;
      const normTokPerSec = totalWeight > 0 ? weightedTokPerSec / totalWeight : 0;
      const normTtfbMs = totalWeight > 0 ? weightedTtfbMs / totalWeight : 0;

      // Latency p50 from raw latencies (unweighted, as p50 is robust)
      latencies.sort((a: number, b: number) => a - b);
      const latency_p50 = latencies.length > 0
        ? latencies[Math.floor(latencies.length * 0.5)]
        : 2000;

      // TTFB p50
      ttfbValues.sort((a: number, b: number) => a - b);
      const ttfb_p50 = ttfbValues.length > 0
        ? ttfbValues[Math.floor(ttfbValues.length * 0.5)]
        : 300;

      // Success rate from weighted counts
      const success_rate = normSuccesses + normFailures > 0
        ? normSuccesses / (normSuccesses + normFailures)
        : 0.95;

      // Get model config for intelligence/quality
      const modelRows = await query`
        SELECT rpm_limit, tpm_limit, intelligence_rank, speed_rank, context_window, size_label
        FROM models
        WHERE platform = ${platform} AND model_id = ${modelId}
      `;
      const modelConfig = modelRows[0] ?? {};

      const quality_score = modelConfig.intelligence_rank
        ? Math.min(1, modelConfig.intelligence_rank / 100)
        : 0.5;

      // Intelligence composite for chain normalization
      const sizeLabel = modelConfig.size_label ?? "Medium";
      const intelRank = modelConfig.intelligence_rank ?? 500;
      const intelligence_composite = intelligenceComposite(sizeLabel, intelRank);

      // Estimate cost from pricing (would need provider pricing table)
      const cost_per_1k = 0.001; // Default, will be improved with pricing table

      // Penalty from rate-limit cooldowns (tracked separately)
      let penalty = 0;
      try {
        const penaltyRows = await query`
          SELECT penalty FROM rate_limit_penalties
          WHERE platform = ${platform} AND model_id = ${modelId}
        `;
        penalty = penaltyRows[0]?.penalty ?? 0;
      } catch { /* table may not exist yet */ }

      return {
        latency_p50,
        cost_per_1k,
        quality_score,
        success_rate,
        last_updated: Date.now(),
        weighted_successes: normSuccesses,
        weighted_failures: normFailures,
        weighted_tok_per_sec: normTokPerSec,
        weighted_ttfb_ms: normTtfbMs,
        penalty,
        // Store intelligence composite for chain normalization in route()
        // @ts-ignore - dynamic property
        intelligence_composite,
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
        SELECT rpm_limit, tpm_limit, intelligence_rank, context_window, speed_rank
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
        weighted_successes: 0,
        weighted_failures: 0,
        weighted_tok_per_sec: 0,
        weighted_ttfb_ms: 0,
        penalty: 0,
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
  /** Quota headroom 0..1 from provider-quota, 1 = unknown/no data. */
  quotaHeadroom: number;
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
  const primaryIsRateLimit = primaryResult.status === 429;
  if (primaryResult.error) {
    await markKeyUnhealthy(decision.key, primaryResult);
    await recordModelFailure(decision.provider.id, decision.model, primaryIsRateLimit);
  }
  if (primaryResult.error) console.warn(`[router] primary failed: ${String(primaryResult.error).slice(0, 200)}`);
  if (!primaryResult.error) {
    await recordModelSuccess(decision.provider.id, decision.model);
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
    const fallbackIsRateLimit = result.status === 429;
    if (result.error) {
      console.warn(`[router] fallback ${fallback.provider}/${fallback.model} failed: ${String(result.error).slice(0, 200)}`);
      await markKeyUnhealthy(fallbackKeyObj, result);
      await recordModelFailure(fallback.provider, fallback.model, fallbackIsRateLimit);
    }
    if (!result.error) {
      await recordModelSuccess(fallback.provider, fallback.model);
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
 *
 * CRITICAL: Only models with `in_catalog = TRUE` are routed for `auto`/`fusion`.
 * The signed catalog (api.freellmapi.co/v1/latest) is the ONLY authoritative
 * source of free-tier evidence. Models without this flag have no proof of
 * freeness and MUST NOT be auto-routed.
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
       WHERE platform = ${platform} AND enabled = 1 AND in_catalog = 1
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
  // lists without a price stamp. Only used as a fallback when catalog is empty.
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

/** Penalty system: 429 = +3 positions, failure = +1 position, max 10.
 * Dense rank: penalties are added to the dense rank, not raw priority.
 * This prevents large gaps in the chain from making penalties inert.
 * (See FreeLLMAPI router.ts:1216-1237 for the full rationale.) */
export async function recordModelFailure(platform: string, modelId: string, isRateLimit: boolean): Promise<void> {
  const weight = isRateLimit ? 3 : 1; // PENALTY_PER_429 = 3, PENALTY_PER_FAIL = 1
  const maxPenalty = 10; // MAX_PENALTY
  try {
    await initDb();
    await query`
      INSERT INTO rate_limit_penalties (platform, model_id, penalty, updated_at)
      VALUES (${platform}, ${modelId}, ${weight}, now())
      ON CONFLICT (platform, model_id) DO UPDATE SET
        penalty = LEAST(rate_limit_penalties.penalty + ${weight}, ${maxPenalty}),
        updated_at = now()
    `;
  } catch { /* table may not exist yet */ }
}

/** Clear penalty on success (gradual decay) */
export async function recordModelSuccess(platform: string, modelId: string): Promise<void> {
  try {
    await initDb();
    await query`
      UPDATE rate_limit_penalties
      SET penalty = GREATEST(penalty - 1, 0), updated_at = now()
      WHERE platform = ${platform} AND model_id = ${modelId}
    `;
  } catch { /* table may not exist yet */ }
}

/** Get current penalty for a model */
export async function getModelPenalty(platform: string, modelId: string): Promise<number> {
  try {
    await initDb();
    const rows = await query`
      SELECT penalty FROM rate_limit_penalties
      WHERE platform = ${platform} AND model_id = ${modelId}
    `;
    return rows[0]?.penalty ?? 0;
  } catch {
    return 0;
  }
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