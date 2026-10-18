/**
 * Model Discovery Service — enhanced with free-model detection.
 *
 * Differences from the original Node.js version:
 *  - No provider abstraction layer; uses direct fetch per platform.
 *  - Free-model detection: OpenRouter `pricing` field + platform heuristics.
 *  - No context-window or vision extraction (upstream doesn't advertise).
 */

import { decryptKeyValue } from "../db/mod.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveredModel {
  id: string;
  platform: string;
  displayName: string;
  enabled: boolean;
  /** True when the upstream advertises zero cost (OpenRouter pricing, or platform heuristic). */
  isFree?: boolean;
  /** Human-readable price hint, e.g. "free", "$0.60/M in $3/M out". */
  priceNote?: string;
  /** Approximate context window in tokens (from OpenRouter context_length, etc.). */
  contextWindow?: number;
  supportedFeatures?: string[];
  discoveredAt: number;
}

export interface ProviderTestResult {
  platform: string;
  status: "ok" | "error" | "pending";
  message: string;
  responseTime: number;
  testedAt: number;
}

// ── Platform base URLs ────────────────────────────────────────────────────────

const BASE_URLS: Record<string, string> = {
  agnes: "https://apihub.agnes-ai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  radeon: "https://cloud.radeon.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  kilo: "https://api.kilo.com/v1",
  sail: "https://api.sailresearch.com/v1",
  openai: "https://api.openai.com/v1",
  ovh: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  ollama: "https://ollama.com/v1",
  mistral: "https://api.mistral.ai/v1",
  cloudflare: "https://api.cloudflare.com/client/v4",
  cohere: "https://api.cohere.com/v1",
  kilo: "https://api.kilo.com/api/gateway",
  siliconflow: "https://api.siliconflow.cn/v1",
  zai: "https://api.z.ai/api/paas/v4",
};

// ── Free-model heuristics ─────────────────────────────────────────────────────

/**
 * Known free model ID patterns per platform.
 * Matched against the model id (lowercase, split on non-alphanums).
 */
const FREE_PATTERNS: Record<string, RegExp[]> = {
  // OpenRouter: :free suffix is the canonical marker (after split, token is "free")
  openrouter: [/^free$/],
  // Groq: no pattern-based detection; use whitelist only
  groq: [],
};

/**
 * Models that are known to be paid on specific platforms (negatives).
 * These override heuristic positives.
 */
const PAID_PATTERNS: Record<string, RegExp[]> = {
  // Zhipu: most models are paid; only specific ones are free
  zhipu: [/glm[-_]4[-_]5[^ ]*|glm[-_]4[-_]6[^ ]*/i],
};

/**
 * Per-platform list of known free model IDs (authoritative whitelist).
 * Updated periodically from provider docs / live probing.
 */
const KNOWN_FREE_MODELS: Record<string, Set<string>> = {
  // Source: https://github.com/mnfst/awesome-free-llm-apis (verified 2026-10)
  groq: new Set([
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-safeguard-20b",
    "meta-llama/llama-prompt-guard-2-86m",
    "meta-llama/llama-prompt-guard-2-22m",
  ]),
  // OpenRouter: :free suffix handled by FREE_PATTERNS
  openrouter: new Set(),
  // Zhipu AI free models (actual API IDs)
  zhipu: new Set([
    "glm-4.7",
    "glm-4.5",
    "glm-4.6v",
  ]),
  // Kilo Code free pool (auto-router)
  kilo: new Set([
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "stepfun/step-3.7-flash:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "cohere/north-mini-code:free",
    "openrouter/free",
    "tencent/hy3:free",
    "nvidia/nemotron-3.5-lightning:free",
    "liquid/lfm-2.5-2.6b:free",
    "kilo-auto/free",
    "inclusionai/ling-3.1-flash",
    "inclusionai/ling-3.0-flash-sante:free",
    "apodex/apodex-1.1-mini:free",
    "qwen/qwen3.8-27b:free",
    "dots-studio/dots-3-note-preview:free",
  ]),
  // SiliconFlow free models
  siliconflow: new Set([
    "Qwen/Qwen3-8B",
  ]),
};

/** Determine if a model is free based on pricing data + heuristics. */
function classifyFree(
  platform: string,
  modelRecord: Record<string, unknown>
): { isFree: boolean; priceNote: string | undefined } {
  // 0. Check known free whitelist first (authoritative, provider-specific)
  const modelId = String(modelRecord["id"] ?? modelRecord["name"] ?? "").toLowerCase();
  const whitelist = KNOWN_FREE_MODELS[platform];
  if (whitelist?.has(modelId)) {
    return { isFree: true, priceNote: "free" };
  }

  // 1. Check OpenRouter-style pricing field (strict zero check)
  const pricing = modelRecord["pricing"] as Record<string, unknown> | undefined;
  if (pricing) {
    const rawPrompt = pricing["prompt"];
    const rawCompletion = pricing["completion"];
    const prompt = parseFloat(String(rawPrompt ?? 0));
    const completion = parseFloat(String(rawCompletion ?? 0));
    // Strict zero check for pricing (no tolerance)
    if (!isNaN(prompt) && !isNaN(completion) && prompt === 0 && completion === 0) {
      return { isFree: true, priceNote: "free" };
    }
    const parts: string[] = [];
    if (!isNaN(prompt) && prompt > 0) parts.push(`$${prompt.toFixed(6)}/M in`);
    else if (!isNaN(prompt) && prompt === 0) parts.push("$0/M in");
    if (!isNaN(completion) && completion > 0) parts.push(`$${completion.toFixed(6)}/M out`);
    else if (!isNaN(completion) && completion === 0) parts.push("$0/M out");
    return { isFree: false, priceNote: parts.join(" ") || undefined };
  }

  // 2. Check model ID for :free suffix (OpenRouter convention)
  if (modelId.endsWith(":free")) {
    return { isFree: true, priceNote: "free" };
  }

  // 3. Platform-specific heuristics
  const patterns = FREE_PATTERNS[platform];
  if (patterns) {
    const tokens = modelId.split(/[^a-z0-9]+/);
    if (patterns.some((re) => tokens.some((t) => re.test(t)))) {
      // Check negative patterns first
      const negPatterns = PAID_PATTERNS[platform];
      const isPaid = negPatterns?.some((re) => re.test(modelId)) ?? false;
      if (!isPaid) {
        return { isFree: true, priceNote: "free (estimated)" };
      }
    }
  }

  // No pricing info and no heuristic match → unknown
  return { isFree: false, priceNote: undefined };
}

/** Extract context window from upstream model record. */
function extractContextWindow(record: Record<string, unknown>): number | undefined {
  for (const key of ["context_length", "context_window", "max_model_len", "max_context_length"]) {
    const val = record[key];
    if (typeof val === "number" && val > 0) return val;
  }
  return undefined;
}


// ── Cache ──────────────────────────────────────────────────────────────────────
/** TTL cache for discovery results to avoid repeated API calls */
const discoveryCache = new Map<string, { models: DiscoveredModel[]; timestamp: number }>();
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCachedDiscovery(platform: string): DiscoveredModel[] | null {
  const cached = discoveryCache.get(platform);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > DISCOVERY_TTL_MS) {
    discoveryCache.delete(platform);
    return null;
  }
  console.log(`[discover-cache] ${platform}: cache hit (${Math.round((Date.now() - cached.timestamp) / 1000)}s old)`);
  return cached.models;
}

function setCachedDiscovery(platform: string, models: DiscoveredModel[]): void {
  discoveryCache.set(platform, { models, timestamp: Date.now() });
  console.log(`[discover-cache] ${platform}: cached ${models.length} models`);
}

function clearDiscoveryCache(platform?: string): void {
  if (platform) {
    discoveryCache.delete(platform);
    console.log(`[discover-cache] ${platform}: cache cleared`);
  } else {
    discoveryCache.clear();
    console.log(`[discover-cache] all caches cleared`);
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export async function discoverModels(
  _db: unknown,
  platform: string,
  apiKey?: string,
  forceRefresh = false
): Promise<DiscoveredModel[]> {
  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = getCachedDiscovery(platform);
    if (cached) return cached;
  }

  const results: DiscoveredModel[] = [];

  try {
    const key = typeof apiKey === "string" ? apiKey : "";
    const baseUrl = BASE_URLS[platform] ?? `https://api.${platform}.com/v1`;
    const modelsUrl = baseUrl.replace(/\/$/, "") + "/models";

    const res = await fetch(modelsUrl, {
      headers: {
        "Authorization": key ? `Bearer ${key}` : "",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.log(`[discover] ${platform}: HTTP ${res.status}`);
      return [];
    }

    const raw = await res.json() as Record<string, unknown>;
    // OpenAI-style: { data: [...] }
    // Ollama-style: { models: [...] }
    const items = (raw["data"] ?? raw["models"] ?? []) as Record<string, unknown>[];

    for (const model of items) {
      const id = String(model["id"] ?? model["name"] ?? model["model"] ?? "");
      if (!id) continue;


const { isFree, priceNote } = classifyFree(platform, model);
      const contextWindow = extractContextWindow(model);

      results.push({
        id,
        platform,
        displayName: String(model["name"] ?? model["description"] ?? id),
        enabled: true,
        isFree,
        priceNote,
        contextWindow,
        discoveredAt: Date.now(),
      });
    }

    const freeCount = results.filter((m) => m.isFree).length;
    console.log(`[discover] ${platform}: found ${results.length} models (${freeCount} free)`);
    // Cache the results
    setCachedDiscovery(platform, results);
  } catch (err) {
    console.error(`[discover] ${platform}:`, err);
    // Return cached results if available, even if stale
    const stale = getCachedDiscovery(platform);
    if (stale) {
      console.log(`[discover-cache] ${platform}: returning stale cache after error`);
      return stale;
    }
  }

  return results;
}

// ── Provider Test ─────────────────────────────────────────────────────────────

export async function testProvider(
  _db: unknown,
  platform: string,
  model: string,
  apiKey?: string,
  maxTokens: number = 10
): Promise<ProviderTestResult> {
  const startTime = Date.now();

  try {
    let key: string | null = null;
    if (typeof apiKey === "string") {
      key = apiKey;
    } else if (apiKey && typeof apiKey === "object" && "encrypted_key" in apiKey) {
      key = await decryptKeyValue(apiKey as never);
    }
    if (!key) {
      return {
        platform, status: "error",
        message: "No enabled key found",
        responseTime: 0, testedAt: Date.now(),
      };
    }

    const baseUrl = BASE_URLS[platform] ?? `https://api.${platform}.com/v1`;
    const chatUrl = baseUrl.replace(/\/$/, "") + "/chat/completions";

    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const responseTime = Date.now() - startTime;

    if (!res.ok) {
      const error = await res.text();
      return {
        platform,
        status: "error",
        message: `${res.status}: ${error.slice(0, 100)}`,
        responseTime,
        testedAt: Date.now(),
      };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "(no content)";

    return {
      platform,
      status: "ok",
      message: `Response: ${content.slice(0, 50)}...`,
      responseTime,
      testedAt: Date.now(),
    };
  } catch (err) {
    const responseTime = Date.now() - startTime;
    return {
      platform,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      responseTime,
      testedAt: Date.now(),
    };
  }
}

// Updated: free model whitelist enhanced
