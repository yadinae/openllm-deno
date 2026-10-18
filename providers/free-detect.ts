/**
 * Free Model Detection — Three-tier logic.
 * Phase B Week 7: Free model detection for P-CORE-004.
 * 
 * Tier 1: Whitelist (highest confidence) — known free model IDs per provider
 * Tier 2: Zero pricing strict check — input_per_1k == 0 && output_per_1k == 0
 * Tier 3: :free suffix identification — model ID ends with ":free"
 */

import type { PricingModel, FreeModelInfo, FreeDetectionTier } from "./types.ts";

// ============================================================================
// Free Model Whitelist (Tier 1)
// ============================================================================

/** Known free models per provider (exact IDs, not glob patterns).
 * Sourced from FreeLLMAPI catalog and community reports.
 */
export const FREE_MODEL_WHITELIST: Record<string, string[]> = {
  groq: [
    "llama-3.1-8b-instant",
    "gemma2-9b-it",
  ],
  openrouter: [
    "openrouter/auto",
    "openrouter/openai/free",
  ],
  agnes: [
    "agnes-v2.6-flash",
  ],
  nvidia: [
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.1-70b-instruct",
  ],
  ollama: [], // All Ollama models are free (self-hosted)
  firecrawl: [], // Not a chat provider
  perplexity: [], // Has free tier
  github: [], // GitHub Models free tier
  siliconflow: [], // Has free models
  longcat: [], // Has free models
  opencode: [
    "big-pickle",
    "deepseek-v4-flash-free",
    "mimo-v2.5-free",
    "nemotron-3-super-free",
    "space-bunny-free",
    "cat-jam-free",
    "longcat-2.5-preview-free",
    "step-5-preview-free",
    "exo-free",
    "mimo-v2.6-flash-free",
    "mimo-v2-omni-free",
    "minimax-m2.5-free",
    "ling-3.1-flash-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "muse-spark-1.3-contributor-free",
    "jev-1.13-free",
  ],
  "opencode-free": [
    "big-pickle",
    "deepseek-v4-flash-free",
    "mimo-v2.5-free",
    "nemotron-3-super-free",
    "space-bunny-free",
    "cat-jam-free",
    "longcat-2.5-preview-free",
    "step-5-preview-free",
    "exo-free",
    "mimo-v2.6-flash-free",
    "mimo-v2-omni-free",
    "minimax-m2.5-free",
    "ling-3.1-flash-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "muse-spark-1.3-contributor-free",
    "jev-1.13-free",
  ],
};

// ============================================================================
// :free Suffix Patterns (Tier 3)
// ============================================================================

/** Model ID patterns that indicate a free model via ":free" suffix */
export const FREE_SUFFIX_PATTERNS = [/:free$/, /-free$/, /_free$/];

// ============================================================================
// Detection Functions
// ============================================================================

/** Check if model ID matches a whitelist pattern for the provider */
function isWhitelisted(providerId: string, modelId: string): boolean {
  const whitelist = FREE_MODEL_WHITELIST[providerId];
  if (!whitelist) return false;
  return whitelist.includes(modelId);
}

/** Check if model ID matches :free suffix pattern */
function hasFreeSuffix(modelId: string): boolean {
  return FREE_SUFFIX_PATTERNS.some((pattern) => pattern.test(modelId));
}

/** Check if pricing indicates free (both input and output are zero) */
function isZeroPricing(pricing: PricingModel): boolean {
  return pricing.input_per_1k === 0 && pricing.output_per_1k === 0;
}

/**
 * Detect whether a model is free using three-tier logic:
 * 1. Whitelist first (highest confidence)
 * 2. Zero pricing strict check
 * 3. :free suffix identification
 */
export function detectFreeModel(
  providerId: string,
  modelId: string,
  pricing: PricingModel
): FreeModelInfo {
  // Tier 1: Whitelist
  if (isWhitelisted(providerId, modelId)) {
    return {
      is_free: true,
      tier: "whitelist",
      confidence: 0.95,
      price_note: "free (whitelist)",
      source: "whitelist",
    };
  }

  // Tier 2: Zero pricing
  if (isZeroPricing(pricing)) {
    return {
      is_free: true,
      tier: "zero_pricing",
      confidence: 0.85,
      price_note: "free (zero pricing)",
      source: "pricing",
    };
  }

  // Tier 3: :free suffix
  if (hasFreeSuffix(modelId)) {
    return {
      is_free: true,
      tier: "free_suffix",
      confidence: 0.7,
      price_note: "free (:free suffix)",
      source: "suffix",
    };
  }

  // Default: not free
  return {
    is_free: false,
    tier: "unknown",
    confidence: 0.5,
    price_note: pricing.input_per_1k === 0 ? "free input, paid output" : "paid",
    source: "default",
  };
}

/**
 * Batch detect free status for multiple models.
 * Returns results keyed by model ID.
 */
export function detectFreeModels(
  providerId: string,
  models: Array<{ id: string; pricing?: PricingModel }>,
  defaultPricing: PricingModel
): Record<string, FreeModelInfo> {
  const results: Record<string, FreeModelInfo> = {};
  for (const m of models) {
    const pricing = m.pricing ?? defaultPricing;
    results[m.id] = detectFreeModel(providerId, m.id, pricing);
  }
  return results;
}

/**
 * Get all free models from a list.
 */
export function getFreeModels(
  providerId: string,
  models: Array<{ id: string; pricing?: PricingModel }>,
  defaultPricing: PricingModel
): string[] {
  const results = detectFreeModels(providerId, models, defaultPricing);
  return Object.entries(results)
    .filter(([, info]) => info.is_free)
    .map(([modelId]) => modelId);
}

/**
 * Add models to the free whitelist for a provider.
 */
export function addToWhitelist(providerId: string, modelIds: string[]): void {
  if (!FREE_MODEL_WHITELIST[providerId]) {
    FREE_MODEL_WHITELIST[providerId] = [];
  }
  for (const id of modelIds) {
    if (!FREE_MODEL_WHITELIST[providerId]!.includes(id)) {
      FREE_MODEL_WHITELIST[providerId]!.push(id);
    }
  }
}

/**
 * Remove models from the free whitelist for a provider.
 */
export function removeFromWhitelist(providerId: string, modelIds: string[]): void {
  const whitelist = FREE_MODEL_WHITELIST[providerId];
  if (!whitelist) return;
  for (const id of modelIds) {
    const idx = whitelist.indexOf(id);
    if (idx >= 0) whitelist.splice(idx, 1);
  }
}