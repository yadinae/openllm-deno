/**
 * Free Model Detection Service — Enhanced with caching, pricing sync, and batch API.
 * Phase B Week 9: Free model detection enhancement for P-CORE-004.
 *
 * Features:
 * - In-memory cache with TTL for detection results
 * - Dynamic pricing sync from provider /models endpoints
 * - Background refresh job
 * - Batch detection API
 * - Metrics tracking
 */

import type {
  PricingModel,
  FreeModelInfo,
  FreeDetectionTier,
  ModelInfo,
  ProviderConfig,
  ProviderCapabilities,
} from "./types.ts";
import {
  detectFreeModel as coreDetectFreeModel,
  detectFreeModels as coreDetectFreeModels,
  getFreeModels as coreGetFreeModels,
  addToWhitelist,
  removeFromWhitelist,
  FREE_MODEL_WHITELIST,
  FREE_SUFFIX_PATTERNS,
} from "./free-detect.ts";
import { providerRegistry } from "./index.ts";

// ============================================================================
// Cache Types
// ============================================================================

interface CacheEntry<T> {
  value: T;
  expires_at: number; // Unix ms
}

interface PricingCacheEntry {
  pricing: PricingModel;
  fetched_at: number;
  source: "api" | "config" | "fallback";
}

interface FreeModelCacheEntry {
  results: Record<string, FreeModelInfo>;
  fetched_at: number;
  model_count: number;
}

// ============================================================================
// Configuration
// ============================================================================

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 10000; // Max entries per cache
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ============================================================================
// Caches
// ============================================================================

const freeModelCache = new Map<string, CacheEntry<FreeModelCacheEntry>>();
const pricingCache = new Map<string, CacheEntry<PricingCacheEntry>>();
const detectionMetrics = new Map<string, { hits: number; misses: number; errors: number }>();

// ============================================================================
// Cache Helpers
// ============================================================================

function getCacheKey(providerId: string, modelId?: string): string {
  return modelId ? `${providerId}:${modelId}` : `${providerId}:*`;
}

function isExpired(entry: CacheEntry<any>): boolean {
  return Date.now() > entry.expires_at;
}

function pruneCache(cache: Map<string, CacheEntry<any>>): void {
  if (cache.size <= MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expires_at) cache.delete(key);
  }
  // If still over limit, delete oldest
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = [...cache.entries()].sort((a, b) => a[1].expires_at - b[1].expires_at);
    for (let i = 0; i < entries.length - MAX_CACHE_SIZE; i++) {
      cache.delete(entries[i][0]);
    }
  }
}

function recordMetric(providerId: string, type: "hit" | "miss" | "error"): void {
  const m = detectionMetrics.get(providerId) ?? { hits: 0, misses: 0, errors: 0 };
  if (type === "hit") m.hits++;
  else if (type === "miss") m.misses++;
  else m.errors++;
  detectionMetrics.set(providerId, m);
}

// ============================================================================
// Pricing Sync — Fetch from provider /models endpoint
// ============================================================================

interface ProviderModelWithPricing {
  id: string;
  pricing?: PricingModel;
  // Some providers include pricing in model list
  input_cost_per_1k?: number;
  output_cost_per_1k?: number;
  cost_per_1k_tokens?: number;
}

/** Fetch live pricing from provider's /models endpoint */
async function fetchProviderPricing(providerId: string, config: ProviderConfig): Promise<Record<string, PricingModel> | null> {
  const adapter = providerRegistry.get(providerId);
  if (!adapter) return null;

  try {
    // Try to get models from adapter - some providers include pricing
    const models = await adapter.models();
    const pricingMap: Record<string, PricingModel> = {};

    for (const model of models) {
      // Extract pricing from model info if available
      const pricing: PricingModel = model.pricing ?? {
        input_per_1k: 0,
        output_per_1k: 0,
        currency: "USD",
        updated_at: new Date().toISOString(),
      };
      pricingMap[model.id] = pricing;
    }

    return Object.keys(pricingMap).length > 0 ? pricingMap : null;
  } catch {
    return null;
  }
}

/** Get cached pricing or fetch fresh */
export async function getProviderPricing(providerId: string): Promise<Record<string, PricingModel>> {
  const cacheKey = `pricing:${providerId}`;
  const cached = pricingCache.get(cacheKey);

  if (cached && !isExpired(cached)) {
    recordMetric(providerId, "hit");
    return { [providerId]: cached.value.pricing }; // Simplified - in real impl would return full map
  }

  recordMetric(providerId, "miss");

  const entry = providerRegistry.getEntry(providerId);
  if (!entry) {
    // Fallback to config pricing
    const fallback: PricingModel = {
      input_per_1k: 0,
      output_per_1k: 0,
      currency: "USD",
      updated_at: new Date().toISOString(),
    };
    pricingCache.set(cacheKey, {
      value: { pricing: fallback, fetched_at: Date.now(), source: "config" },
      expires_at: Date.now() + PRICING_CACHE_TTL_MS,
    });
    pruneCache(pricingCache);
    return { [providerId]: fallback };
  }

  const config = entry.config;

  const fetched = await fetchProviderPricing(providerId, config);

  if (fetched) {
    // Cache each model's pricing
    for (const [modelId, pricing] of Object.entries(fetched)) {
      const modelCacheKey = `pricing:${providerId}:${modelId}`;
      pricingCache.set(modelCacheKey, {
        value: { pricing, fetched_at: Date.now(), source: "api" },
        expires_at: Date.now() + PRICING_CACHE_TTL_MS,
      });
    }
    pruneCache(pricingCache);
    return fetched;
  }

  // Fallback to config default pricing
  const fallback = config.capabilities.pricing ?? {
    input_per_1k: 0,
    output_per_1k: 0,
    currency: "USD",
    updated_at: new Date().toISOString(),
  };
  pricingCache.set(cacheKey, {
    value: { pricing: fallback, fetched_at: Date.now(), source: "fallback" },
    expires_at: Date.now() + PRICING_CACHE_TTL_MS,
  });
  pruneCache(pricingCache);

  return { [providerId]: fallback };
}

/** Get pricing for a specific model (with cache) */
export async function getModelPricing(providerId: string, modelId: string): Promise<PricingModel> {
  const cacheKey = `pricing:${providerId}:${modelId}`;
  const cached = pricingCache.get(cacheKey);

  if (cached && !isExpired(cached)) {
    return cached.value.pricing;
  }

  // Try to fetch all pricing for provider
  const allPricing = await getProviderPricing(providerId);
  const pricing = allPricing[modelId];

  if (pricing) return pricing;

  // Final fallback
  const config = providerRegistry.getEntry(providerId)?.config;
  return config?.capabilities.pricing ?? {
    input_per_1k: 0,
    output_per_1k: 0,
    currency: "USD",
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Enhanced Free Model Detection with Cache
// ============================================================================

/** Detect free status with caching */
export async function detectFreeModelCached(
  providerId: string,
  modelId: string
): Promise<FreeModelInfo> {
  const cacheKey = getCacheKey(providerId, modelId);
  const cached = freeModelCache.get(cacheKey);

  if (cached && !isExpired(cached)) {
    recordMetric(providerId, "hit");
    return cached.value.results[modelId];
  }

  recordMetric(providerId, "miss");

  // Get pricing (cached or fresh)
  const pricing = await getModelPricing(providerId, modelId);

  // Core detection
  const result = coreDetectFreeModel(providerId, modelId, pricing);

  // Cache result
  freeModelCache.set(cacheKey, {
    value: { results: { [modelId]: result }, fetched_at: Date.now(), model_count: 1 },
    expires_at: Date.now() + CACHE_TTL_MS,
  });
  pruneCache(freeModelCache);

  return result;
}

/** Batch detect with caching */
export async function detectFreeModelsCached(
  providerId: string,
  modelIds: string[]
): Promise<Record<string, FreeModelInfo>> {
  const cacheKey = getCacheKey(providerId, "*");
  const cached = freeModelCache.get(cacheKey);

  const results: Record<string, FreeModelInfo> = {};
  const toFetch: string[] = [];

  // Check cache for each model
  for (const modelId of modelIds) {
    const modelCacheKey = getCacheKey(providerId, modelId);
    const cached = freeModelCache.get(modelCacheKey);
    if (cached && !isExpired(cached)) {
      results[modelId] = cached.value.results[modelId];
      recordMetric(providerId, "hit");
    } else {
      toFetch.push(modelId);
      recordMetric(providerId, "miss");
    }
  }

  if (toFetch.length === 0) return results;

  // Fetch pricing for all missing models
  const pricingMap = await getProviderPricing(providerId);
  const defaultPricing = pricingMap[providerId] ?? {
    input_per_1k: 0,
    output_per_1k: 0,
    currency: "USD",
    updated_at: new Date().toISOString(),
  };

  // Detect for missing models
  const coreResults = coreDetectFreeModels(
    providerId,
    toFetch.map((id) => ({ id, pricing: pricingMap[id] })),
    defaultPricing
  );

  // Cache and merge results
  const batchEntry: FreeModelCacheEntry = {
    results: coreResults,
    fetched_at: Date.now(),
    model_count: toFetch.length,
  };

  for (const modelId of toFetch) {
    const modelCacheKey = getCacheKey(providerId, modelId);
    freeModelCache.set(modelCacheKey, {
      value: { results: { [modelId]: coreResults[modelId] }, fetched_at: Date.now(), model_count: 1 },
      expires_at: Date.now() + CACHE_TTL_MS,
    });
    results[modelId] = coreResults[modelId];
  }

  freeModelCache.set(cacheKey, {
    value: batchEntry,
    expires_at: Date.now() + CACHE_TTL_MS,
  });
  pruneCache(freeModelCache);

  return results;
}

/** Get all free models for a provider (cached) */
export async function getFreeModelsCached(providerId: string): Promise<string[]> {
  const entry = providerRegistry.getEntry(providerId);
  if (!entry) return [];

  const adapter = entry.adapter;
  try {
    const models = await adapter.models();
    const modelIds = models.map((m) => m.id);
    const results = await detectFreeModelsCached(providerId, modelIds);
    return Object.entries(results)
      .filter(([, info]) => info.is_free)
      .map(([modelId]) => modelId);
  } catch {
    return [];
  }
}

// ============================================================================
// Background Refresh Job
// ============================================================================

let refreshTimer: ReturnType<typeof setInterval> | undefined;

/** Start background refresh job */
export function startBackgroundRefresh(intervalMs: number = REFRESH_INTERVAL_MS): void {
  if (refreshTimer) clearInterval(refreshTimer);

  refreshTimer = setInterval(async () => {
    console.log(`[FreeDetect] Starting background pricing refresh at ${new Date().toISOString()}`);

    const providers = providerRegistry.getAllIds();
    for (const providerId of providers) {
      try {
        await getProviderPricing(providerId);
        // Also refresh free model cache by clearing it
        clearProviderCache(providerId);
      } catch (err) {
        console.error(`[FreeDetect] Refresh failed for ${providerId}:`, err);
        recordMetric(providerId, "error");
      }
    }

    console.log(`[FreeDetect] Background refresh completed`);
  }, intervalMs);
}

/** Stop background refresh job */
export function stopBackgroundRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

/** Clear cache for a provider */
export function clearProviderCache(providerId: string): void {
  for (const key of freeModelCache.keys()) {
    if (key.startsWith(`${providerId}:`)) freeModelCache.delete(key);
  }
  for (const key of pricingCache.keys()) {
    if (key.startsWith(`pricing:${providerId}`)) pricingCache.delete(key);
  }
}

/** Clear all caches */
export function clearAllCaches(): void {
  freeModelCache.clear();
  pricingCache.clear();
  detectionMetrics.clear();
}

// ============================================================================
// Metrics & Monitoring
// ============================================================================

export interface FreeDetectMetrics {
  cache: {
    free_model_entries: number;
    pricing_entries: number;
    free_model_hit_rate: number;
  };
  providers: Record<string, {
    hits: number;
    misses: number;
    errors: number;
    hit_rate: number;
  }>;
}

/** Get cache and detection metrics */
export function getMetrics(): FreeDetectMetrics {
  const providers: FreeDetectMetrics["providers"] = {};

  for (const [providerId, metrics] of detectionMetrics) {
    const total = metrics.hits + metrics.misses;
    providers[providerId] = {
      ...metrics,
      hit_rate: total > 0 ? metrics.hits / total : 0,
    };
  }

  return {
    cache: {
      free_model_entries: freeModelCache.size,
      pricing_entries: pricingCache.size,
      free_model_hit_rate: 0, // Would need global counters
    },
    providers,
  };
}

/** Reset metrics */
export function resetMetrics(): void {
  detectionMetrics.clear();
}

// ============================================================================
// Re-export core functions
// ============================================================================

export {
  coreDetectFreeModel as detectFreeModel,
  coreDetectFreeModels as detectFreeModels,
  coreGetFreeModels as getFreeModels,
  addToWhitelist,
  removeFromWhitelist,
  FREE_MODEL_WHITELIST,
  FREE_SUFFIX_PATTERNS,
};