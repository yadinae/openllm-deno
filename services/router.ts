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
  checkCustomModelBudget,
  reserveCustomModelBudget,
  settleCustomModelUsage,
  type CustomModelBudgetVerdict,
} from "./custom-model-budget.ts";
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
  parseBudget,
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
import { reserveMonthlyBudget, settleMonthlyUsage } from "./key-budget.ts";
import { getRoutingStrategyForRequest, initDecisionSettings } from "./routing-decision.ts";

/**
 * Cached metrics for scoring (refreshed periodically).
 *
 * The `weighted_*` fields are RAW decay-weighted pseudo-counts (a request from
 * today counts 1.0, one from 2 days ago 0.5, 4 days 0.25 — half-life 2 days),
 * NOT normalized ratios. The Beta posterior and the exploration gate both read
 * sample SIZE out of them: normalizing to [0,1] collapses every model's
 * posterior onto ~0.5 and makes every model look permanently "under-observed".
 */
interface CachedMetrics {
  latency_p50: number; // ms
  cost_per_1k: number; // USD, from paid_*_per_m pricing (0 = unknown/free)
  quality_score: number; // 0-1 (from intelligence_rank)
  success_rate: number; // weighted success fraction over the 7-day window
  last_updated: number;
  // Decay-weighted RAW pseudo-counts (half-life 2 days) — Beta posterior input
  weighted_successes: number;
  weighted_failures: number;
  weighted_tok_per_sec: number; // Σ(w·out_tokens) / Σ(w·latency) over successes
  weighted_ttfb_ms: number;     // weighted mean; approximate (no ttfb column — see computeMetrics)
  penalty: number; // failure penalty (429=+3, fail=+1, max 10)
  community_prior?: CommunityReliabilityPrior;
  // Model row (catalog) — gates + guardrails + dashboard
  model_db_id: number | null;
  supports_vision: number; // 0/1 (unknown = 0, catalog convention)
  supports_tools: number;  // 0/1
  context_window: number | null; // null = unknown → never gated
  monthly_token_budget: string;  // human label ('~120M'), parsed by parseBudget
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  fallback_priority: number; // operator chain position (fallback_config), 0 = unchained
  // Live utilization (from the requests ledger)
  monthly_used_tokens: number; // calendar-month input+output for this model
  rpm_used: number; // requests in the last 60s
  rpd_used: number; // requests in the last 24h
  tpm_used: number; // tokens in the last 60s
  tpd_used: number; // tokens in the last 24h
}

/** Get pricing for a custom model from the custom_models table. Returns 0 for unknown. */
async function getCustomPricing(modelId: string): Promise<number> {
  try {
    await initDb();
    const rows = await query`
      SELECT pricing FROM custom_models WHERE id = ${modelId}
    `;
    if (rows.length === 0) return 0;
    let pricing: any = {};
    try { pricing = JSON.parse((rows[0] as any).pricing); } catch {}
    const inK = Number(pricing.input_per_1k ?? 0);
    const outK = Number(pricing.output_per_1k ?? 0);
    return (inK + outK) / 2;
  } catch { return 0; }
}

const PROVIDER_MODEL_CACHE = new Map<string, { at: number; models: ModelInfo[] }>();
const PROVIDER_MODEL_TTL_MS = 10 * 60 * 1000; // upstream /models lists change rarely

const METRICS_CACHE = new Map<string, CachedMetrics>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Request-size gates (ported from FreeLLMAPI router.ts) ─────────────────────

/**
 * The output portion of a routed request's size estimate is capped: a client
 * that sets max_tokens=200k must not exclude every 128k model — the INPUT has
 * to fit, not input+full-max_tokens. (#470)
 */
export const OUTPUT_RESERVE_CAP = 2000;
export function routingReserveTokens(requestedMaxTokens: number | null | undefined): number {
  const requested = Number(requestedMaxTokens ?? 0);
  if (!Number.isFinite(requested) || requested <= 0) return 1000;
  return Math.min(requested, OUTPUT_RESERVE_CAP);
}

/** chars/4 heuristic over message text + system prompt (FreeLLMAPI parity). */
export function estimateRequestTokens(request: ChatCompletionRequest): number {
  let chars = 0;
  const sys = (request as unknown as Record<string, unknown>).system;
  if (typeof sys === "string") chars += sys.length;
  const msgs = Array.isArray(request.messages) ? request.messages : [];
  for (const msg of msgs) {
    const c = (msg as unknown as Record<string, unknown>).content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") chars += p.text.length;
      }
    }
  }
  return Math.ceil(chars / 4) + routingReserveTokens(request.max_tokens);
}

export const CONTEXT_WINDOW_SAFETY_FACTOR = 1.25;

/** True when the request fits the RAW advertised window (null = unknown, never
 * filtered — a dispatch to a model that genuinely can't hold it is a
 * guaranteed upstream 400, so this is the hard gate). */
export function fitsContextWindowStrict(contextWindow: number | null | undefined, estimatedTokens: number): boolean {
  return contextWindow == null || estimatedTokens <= contextWindow;
}

/** True when the request fits WITH the heuristic safety margin. Margin-
 * violating-but-raw-fitting models are NOT excluded — they're a SOFT
 * preference deferred behind margin-fitting candidates (#956: /v1/models
 * advertises the raw window, clients legitimately pack up to it). */
export function fitsContextWindow(contextWindow: number | null | undefined, estimatedTokens: number, exactOutputReserve = 0): boolean {
  if (contextWindow == null) return true;
  if (estimatedTokens > contextWindow) return false;
  const reserve = Math.max(0, exactOutputReserve);
  const heuristic = Math.max(0, estimatedTokens - reserve);
  return heuristic * CONTEXT_WINDOW_SAFETY_FACTOR + reserve <= contextWindow;
}

/** True when any message carries image content (OpenAI or Anthropic shape). */
export function requestNeedsVision(request: ChatCompletionRequest): boolean {
  const msgs = Array.isArray(request.messages) ? request.messages : [];
  for (const msg of msgs) {
    const c = (msg as unknown as Record<string, unknown>).content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      const type = (part as Record<string, unknown>)?.type;
      if (type === "image_url" || type === "image" || type === "input_image") return true;
    }
  }
  return false;
}

/** True when the request offers tools the model may be expected to call. */
export function requestNeedsTools(request: ChatCompletionRequest): boolean {
  const req = request as unknown as Record<string, unknown>;
  return Array.isArray(req.tools) && req.tools.length > 0;
}

/**
 * Live rate-window pressure for a model: worst used-fraction across
 * rpm/rpd/tpm/tpd, from the requests ledger collected by computeMetrics.
 * Null/zero limits contribute nothing; no limits at all → 0 (ungated).
 */
export function windowUsedFraction(m: CachedMetrics): number {
  const ratios: number[] = [];
  if (m.rpm_limit && m.rpm_limit > 0) ratios.push(m.rpm_used / m.rpm_limit);
  if (m.rpd_limit && m.rpd_limit > 0) ratios.push(m.rpd_used / m.rpd_limit);
  if (m.tpm_limit && m.tpm_limit > 0) ratios.push(m.tpm_used / m.tpm_limit);
  if (m.tpd_limit && m.tpd_limit > 0) ratios.push(m.tpd_used / m.tpd_limit);
  if (ratios.length === 0) return 0;
  return Math.min(1, Math.max(...ratios));
}

// ── Sticky sessions (ported from FreeLLMAPI proxy.ts) ─────────────────────────
// A multi-turn conversation keeps landing on the same model: KV-cache warmth,
// consistent voice, and no mid-conversation capability surprises. Keyed by an
// explicit session id header when present, else the first user message (the
// conversation's fingerprint). 30-minute TTL, LRU-ish eviction at 500 entries.

const STICKY_TTL_MS = 30 * 60 * 1000;
const stickySessionMap = new Map<string, { modelKey: string; lastUsed: number }>();

async function sha1Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Conversation key: explicit session id wins, else hash of first user turn. */
export async function stickySessionKey(
  request: ChatCompletionRequest,
  sessionId?: string,
  strategyKey?: string,
): Promise<string> {
  const scoped = (base: string) => (strategyKey ? `${base}::${strategyKey}` : `${base}`);
  if (sessionId) return scoped(`hdr:${sessionId}`);
  const firstUser = (request.messages ?? []).find((m) => (m as unknown as Record<string, unknown>).role === "user");
  if (!firstUser) return "";
  const c = (firstUser as unknown as Record<string, unknown>).content;
  const text = typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => String((p as Record<string, unknown>)?.text ?? "")).join("")
      : "";
  if (!text) return "";
  return scoped(await sha1Hex(text));
}

/** The model this conversation stuck to earlier, or undefined. Only consulted
 * once the conversation has an assistant turn (first turn routes freely). */
export async function getStickyModel(
  request: ChatCompletionRequest,
  sessionId?: string,
  strategyKey?: string,
): Promise<string | undefined> {
  const hasAssistant = (request.messages ?? []).some((m) => (m as unknown as Record<string, unknown>).role === "assistant");
  if (!hasAssistant) return undefined;
  const key = await stickySessionKey(request, sessionId, strategyKey);
  if (!key) return undefined;
  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelKey;
}

export async function setStickyModel(
  request: ChatCompletionRequest,
  modelKey: string,
  sessionId?: string,
  strategyKey?: string,
): Promise<void> {
  const key = await stickySessionKey(request, sessionId, strategyKey);
  if (!key) return;
  stickySessionMap.set(key, { modelKey, lastUsed: Date.now() });
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
    if (stickySessionMap.size > 1000) {
      // Hard cap: evict oldest by lastUsed
      const oldest = [...stickySessionMap.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [k] of oldest.slice(0, stickySessionMap.size - 1000)) stickySessionMap.delete(k);
    }
  }
}

/** Default fallback metrics when no history available */
const DEFAULT_METRICS: CachedMetrics = {
  latency_p50: 2000,
  cost_per_1k: 0,
  quality_score: 0.5,
  success_rate: 0.95,
  last_updated: 0,
  weighted_successes: 0,
  weighted_failures: 0,
  weighted_tok_per_sec: 0,
  weighted_ttfb_ms: 0,
  penalty: 0,
  model_db_id: null,
  supports_vision: 0,
  supports_tools: 0,
  context_window: null,
  monthly_token_budget: "",
  rpm_limit: null,
  rpd_limit: null,
  tpm_limit: null,
  tpd_limit: null,
  fallback_priority: 0,
  monthly_used_tokens: 0,
  rpm_used: 0,
  rpd_used: 0,
  tpm_used: 0,
  tpd_used: 0,
};

/**
 * SmartRouter — selects optimal provider/model/key using Bandit Scoring
 * and builds a fallback chain for automatic retry on failure.
 */
export class SmartRouter {
  private metricsCache = METRICS_CACHE;

  /**
   * Get current routing strategy from settings (default: 'balanced').
   * This returns the configured strategy; for 'decision' it returns 'decision'.
   * Use resolveStrategyForRequest() to get the actual preset for a request.
   */
  async getRoutingStrategy(): Promise<RoutingStrategy> {
    const strat = await getSetting<string>(SETTING_ROUTING_STRATEGY);
    return (strat as RoutingStrategy) ?? DEFAULT_STRATEGY;
  }

  /**
   * Resolve the routing strategy for a specific request.
   * For 'decision' strategy, calls the decision model to pick a preset.
   * Caches the decision for 30 minutes.
   *
   * 'priority' (operator chain order + failure demotion) and 'custom' (saved
   * weight vector) pass through as-is; only an unrecognized value falls back.
   */
  private async resolveStrategyForRequest(
    ctx: RoutingContext,
  ): Promise<{ strategy: RoutingStrategy; reasoning?: string }> {
    const configured = await this.getRoutingStrategy();
    const valid: RoutingStrategy[] = ["balanced", "smartest", "fastest", "reliable", "custom", "priority"];
    if (valid.includes(configured)) {
      return { strategy: configured };
    }
    if (configured !== "decision") {
      return { strategy: "balanced", reasoning: `Invalid strategy '${configured}', using balanced` };
    }

    // Use decision model to select preset
    const result = await getRoutingStrategyForRequest(ctx.request, "decision");
    console.log(`[router] decision-model selected strategy=${result.strategy} source=${result.source}${result.reasoning ? ` (${result.reasoning})` : ""}`);
    return { strategy: result.strategy, reasoning: result.reasoning };
  }

  /**
   * Get custom weights from settings (if strategy is 'custom').
   */
  async getCustomWeights(): Promise<RoutingWeights | null> {
    const weights = await getSetting<RoutingWeights>(SETTING_ROUTING_WEIGHTS);
    return weights ?? null;
  }

  /**
   * Get peak-hours config from settings.
   */
  async getPeakHoursConfig(): Promise<PeakHoursConfig> {
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
  async getCommunityPrior(platform: string, modelId: string, endpointScope?: string): Promise<CommunityReliabilityPrior | undefined> {
    const key = `community_prior_${platform}_${modelId}_${endpointScope ?? ""}`;
    const prior = await getSetting<CommunityReliabilityPrior>(key);
    return prior ?? undefined;
  }

  /**
   * Get explore chance from settings.
   */
  async getExploreEnabled(): Promise<boolean> {
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
   *
   * Ordering (FreeLLMAPI orderChain parity):
   *  - bandit strategies: rank by (possibly Thompson-sampled) score, then give
   *    a random under-observed model a guaranteed first shot (exploration);
   *  - 'priority': dense-rank the operator's chain positions and sink each
   *    model by its failure penalty (429=+3, fail=+1, max 10) — dense, not raw,
   *    so big priority gaps can't make penalties inert;
   *  - sticky: a conversation's previous model is promoted to the front (after
   *    capability gates, which an explicit pin never bypasses).
   */
  async route(ctx: RoutingContext): Promise<RoutingDecision> {
    // 0. Resolve routing strategy for this request (handles 'decision' strategy)
    const { strategy: resolvedStrategy, reasoning: resolvedStrategyReasoning } =
      await this.resolveStrategyForRequest(ctx);

    // 1. Collect all valid candidates (capability-gated for THIS request)
    const candidates = await this.collectCandidates(ctx);
    if (candidates.length === 0) {
      throw new Error("No available providers for request");
    }

    // Poolable key counts per platform: the catalog monthly budget is PER KEY,
    // so the pooled allowance scales with the usable keys behind a platform.
    const keyCounts = new Map<string, number>();
    for (const c of candidates) keyCounts.set(c.platform, (keyCounts.get(c.platform) ?? 0) + 1);

    // 2) Score each candidate using the 3-axis bandit. Compute the
    // chain-wide intelligence normalization FIRST (matches FreeLLMAPI
    // scoreChainEntry, which receives intelMin/intelMax up front) so scoring
    // happens in a single pass, not two.
    const composites = candidates.map((c) => (c.metrics as any).intelligence_composite ?? intelligenceComposite("Medium", 500));
    const intelMin = composites.length ? Math.min(...composites) : 0;
    const intelMax = composites.length ? Math.max(...composites) : 1;
    for (const c of candidates) {
      const composite = (c.metrics as any).intelligence_composite ?? intelligenceComposite("Medium", 500);
      (c as any)._normIntelligence = intelMax > intelMin ? (composite - intelMin) / (intelMax - intelMin) : 1;
    }

    const scored = await Promise.all(
      candidates.map(async (c) => ({
        ...c,
        score: await this.calculateScore(c, ctx, resolvedStrategy, { keyCounts }),
      }))
    );

    // 4. Apply reliability floor: drop chronically-failing models before final
    // sort. Under-observed models (fewer than exploreMinSamples observations)
    // are KEPT so cold-start models stay in the exploration pool; if the floor
    // would empty the chain entirely, the filter is skipped — better a
    // possibly-flaky model than no model at all.
    const minFloor = await this.getMinReliabilityFloor();
    let ordered = scored;
    if (minFloor !== undefined) {
      const exploreMinSamples = await this.getExploreMinSamples();
      const kept = scored.filter((c) => {
        const samples = c.metrics.weighted_successes + c.metrics.weighted_failures;
        return samples < exploreMinSamples || this.expectedReliabilityFor(c) >= minFloor;
      });
      if (kept.length > 0 && kept.length !== scored.length) {
        console.log(`[router] reliability floor ${minFloor} dropped ${scored.length - kept.length} candidates`);
        ordered = kept;
      }
    }

    // 5. Order the chain per strategy (orderChain parity)
    const bandit = resolvedStrategy !== "priority";
    if (bandit) {
      ordered.sort((a, b) => b.score - a.score);
      // Exploration probe: with EXPLORE_CHANCE probability, promote one
      // under-observed, request-eligible model to the front so it stops
      // losing every bandit draw to prior-heavy rivals. Never in priority
      // mode: that's the operator's explicit order.
      const exploreEnabled = await this.getExploreEnabled();
      const exploreChance = await getSetting<number>(SETTING_EXPLORE_CHANCE) ?? 0.1;
      if (exploreEnabled && Math.random() < exploreChance) {
        const exploreMinSamples = await this.getExploreMinSamples();
        const unmeasured = ordered.filter((c) =>
          (c.metrics.weighted_successes + c.metrics.weighted_failures) < exploreMinSamples);
        if (unmeasured.length > 0) {
          const probe = unmeasured[Math.floor(Math.random() * unmeasured.length)];
          const idx = ordered.findIndex((c) => c === probe);
          if (idx > 0) {
            const [row] = ordered.splice(idx, 1);
            ordered.unshift(row);
          }
        }
      }
    } else {
      // 'priority': dense rank of chain positions, then failure-penalty sink.
      const distinct = [...new Set(ordered.map((c) => c.metrics.fallback_priority))].sort((a, b) => a - b);
      const denseRank = new Map<number, number>(distinct.map((v, i) => [v, i + 1]));
      ordered.sort((a, b) => {
        const ka = (denseRank.get(a.metrics.fallback_priority) ?? 999) + Math.min(a.metrics.penalty, 10);
        const kb = (denseRank.get(b.metrics.fallback_priority) ?? 999) + Math.min(b.metrics.penalty, 10);
        return ka - kb || b.score - a.score;
      });
    }

    // 6. Sticky session: promote the conversation's previous model to the
    // front. Capability gates already ran in collectCandidates, so a sticky
    // model that can't serve THIS request (e.g. an image turn on a text-only
    // model) is simply absent and the pin drops silently.
    const isAuto = ctx.request.model === "auto" || ctx.request.model === "fusion" || !ctx.request.model;
    if (isAuto) {
      const sticky = await getStickyModel(ctx.request, ctx.session_id, resolvedStrategy);
      if (sticky) {
        const idx = ordered.findIndex((c) => `${c.platform}/${c.model}` === sticky);
        if (idx > 0) {
          const [preferred] = ordered.splice(idx, 1);
          ordered.unshift(preferred);
        }
      }
    }

    // 7. Soft margin preference: requests that only fit the RAW window (not the
    // 1.25× safety margin) sit behind margin-fitting models of the same tier —
    // never excluded, so the worst case is one classified 400 hop, not an
    // empty pool. Stable within each band.
    const estimatedTokens = estimateRequestTokens(ctx.request);
    const outputReserve = routingReserveTokens(ctx.request.max_tokens);
    const marginFits = ordered.filter((c) => fitsContextWindow(c.metrics.context_window, estimatedTokens, outputReserve));
    const marginDeferred = ordered.filter((c) => !fitsContextWindow(c.metrics.context_window, estimatedTokens, outputReserve));
    ordered = [...marginFits, ...marginDeferred];

    // 8. Primary = top of chain, Fallback Chain = next candidates (dedup by key)
    const primary = ordered[0];
    const chainCandidates: ScoredCandidate[] = [];
    const usedKeys = new Set<string>([primary.key.id]);
    for (const c of ordered.slice(1)) {
      if (usedKeys.has(c.key.id)) continue;
      usedKeys.add(c.key.id);
      chainCandidates.push(c);
      if (chainCandidates.length >= 6) break;
    }
    const fallbackChain = chainCandidates.map(this.toFallbackEntry);
    console.log(`[router] candidates=${candidates.length} scored=${scored.length} keys=${new Set(scored.map((s2) => s2.key.id)).size} chain=${fallbackChain.length} strategy=${resolvedStrategy}${bandit ? "" : " (priority)"}`);

    // Build metadata including resolved strategy for audit
    const strategyInfo = resolvedStrategy
      ? ` strategy=${resolvedStrategy}${resolvedStrategyReasoning ? ` (${resolvedStrategyReasoning})` : ""}`
      : "";

    return {
      provider: primary.provider,
      model: primary.model,
      key: primary.key,
      fallback_chain: fallbackChain,
      metadata: {
        score: primary.score,
        reason: `${bandit ? "bandit-top1" : "priority-top1"} ${primary.free ? "FREE" : "paid"}${strategyInfo} ` +
          `(reliability:${primary.metrics.success_rate.toFixed(2)} tok/s:${primary.metrics.weighted_tok_per_sec.toFixed(1)} ` +
          `penalty:${primary.metrics.penalty} $/1k:${primary.metrics.cost_per_1k})`,
      },
    };
  }

  /** Deterministic reliability expectation for the floor filter. */
  private expectedReliabilityFor(c: { metrics: CachedMetrics }): number {
    return expectedReliability(c.metrics.weighted_successes, c.metrics.weighted_failures, c.metrics.community_prior);
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

    // Per-request capability gates (FreeLLMAPI routeRequest parity): an image
    // request must never reach a text-only model (the transport succeeds while
    // the images are silently dropped); a tool request must never reach a
    // model that 'answers' tools as prose text; and a request whose input
    // alone exceeds the RAW window or tpm_limit is a guaranteed upstream 400.
    const requireVision = requestNeedsVision(ctx.request);
    const requireTools = requestNeedsTools(ctx.request);
    const gateTokens = estimateRequestTokens(ctx.request);

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

        const metrics = await this.getMetrics(key.platform, model.id);

        // Capability gates (metrics carry the catalog's capability row):
        //  - vision/tools: hard gate — silence beats a fake-successful wrong answer
        //  - RAW context window + tpm_limit: hard gate — guaranteed upstream 400
        //  - margin-fitting is a SOFT preference applied in route(), not here
        if (requireVision && !metrics.supports_vision) continue;
        if (requireTools && !metrics.supports_tools) continue;
        if (!fitsContextWindowStrict(metrics.context_window, gateTokens)) continue;
        if (metrics.tpm_limit != null && metrics.tpm_limit > 0 && gateTokens > metrics.tpm_limit) continue;

        candidates.push({
          provider: adapter,
          model: model.id,
          key,
          platform: key.platform,
          free: model.free,
          metrics,
          quotaHeadroom: keyHeadroom,
        });
      }

      // ── Custom models (per-platform, gated by capabilities) ─────────────
      // Only for virtual-model routing (auto/fusion). Custom models have their
      // own `capabilities` JSON parsed into metrics-shape so they go through
      // the same vision/tools/context-window gates as catalog rows.
      if (virtualModel && adapter) {
        try {
          const { loadCustomRoutableModels } = await import("../services/custom-model.ts");
          const customModels = await loadCustomRoutableModels(key.platform);
          for (const cm of customModels) {
            // Client profile scope
                        if (allowedModels && !allowedModels.includes(cm.id)) continue;
            if (ctx.request.model && cm.id !== ctx.request.model) continue;

                      // Estimate tokens for capability gates and budget check
            const gateTokens = Math.max(
              estimateRequestTokens(ctx.request),
              ctx.request.max_tokens ?? 0,
            ) + routingReserveTokens(ctx.request.max_tokens);

                      // Capability gates
                      if (requireVision && !cm.supportsVision) continue;
                      if (requireTools && !cm.supportsTools) continue;
                      if (!fitsContextWindowStrict(cm.contextWindow, gateTokens)) continue;

            // Build a synthetic CachedMetrics for the custom model
            const metrics: CachedMetrics = {
              latency_p50: 1500,
              cost_per_1k: cm.free ? 0 : await getCustomPricing(cm.id),
              quality_score: cm.intelligenceRank / 1000,
              success_rate: 0.95,
              last_updated: Date.now(),
              weighted_successes: 0,
              weighted_failures: 0,
              weighted_tok_per_sec: 0,
              weighted_ttfb_ms: 0,
              penalty: 0,
              model_db_id: null,
              supports_vision: cm.supportsVision ? 1 : 0,
              supports_tools: cm.supportsTools ? 1 : 0,
              context_window: cm.contextWindow,
              monthly_token_budget: cm.monthlyTokenBudget,
              rpm_limit: cm.rpmLimit,
              rpd_limit: cm.rpdLimit,
              tpm_limit: cm.tpmLimit,
              tpd_limit: cm.tpdLimit,
              fallback_priority: 0,
              monthly_used_tokens: 0,
              rpm_used: 0,
              rpd_used: 0,
              tpm_used: 0,
              tpd_used: 0,
            };

            // Check custom model monthly budget (gateTokens already computed above)
            const budgetCheck = await checkCustomModelBudget(cm.id, gateTokens);
            if (!budgetCheck.allowed) {
              console.log(`[router] custom model ${cm.id} budget exceeded: ${budgetCheck.budgetUsed}/${budgetCheck.budgetLimit}`);
              continue;
            }

            candidates.push({
              provider: adapter,
              model: cm.id,
              key,
              platform: key.platform,
              free: cm.free,
              metrics,
              quotaHeadroom: 1,
              customModelBudget: budgetCheck, // For later reserve/settle
            });
          }
        } catch (e) {
          console.warn(`[router] custom model loading for ${key.platform} failed:`, e instanceof Error ? e.message : e);
        }
      }
    }

    return candidates;
  }

  /**
   * Bandit Scoring — the single source of truth for routing scores.
   * Returns a convex combination in [0,1] multiplied by guardrail factors.
   *
   * `deterministic` (dashboard path) swaps the Thompson sample for the Beta
   * posterior's expectation and drops exploration jitter, so the score table
   * is stable between polls while still reflecting real observations.
   *
   * `keyCounts` scales the per-key monthly budget by the platform's usable-key
   * count (pooled quota), matching the FreeLLMAPI guardrail semantics.
   */
    async calculateScore(
      candidate: Candidate,
      ctx: RoutingContext,
      resolvedStrategy?: RoutingStrategy,
      opts: { deterministic?: boolean; keyCounts?: Map<string, number> } = {},
    ): Promise<number> {
      const m = candidate.metrics;
      const deterministic = opts.deterministic ?? false;

      // 1) Base weights from resolved strategy (with peak-hours + task-type adjustments)
      // Use the per-request resolved strategy (handles 'decision' strategy via external LLM)
      const strategy = resolvedStrategy ?? await this.getRoutingStrategy();
      const scoringStrategy: RoutingStrategy = strategy === "priority" ? "balanced" : strategy;
      const customWeights = scoringStrategy === "custom" ? await this.getCustomWeights() : null;
      let baseWeights = customWeights ?? BANDIT_PRESETS[scoringStrategy as PresetStrategy] ?? BANDIT_PRESETS.balanced;

      const peakConfig = await this.getPeakHoursConfig();
      const peakResult = peakAdjustedWeights(baseWeights, scoringStrategy, peakConfig);
      baseWeights = peakResult.weights;

      const taskWeightShare = await this.getTaskWeightShare();
      // Derive task type from client profile's priority_strategy (code tasks prefer speed, chat tasks prefer cost)
      const priorityStrategy = ctx.client_profile?.priority_strategy;
      const task = priorityStrategy === "speed" ? "code" : "chat";
      const taskResult = taskAdjustedWeights(baseWeights, task, scoringStrategy, taskWeightShare);
      baseWeights = taskResult.weights;

      // 2) Reliability: Thompson-sampled Beta posterior with community prior.
      // Weighted counts are RAW decay-weighted pseudo-counts — alpha/beta grow
      // with sample size, so a model with 50 successes is confidently high and
      // a model with 2 is still uncertain.
      const community = candidate.metrics.community_prior ?? await this.getCommunityPrior(candidate.platform, candidate.model);
      const sampled = !deterministic;
      let reliability: number;
      if (sampled) {
        const { alpha, beta } = reliabilityPosterior(m.weighted_successes, m.weighted_failures, community);
        reliability = sampleBeta(alpha, beta);
      } else {
        reliability = expectedReliability(m.weighted_successes, m.weighted_failures, community);
      }

      // Exploration: under-observed models (fewer than exploreMinSamples real
      // observations) get a bounded bonus so cold-start models stay reachable.
      const exploreEnabled = await this.getExploreEnabled();
      const exploreMinSamples = await this.getExploreMinSamples();
      const totalSamples = m.weighted_successes + m.weighted_failures;
      if (!deterministic && exploreEnabled && totalSamples < exploreMinSamples) {
        const explorationBonus = (exploreMinSamples - totalSamples) / exploreMinSamples * 0.15;
        reliability = Math.min(1, reliability + Math.random() * explorationBonus);
      }

      // 3) Speed: throughput + TTFB blended
      const speed = speedScore(m.weighted_tok_per_sec, m.weighted_ttfb_ms || null);

      // 4) Intelligence: the composite (size × tier) is computed in computeMetrics
      // and min-max normalized across the chain in route(). Use the normalized
      // value when available (route() runs first and sets _normIntelligence on
      // every candidate); fall back to the raw quality_score for single-candidate
      // paths where normalization is a no-op.
      const intelligence = (candidate as any)._normIntelligence ?? candidate.metrics.quality_score;

      // 5) Guardrails — two headroom meters, combined as the WORSE of the two
      // (both say "close to burning out" on different clocks; multiplying them
      // would dive below the operator's floor).
      const headroomOpts = await this.getHeadroomThresholds();

      // Monthly budget: the catalog label ('~120M') is PER KEY; pool it across
      // the platform's usable keys, then compare against the model's real
      // calendar-month token usage.
      const keyCount = Math.max(1, opts.keyCounts?.get(candidate.platform) ?? 1);
      const monthlyBudget = parseBudget(m.monthly_token_budget) * keyCount;
      const monthlyHeadroom = headroomFactor(m.monthly_used_tokens, monthlyBudget, headroomOpts);

      // Live rate window: worst pressure across rpm/rpd/tpm/tpd from the
      // requests ledger, so a model near its daily cap demotes BEFORE it 429s.
      const windowUsed = windowUsedFraction(m);
      const windowHeadroom = rateWindowHeadroomFactor(windowUsed, headroomOpts);

      const combinedHeadroom = Math.min(
        monthlyHeadroom, Math.min(windowHeadroom, candidate.quotaHeadroom),
      );

      // Failure penalty is its OWN axis (429=+3/fail=+1, max 10 → score damp),
      // not folded into headroom — it says "recently failed", not "low quota".
      const penaltyFactor = rateLimitFactor(m.penalty);

      // 6) Combined score
      const inputs: ScoreInputs = {
        reliability,
        speed,
        intelligence,
        headroom: combinedHeadroom,
        rateLimit: penaltyFactor,
      };

      let score = combineScore(inputs, baseWeights);

      // 7) Exploration jitter (small random tiebreak for models with no data)
      if (!deterministic && totalSamples < 5) {
        score += Math.random() * 0.02;
      }

      return Math.min(1, Math.max(0, score));
    }

    /** Get cached or computed metrics for a provider/model */
    async getMetrics(platform: string, modelId: string): Promise<CachedMetrics> {
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

  /**
   * Compute metrics from historical request data with exponential decay
   * (half-life 2 days), plus the model's catalog row (capabilities, budgets,
   * limits, chain priority) and live window utilization.
   *
   * The decay-weighted success/failure values are RAW pseudo-counts — the Beta
   * posterior and the exploration gate both need sample size, not a ratio.
   */
  private async computeMetrics(platform: string, modelId: string): Promise<CachedMetrics> {
    try {
      await initDb();

      // ── Model catalog row + operator chain position ──────────────────────
      const modelRows = await query`
        SELECT m.id AS model_db_id,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
               m.intelligence_rank, m.speed_rank, m.context_window, m.size_label,
               m.monthly_token_budget, m.supports_vision, m.supports_tools,
               m.paid_input_per_m, m.paid_output_per_m,
               COALESCE(f.priority, 0) AS fallback_priority
        FROM models m
        LEFT JOIN fallback_config f ON f.model_db_id = m.id
        WHERE m.platform = ${platform} AND m.model_id = ${modelId}
      `;
      const modelConfig = (modelRows[0] ?? {}) as Record<string, unknown>;

      // ── Decay-weighted outcome/throughput aggregates (7-day window) ─────
      const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await query`
        SELECT latency_ms, status_code as sc, input_tokens, output_tokens, timestamp
        FROM requests
        WHERE platform = ${platform} AND model = ${modelId}
          AND timestamp >= ${sinceIso}
        ORDER BY timestamp DESC
        LIMIT 2000
      `;

      let weightedSuccesses = 0; // RAW decay-weighted pseudo-counts
      let weightedFailures = 0;
      let wOutTokens = 0;   // Σ w·output_tokens over successes (throughput numerator)
      let wLatencyMs = 0;   // Σ w·latency_ms over successes (throughput denominator)
      let wTtfb = 0;        // Σ w·ttfb over successes
      let wTtfbCnt = 0;     // Σ w over successes with ttfb
      const latencies: number[] = [];

      const HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
      const LAMBDA = Math.log(2) / HALF_LIFE_MS;
      const nowMs = Date.now();

      for (const r of rows as any[]) {
        const ts = new Date(r.timestamp).getTime();
        if (!Number.isFinite(ts)) continue;
        const weight = Math.exp(-LAMBDA * Math.max(0, nowMs - ts));

        const sc = Number(r.sc);
        const isSuccess = sc > 0 && sc < 400;
        if (isSuccess) weightedSuccesses += weight;
        else weightedFailures += weight;

        const latency = Number(r.latency_ms);
        if (latency > 0) {
          latencies.push(latency);
          if (isSuccess) {
            // Throughput: accumulate numerator and denominator separately, so a
            // slow request dilutes the average by its real time cost instead of
            // each request voting with an equal-weight ratio.
            wLatencyMs += weight * latency;
            wOutTokens += weight * (Number(r.output_tokens) || 0);
            // TTFB is not recorded per request (the requests table has no
            // ttfb_ms column); 10% of wall latency is the honest proxy until
            // the gateway starts recording first-byte time.
            const ttfb = latency * 0.1;
            wTtfb += weight * ttfb;
            wTtfbCnt += weight;
          }
        }
      }

      const weightedTokPerSec = wLatencyMs > 0 ? wOutTokens / (wLatencyMs / 1000) : 0;
      const weightedTtfbMs = wTtfbCnt > 0 ? wTtfb / wTtfbCnt : 0;

      // Latency p50 from raw latencies (unweighted, as p50 is robust)
      latencies.sort((a: number, b: number) => a - b);
      const latency_p50 = latencies.length > 0
        ? latencies[Math.floor(latencies.length * 0.5)]
        : 2000;

      // Success rate from the weighted counts (display + reliability-floor fallback)
      const success_rate = weightedSuccesses + weightedFailures > 0
        ? weightedSuccesses / (weightedSuccesses + weightedFailures)
        : 0.95;

      // ── Live utilization windows ─────────────────────────────────────────
      // The requests table IS the usage ledger: rpm/rpd/tpm/tpd are counts over
      // sliding windows. Drives the rate-window headroom guardrail so a model
      // near its daily cap demotes BEFORE it 429s.
      let rpmUsed = 0, rpdUsed = 0, tpmUsed = 0, tpdUsed = 0;
      try {
        const minIso = new Date(nowMs - 60_000).toISOString();
        const dayIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
        const winRows = await query`
          SELECT
            COUNT(*) FILTER (WHERE timestamp >= ${minIso}::text) AS rpm,
            COUNT(*) AS rpd,
            COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE timestamp >= ${minIso}::text), 0) AS tpm,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tpd
          FROM requests
          WHERE platform = ${platform} AND model = ${modelId}
            AND timestamp >= ${dayIso}::text
        `;
        const w = (winRows[0] ?? {}) as Record<string, number>;
        rpmUsed = Number(w.rpm ?? 0);
        rpdUsed = Number(w.rpd ?? 0);
        tpmUsed = Number(w.tpm ?? 0);
        tpdUsed = Number(w.tpd ?? 0);
      } catch { /* window query best-effort */ }

      // Calendar-month token usage for the monthly headroom guardrail
      let monthlyUsedTokens = 0;
      try {
        const monthStartIso = new Date(Date.UTC(nowMs ? new Date(nowMs).getUTCFullYear() : 1970, nowMs ? new Date(nowMs).getUTCMonth() : 0, 1)).toISOString();
        const monthRows = await query`
          SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
          FROM requests
          WHERE platform = ${platform} AND model = ${modelId}
            AND timestamp >= ${monthStartIso}::text
        `;
        monthlyUsedTokens = Number((monthRows[0] as any)?.used ?? 0);
      } catch { /* best-effort */ }

      // ── Catalog-derived fields ───────────────────────────────────────────
      const intelligence_rank = Number(modelConfig.intelligence_rank ?? 0);
      const quality_score = intelligence_rank
        ? Math.min(1, intelligence_rank / 100)
        : 0.5;

      // Intelligence composite for chain normalization (FreeLLMAPI semantics:
      // composite = size-tier value blended with rank, min-max normalized
      // across the chain in route()).
      const sizeLabel = String(modelConfig.size_label ?? "Medium");
      const intelligence_composite = intelligenceComposite(sizeLabel, intelligence_rank || 500);

      // Real pricing from the paid_*_per_m columns (model-pricing port).
      // cost_per_1k = mean input/output USD per 1M ÷ 1000. 0 = free/unknown.
      const paidIn = Number(modelConfig.paid_input_per_m ?? 0);
      const paidOut = Number(modelConfig.paid_output_per_m ?? 0);
      const cost_per_1k = (paidIn > 0 || paidOut > 0)
        ? (paidIn + paidOut) / 2 / 1000
        : 0;

      // Penalty from the failure-penalty ledger (429=+3, fail=+1, max 10)
      let penalty = 0;
      try {
        const penaltyRows = await query`
          SELECT penalty FROM rate_limit_penalties
          WHERE platform = ${platform} AND model_id = ${modelId}
        `;
        penalty = Number(penaltyRows[0]?.penalty ?? 0);
      } catch { /* table may not exist yet */ }

      return {
        latency_p50,
        cost_per_1k,
        quality_score,
        success_rate,
        last_updated: Date.now(),
        weighted_successes: weightedSuccesses,
        weighted_failures: weightedFailures,
        weighted_tok_per_sec: weightedTokPerSec,
        weighted_ttfb_ms: weightedTtfbMs,
        penalty,
        model_db_id: modelConfig.model_db_id != null ? Number(modelConfig.model_db_id) : null,
        supports_vision: Number(modelConfig.supports_vision ?? 0),
        supports_tools: Number(modelConfig.supports_tools ?? 0),
        context_window: modelConfig.context_window != null ? Number(modelConfig.context_window) : null,
        monthly_token_budget: String(modelConfig.monthly_token_budget ?? ""),
        rpm_limit: modelConfig.rpm_limit != null ? Number(modelConfig.rpm_limit) : null,
        rpd_limit: modelConfig.rpd_limit != null ? Number(modelConfig.rpd_limit) : null,
        tpm_limit: modelConfig.tpm_limit != null ? Number(modelConfig.tpm_limit) : null,
        tpd_limit: modelConfig.tpd_limit != null ? Number(modelConfig.tpd_limit) : null,
        fallback_priority: Number(modelConfig.fallback_priority ?? 0),
        monthly_used_tokens: monthlyUsedTokens,
        rpm_used: rpmUsed,
        rpd_used: rpdUsed,
        tpm_used: tpmUsed,
        tpd_used: tpdUsed,
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
        SELECT m.id AS model_db_id, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
               m.intelligence_rank, m.context_window, m.speed_rank,
               m.monthly_token_budget, m.supports_vision, m.supports_tools,
               m.paid_input_per_m, m.paid_output_per_m,
               COALESCE(f.priority, 0) AS fallback_priority
        FROM models m
        LEFT JOIN fallback_config f ON f.model_db_id = m.id
        WHERE m.platform = ${platform} AND m.model_id = ${modelId}
      `;
      const config = (rows[0] ?? {}) as Record<string, unknown>;

      // Estimate latency from speed_rank (lower rank = faster)
      const speed_rank = Number(config.speed_rank ?? 50);
      const latency_p50 = Math.max(500, speed_rank * 50); // Rough estimate

      const intelligence_rank = Number(config.intelligence_rank ?? 0);
      const quality_score = intelligence_rank
        ? Math.min(1, intelligence_rank / 100)
        : 0.5;

      const paidIn = Number(config.paid_input_per_m ?? 0);
      const paidOut = Number(config.paid_output_per_m ?? 0);
      const cost_per_1k = (paidIn > 0 || paidOut > 0) ? (paidIn + paidOut) / 2 / 1000 : 0;

      return {
        ...DEFAULT_METRICS,
        latency_p50,
        cost_per_1k,
        quality_score,
        model_db_id: config.model_db_id != null ? Number(config.model_db_id) : null,
        supports_vision: Number(config.supports_vision ?? 0),
        supports_tools: Number(config.supports_tools ?? 0),
        context_window: config.context_window != null ? Number(config.context_window) : null,
        monthly_token_budget: String(config.monthly_token_budget ?? ""),
        rpm_limit: config.rpm_limit != null ? Number(config.rpm_limit) : null,
        rpd_limit: config.rpd_limit != null ? Number(config.rpd_limit) : null,
        tpm_limit: config.tpm_limit != null ? Number(config.tpm_limit) : null,
        tpd_limit: config.tpd_limit != null ? Number(config.tpd_limit) : null,
        fallback_priority: Number(config.fallback_priority ?? 0),
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
  /** Custom model monthly budget verdict (for reserve/settle). */
  customModelBudget?: CustomModelBudgetVerdict;
}

interface ScoredCandidate extends Candidate {
  score: number;
}

/** Global router instance */
export const smartRouter = new SmartRouter();

// ── Dashboard routing scores (FreeLLMAPI getRoutingScores parity) ────────────

/** Per-model score breakdown for the dashboard model list. Deterministic
 * (expected reliability, no Thompson sample, no jitter) so the table is stable
 * between 15s polls while still reflecting real observations. */
export interface RoutingScore {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  reliability: number;
  speed: number;
  intelligence: number;
  headroom: number;
  rateLimit: number;
  score: number;
  totalRequests: number; // decay-weighted observations over the 7-day window
}

export interface RoutingScoresPayload {
  strategy: RoutingStrategy;
  keySelectionStrategy: KeySelectionStrategy;
  weights: Record<string, number> | null;
  customWeights: Record<string, number>;
  presets: Record<string, Record<string, number>>;
  exploreEnabled: boolean;
  peakAdjusted: boolean;
  peakHours: PeakHoursConfig;
  scores: RoutingScore[];
}

/**
 * Score the whole enabled catalog for the dashboard. `weights` is what the
 * router would use RIGHT NOW (peak-hours-adjusted; under 'priority' the table
 * still scores under balanced so the columns mean something); `customWeights`
 * always carries the saved vector (or balanced) so the sliders render before
 * the operator has saved their own.
 */
export async function getRoutingScores(): Promise<RoutingScoresPayload> {
  await initDb();
  const strategy = await smartRouter.getRoutingStrategy();
  const peakHours = await smartRouter.getPeakHoursConfig();
  const exploreEnabled = await smartRouter.getExploreEnabled();
  const customWeights = (await smartRouter.getCustomWeights()) ?? BANDIT_PRESETS.balanced;

  // Deterministic weights for display under the active strategy
  const displayStrategy: RoutingStrategy = strategy === "decision" ? "balanced" : strategy;
  const baseWeights = displayStrategy === "custom"
    ? customWeights
    : BANDIT_PRESETS[(displayStrategy === "priority" ? "balanced" : displayStrategy) as PresetStrategy] ?? BANDIT_PRESETS.balanced;
  const peakResult = peakAdjustedWeights(baseWeights, displayStrategy, peakHours);
  const weightsForStrategy: Record<string, number> | null =
    strategy === "priority" ? null : { ...peakResult.weights };

  const enabledKeys = await query`
    SELECT platform FROM api_keys WHERE enabled = true AND status = 'healthy'
  `;
  const keyCounts = new Map<string, number>();
  for (const k of enabledKeys as any[]) keyCounts.set(k.platform, (keyCounts.get(k.platform) ?? 0) + 1);

  // The whole enabled catalog, chain order first (LEFT JOIN keeps unchained rows)
  const chain = await query`
    SELECT m.id AS model_db_id, m.platform, m.model_id, m.display_name,
           COALESCE(f.enabled, 0) AS enabled, COALESCE(f.priority, 0) AS priority
    FROM models m
    LEFT JOIN fallback_config f ON f.model_db_id = m.id
    WHERE m.enabled = 1
    ORDER BY f.priority ASC NULLS LAST
    LIMIT 500
  `;

  // Score each under deterministic weights with chain-normalized intelligence
  const scoredRows: Array<ScoredCandidate & { displayName: string; modelDbId: number; chainEnabled: boolean }> = [];
  for (const row of chain as any[]) {
    const metrics = await smartRouter.getMetrics(row.platform, row.model_id);
    const adapter = providerRegistry.get(row.platform);
    const composite = (metrics as any).intelligence_composite ?? 0;
    const candidate = {
      provider: adapter!,
      model: row.model_id,
      key: { id: `dash-${row.model_db_id}`, db_id: 0, platform: row.platform, label: "", encrypted_key: "", iv: "", auth_tag: "", status: "healthy", enabled: true, base_url: null, monthly_request_cap: 0, monthly_token_cap: 0 } as unknown as ApiKey,
      platform: row.platform,
      free: metrics.cost_per_1k === 0,
      metrics: { ...metrics, intelligence_composite: composite } as CachedMetrics,
      quotaHeadroom: 1,
      displayName: row.display_name ?? row.model_id,
      modelDbId: Number(row.model_db_id),
      chainEnabled: Number(row.enabled) === 1,
      score: 0,
    };
    scoredRows.push(candidate as any);
  }

  const composites = scoredRows.map((c) => (c.metrics as any).intelligence_composite ?? 0);
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;
  for (const c of scoredRows) {
    const composite = (c.metrics as any).intelligence_composite ?? 0;
    (c as any)._normIntelligence = intelMax > intelMin ? (composite - intelMin) / (intelMax - intelMin) : 1;
  }

  const ctxStub = { request: { model: "auto", messages: [] }, available_keys: [] } as unknown as RoutingContext;
  const scores: RoutingScore[] = [];
  for (const c of scoredRows) {
    const score = await smartRouter.calculateScore(c, ctxStub, displayStrategy, { deterministic: true, keyCounts });
    const m = c.metrics;
    const community = m.community_prior ?? await smartRouter.getCommunityPrior(c.platform, c.model);
    const headroomOpts = { rampStart: undefined, floor: undefined };
    scores.push({
      modelDbId: c.modelDbId,
      platform: c.platform,
      modelId: c.model,
      displayName: c.displayName,
      enabled: c.chainEnabled,
      reliability: expectedReliability(m.weighted_successes, m.weighted_failures, community),
      speed: speedScore(m.weighted_tok_per_sec, m.weighted_ttfb_ms || null),
      intelligence: (c as any)._normIntelligence,
      headroom: Math.min(
        headroomFactor(m.monthly_used_tokens, parseBudget(m.monthly_token_budget) * Math.max(1, keyCounts.get(c.platform) ?? 1), headroomOpts),
        rateWindowHeadroomFactor(windowUsedFraction(m), headroomOpts),
      ),
      rateLimit: rateLimitFactor(m.penalty),
      score,
      totalRequests: Math.round(m.weighted_successes + m.weighted_failures),
    });
  }
  scores.sort((a, b) => b.score - a.score);

  return {
    strategy,
    keySelectionStrategy: ((await getSetting<KeySelectionStrategy>("routing_key_selection")) ?? "auto"),
    weights: weightsForStrategy,
    customWeights: { ...customWeights },
    presets: BANDIT_PRESETS as unknown as Record<string, Record<string, number>>,
    exploreEnabled,
    peakAdjusted: peakResult.adjusted ?? isPeakHoursActiveNow(strategy, peakHours),
    peakHours,
    scores,
  };
}

/** True when the clock is inside the configured peak window for this strategy. */
function isPeakHoursActiveNow(strategy: RoutingStrategy, cfg: PeakHoursConfig): boolean {
  if (!cfg?.enabled) return false;
  if (isPeakExemptStrategy(strategy)) return false;
  const now = new Date();
  const hour = hourInTimezone(now, cfg.timezone);
  return hourInWindow(hour, cfg.startHour, cfg.endHour);
}

function hourInWindow(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

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

  // Per-key monthly budget admission gate (#1158 parity). Reserve estimated
  // tokens before dispatch and release on every terminal path. A key at its
  // cap gets a 429 with seconds-until-next-month so the caller knows when the
  // window resets instead of hammering a bare 429.
  const estimatedTokens = decision.provider.estimate_tokens(request);
  const budget = await reserveMonthlyBudget(decision.key.db_id, estimatedTokens);
  const releaseBudget = () => budget.release?.();
  if (!budget.allowed) {
    return {
      error: `monthly_${budget.reason}`,
      status: 429,
      latency_ms: 0,
      provider_metadata: {
        retry_after_sec: budget.retryAfterSec,
        reason: budget.reason,
        exhausted_chain: false,
        attempts: [],
      },
    };
  }

  // Custom model monthly budget (if the routed model is a custom model)
  const isCustomModel = decision.model.startsWith("custom/");
  let customBudget: Awaited<ReturnType<typeof reserveCustomModelBudget>> | null = null;
  if (isCustomModel) {
    customBudget = await reserveCustomModelBudget(decision.model, estimatedTokens);
    if (!customBudget.allowed) {
      releaseBudget();
      return {
        error: `custom_model_monthly_token_budget`,
        status: 429,
        latency_ms: 0,
        provider_metadata: {
          retry_after_sec: customBudget.retryAfterSec,
          reason: "custom_model_monthly_token_budget",
          exhausted_chain: false,
          attempts: [],
        },
      };
    }
  }
  const releaseCustomBudget = () => customBudget?.release?.();

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
    // Conversation affinity: remember the model that actually served this
    // auto-routed turn so follow-ups stick to it (KV-cache warmth, consistent
    // behavior). Explicit model pins don't need affinity.
    if (isVirtualModel(request.model)) {
      await setStickyModel(request, `${decision.provider.id}/${decision.model}`, ctx.session_id);
    }
    if (primaryResult.response) {
      (primaryResult.response as unknown as Record<string, unknown>)._routed_via = {
        platform: decision.provider.id,
        model: decision.model,
        score: decision.metadata.score,
        reason: decision.metadata.reason,
      };
    }
    releaseBudget();
    releaseCustomBudget();
    await settleMonthlyUsage(
      decision.key.db_id,
      primaryResult.response?.usage?.prompt_tokens ?? estimatedTokens,
      primaryResult.response?.usage?.completion_tokens ?? 0,
    );
    if (isCustomModel) {
      await settleCustomModelUsage(
        decision.model,
        primaryResult.response?.usage?.prompt_tokens ?? estimatedTokens,
        primaryResult.response?.usage?.completion_tokens ?? 0,
      );
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

    const isFallbackCustom = fallback.model.startsWith("custom/");
    let fallbackCustomBudget: Awaited<ReturnType<typeof reserveCustomModelBudget>> | null = null;
    if (isFallbackCustom) {
      fallbackCustomBudget = await reserveCustomModelBudget(fallback.model, estimatedTokens);
      if (!fallbackCustomBudget.allowed) {
        console.warn(`[router] fallback custom model ${fallback.model} budget exceeded`);
        continue;
      }
    }

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
      // Sticky affinity follows the model that ACTUALLY served, including
      // when the primary failed over — the next turn starts where this one ended.
      if (isVirtualModel(request.model)) {
        await setStickyModel(request, `${fallback.provider}/${fallback.model}`, ctx.session_id);
      }
      // Log fallback usage
      console.log(`[router] Fallback used: ${fallback.provider}/${fallback.model} (primary failed: ${primaryResult.error})`);
      if (result.response) {
        (result.response as unknown as Record<string, unknown>)._routed_via = {
          platform: fallback.provider,
          model: fallback.model,
          fallback: true,
          primary_error: primaryString(primaryResult.error),
          // Preserve the routing-decision strategy so the audit trail records
          // what the decision model selected, even when the primary failed.
          reason: decision.metadata.reason,
        };
      }
      releaseBudget();
      if (isFallbackCustom) {
        fallbackCustomBudget?.release?.();
      }
      await settleMonthlyUsage(
        fallbackKeyObj.db_id,
        result.response?.usage?.prompt_tokens ?? estimatedTokens,
        result.response?.usage?.completion_tokens ?? 0,
      );
      if (isFallbackCustom) {
        await settleCustomModelUsage(
          fallback.model,
          result.response?.usage?.prompt_tokens ?? estimatedTokens,
          result.response?.usage?.completion_tokens ?? 0,
        );
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
  releaseBudget();
  releaseCustomBudget();
  return failedResult;
}

/**
 * P2 summarizeExhaustion helper: build a human-readable summary of WHY the
 * fallback chain died, with a suggested next-try hint when a rate-limit reset
 * time is known. Used by routes to enrich the error body the SPA renders.
 */
export function summarizeExhaustion(result: ProviderResult): {
  message: string;
  attempts: string[];
  retryAfterSec?: number;
} | null {
  const meta = result.provider_metadata as Record<string, unknown> | undefined;
  if (!meta?.exhausted_chain) return null;
  const attempts = Array.isArray(meta.attempts) ? (meta.attempts as string[]) : [];
  const msg = typeof result.error === "string" ? result.error : "All providers failed";
  const retryAfterSec = typeof meta.retry_after_sec === "number" ? meta.retry_after_sec : undefined;
  const summary = `${msg} (after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"})`;
  return { message: summary, attempts, retryAfterSec };
}

function primaryString(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

/** The router — not the caller — chose the model for these virtual names. */
function isVirtualModel(model: string | undefined): boolean {
  return !model || model === "auto" || model === "fusion";
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

/** Custom model with parsed capabilities for routing. */
export interface CustomRoutableModel {
  id: string;
  provider: string;
  displayName: string;
  free: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  contextWindow: number;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  intelligenceRank: number;
  sizeLabel: string;
}

/** Load active custom models for a platform, with capabilities parsed for routing. */
export async function loadCustomRoutableModels(platform: string): Promise<CustomRoutableModel[]> {
  try {
    await initDb();
    const rows = await query`
      SELECT id, display_name, provider, capabilities, pricing, config
      FROM custom_models
      WHERE provider = ${platform} AND status = 'active'
    `;
    const out: CustomRoutableModel[] = [];
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
        rpmLimit: null,
        rpdLimit: null,
        tpmLimit: null,
        tpdLimit: null,
        monthlyTokenBudget: "",
        intelligenceRank: intelRank,
        sizeLabel,
      });
    }
    return out;
  } catch (e) {
    console.warn(`[router] loadCustomRoutableModels(${platform}) failed:`, e instanceof Error ? e.message : e);
    return [];
  }
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