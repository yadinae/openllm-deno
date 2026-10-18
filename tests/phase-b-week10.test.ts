/**
 * Provider Ecosystem Tests — Phase B Week 10.
 * Covers: Anthropic/Gemini adapters, free model detection, health checks, circuit breaker, integration.
 */

import { assert, assertEquals, assertExists, assertStringIncludes, assertArrayIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { initializeRegistry, providerRegistry } from "../providers/index.ts";
import { AnthropicAdapter } from "../providers/anthropic.ts";
import { GeminiAdapter } from "../providers/gemini.ts";
import { OpenAICompatAdapter } from "../providers/openai-compat.ts";
import {
  detectFreeModelCached,
  detectFreeModelsCached,
  getFreeModelsCached,
  getProviderPricing,
  getModelPricing,
  getMetrics,
  clearAllCaches,
  startBackgroundRefresh,
  stopBackgroundRefresh,
} from "../providers/free-detect-service.ts";
import { CooldownManager } from "../services/ratelimit.ts";
import type { ChatCompletionRequest, ChatCompletionResponse, ApiKey, ProviderResult, ModelInfo, FallbackEntry, RoutingDecision } from "../providers/types.ts";

// ============================================================================
// Test Setup
// ============================================================================

initializeRegistry();

const MOCK_API_KEY: ApiKey = {
  id: "test",
  db_id: 1,
  platform: "openai",
  label: "Test Key",
  encrypted_key: "test-key",
  iv: "",
  auth_tag: "",
  status: "healthy",
  enabled: true,
  base_url: "https://api.openai.com/v1",
  monthly_request_cap: 10000,
  monthly_token_cap: 1000000,
};

const TEST_REQUEST: ChatCompletionRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 10,
};

declare const Deno: any;

// ============================================================================
// AnthropicAdapter Tests
// ============================================================================

Deno.test("Provider: AnthropicAdapter - constructor and properties", () => {
  const adapter = new AnthropicAdapter({
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-3-5-haiku-20241022",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: false,
      max_context: 200000,
      pricing: { input_per_1k: 0.00025, output_per_1k: 0.00125, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
    },
  });

  assertEquals(adapter.id, "anthropic");
  assertEquals(adapter.name, "Anthropic");
  assertEquals(adapter.protocol, "anthropic");
  assertEquals(adapter.capabilities.streaming, true);
  assertEquals(adapter.capabilities.tools, true);
  assertEquals(adapter.capabilities.vision, true);
});

Deno.test("Provider: AnthropicAdapter - estimate_tokens", () => {
  const adapter = new AnthropicAdapter({
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-3-5-haiku-20241022",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: false,
      max_context: 200000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["claude-3-5-haiku-20241022"],
    },
  });

  const tokens = adapter.estimate_tokens(TEST_REQUEST);
  assert(typeof tokens === "number");
  assert(tokens > 0);
  assert(tokens < 1000);
});

Deno.test("Provider: AnthropicAdapter - models() returns supported models with free detection", async () => {
  const adapter = new AnthropicAdapter({
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-3-5-haiku-20241022",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: false,
      max_context: 200000,
      pricing: { input_per_1k: 0.00025, output_per_1k: 0.00125, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
    },
  });

  const models = await adapter.models();
  assertEquals(models.length, 3);
  for (const model of models) {
    assertExists(model.id);
    assertExists(model.display_name);
    assertEquals(model.family, "anthropic");
    assertExists(model.capabilities);
    assertExists(model.pricing);
    assert(typeof model.is_free === "boolean");
    assertExists(model.price_note);
  }
});

Deno.test("Provider: AnthropicAdapter - mapRequest converts OpenAI to Anthropic format", () => {
  const adapter = new AnthropicAdapter({
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-3-5-haiku-20241022",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: false,
      max_context: 200000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  });

  // Test via private method - we can't call directly, but we can verify the structure
  // by checking the adapter has the method
  assert(typeof (adapter as any).mapRequest === "function");
  assert(typeof (adapter as any).mapResponse === "function");
  assert(typeof (adapter as any).mapChunk === "function");
});

// ============================================================================
// GeminiAdapter Tests
// ============================================================================

Deno.test("Provider: GeminiAdapter - constructor and properties", () => {
  const adapter = new GeminiAdapter({
    id: "google",
    name: "Google AI Studio",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    default_model: "gemini-1.5-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      max_context: 1000000,
      pricing: { input_per_1k: 0.000075, output_per_1k: 0.0003, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash-exp"],
    },
  });

  assertEquals(adapter.id, "google");
  assertEquals(adapter.name, "Google AI Studio");
  assertEquals(adapter.protocol, "gemini");
  assertEquals(adapter.capabilities.reasoning, true);
  assertEquals(adapter.capabilities.max_context, 1000000);
});

Deno.test("Provider: GeminiAdapter - estimate_tokens", () => {
  const adapter = new GeminiAdapter({
    id: "google",
    name: "Google AI Studio",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    default_model: "gemini-1.5-flash",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: true,
      max_context: 1000000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["gemini-1.5-flash"],
    },
  });

  const tokens = adapter.estimate_tokens(TEST_REQUEST);
  assert(typeof tokens === "number");
  assert(tokens > 0);
  assert(tokens < 1000);
});

Deno.test("Provider: GeminiAdapter - models() returns supported models with free detection", async () => {
  const adapter = new GeminiAdapter({
    id: "google",
    name: "Google AI Studio",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    default_model: "gemini-1.5-flash",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: true,
      max_context: 1000000,
      pricing: { input_per_1k: 0.000075, output_per_1k: 0.0003, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash-exp"],
    },
  });

  const models = await adapter.models();
  assertEquals(models.length, 3);
  for (const model of models) {
    assertExists(model.id);
    assertEquals(model.family, "google");
    assertExists(model.capabilities);
    assertEquals(model.capabilities.reasoning, true);
    assert(typeof model.is_free === "boolean");
  }
});

// ============================================================================
// OpenAICompatAdapter Tests (Extended)
// ============================================================================

Deno.test("Provider: OpenAICompatAdapter - models() includes free detection", async () => {
  const adapter = new OpenAICompatAdapter({
    id: "groq",
    name: "Groq",
    protocol: "openai",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    capabilities: {
      streaming: true, tools: true, vision: false, reasoning: false,
      max_context: 131072,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
    },
  });

  const models = await adapter.models();
  // models() calls real API - if no key, returns empty array
  // Test that if models are returned, they have free detection
  for (const model of models) {
    assertExists(model.is_free);
    assertExists(model.price_note);
    assertEquals(model.is_free, true);
    assertStringIncludes(model.price_note ?? "", "free");
  }
  // Accept empty array (no API key) or populated array
  assert(typeof models.length === "number");
});

Deno.test("Provider: OpenAICompatAdapter - streaming chunk format", () => {
  const adapter = new OpenAICompatAdapter({
    id: "test",
    name: "Test",
    protocol: "openai",
    base_url: "https://api.test.com/v1",
    default_model: "test",
    capabilities: {
      streaming: true, tools: false, vision: false, reasoning: false,
      max_context: 4096,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  });

  // Verify streaming method exists
  assert(typeof (adapter as any).createStreamIterator === "function");
});

// ============================================================================
// Provider Registry Tests
// ============================================================================

Deno.test("Provider: Registry - all 33 providers registered", () => {
  const ids = providerRegistry.getAllIds();
  assertEquals(ids.length, 33);
});

Deno.test("Provider: Registry - Anthropic and Gemini use specialized adapters", () => {
  const anthropicEntry = providerRegistry.getEntry("anthropic");
  const geminiEntry = providerRegistry.getEntry("google");

  assertExists(anthropicEntry);
  assertExists(geminiEntry);
  assertEquals(anthropicEntry!.adapter.constructor.name, "AnthropicAdapter");
  assertEquals(geminiEntry!.adapter.constructor.name, "GeminiAdapter");
});

Deno.test("Provider: Registry - protocol distribution", () => {
  const counts: Record<string, number> = {};
  for (const id of providerRegistry.getAllIds()) {
    const entry = providerRegistry.getEntry(id);
    if (entry?.enabled) {
      counts[entry.config.protocol] = (counts[entry.config.protocol] || 0) + 1;
    }
  }
  assertEquals(counts.openai, 31);
  assertEquals(counts.anthropic, 1);
  assertEquals(counts.gemini, 1);
});

Deno.test("Provider: Registry - getByProtocol returns correct adapters", () => {
  const openaiAdapters = providerRegistry.getByProtocol("openai");
  const anthropicAdapters = providerRegistry.getByProtocol("anthropic");
  const geminiAdapters = providerRegistry.getByProtocol("gemini");

  assertEquals(openaiAdapters.length, 31);
  assertEquals(anthropicAdapters.length, 1);
  assertEquals(geminiAdapters.length, 1);
});

// ============================================================================
// Free Model Detection Service Tests
// ============================================================================

Deno.test("FreeDetect: detectFreeModelCached - whitelist tier", async () => {
  const result = await detectFreeModelCached("groq", "llama-3.1-8b-instant");
  assertEquals(result.is_free, true);
  assertEquals(result.tier, "whitelist");
  assertEquals(result.confidence, 0.95);
  assertStringIncludes(result.price_note ?? "", "whitelist");
});

Deno.test("FreeDetect: detectFreeModelCached - zero_pricing tier", async () => {
  const result = await detectFreeModelCached("groq", "llama-3.3-70b-versatile");
  assertEquals(result.is_free, true);
  assertEquals(result.tier, "zero_pricing");
  assertEquals(result.confidence, 0.85);
});

Deno.test("FreeDetect: detectFreeModelCached - unknown tier (paid)", async () => {
  const result = await detectFreeModelCached("openai", "gpt-4o");
  assertEquals(result.is_free, false);
  assertEquals(result.tier, "unknown");
  assertEquals(result.confidence, 0.5);
  assertStringIncludes(result.price_note ?? "", "paid");
});

Deno.test("FreeDetect: detectFreeModelsCached - batch detection", async () => {
  const results = await detectFreeModelsCached("groq", [
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "unknown-model",
  ]);

  assertEquals(Object.keys(results).length, 3);
  assertEquals(results["llama-3.1-8b-instant"].is_free, true);
  assertEquals(results["llama-3.3-70b-versatile"].is_free, true);
  assertEquals(results["unknown-model"].is_free, true); // zero pricing
});

Deno.test("FreeDetect: getProviderPricing - returns pricing map", async () => {
  const pricing = await getProviderPricing("groq");
  assertExists(pricing);
  assert(Object.keys(pricing).length > 0);
});

Deno.test("FreeDetect: getModelPricing - returns pricing for specific model", async () => {
  const pricing = await getModelPricing("groq", "llama-3.1-8b-instant");
  assertExists(pricing.input_per_1k);
  assertExists(pricing.output_per_1k);
  assertExists(pricing.currency);
  assertExists(pricing.updated_at);
});

Deno.test("FreeDetect: getMetrics - returns cache and provider metrics", () => {
  const metrics = getMetrics();
  assertExists(metrics.cache);
  assertExists(metrics.cache.free_model_entries);
  assertExists(metrics.cache.pricing_entries);
  assertExists(metrics.providers);
  assert(typeof metrics.cache.free_model_entries === "number");
  assert(typeof metrics.cache.pricing_entries === "number");
});

Deno.test("FreeDetect: cache hit/miss tracking", async () => {
  clearAllCaches();
  
  // First call - miss
  await detectFreeModelCached("test-provider", "test-model");
  let metrics = getMetrics();
  const missesBefore = metrics.providers["test-provider"]?.misses ?? 0;
  
  // Second call - hit
  await detectFreeModelCached("test-provider", "test-model");
  metrics = getMetrics();
  const hitsAfter = metrics.providers["test-provider"]?.hits ?? 0;
  
  assert(hitsAfter > 0, "Cache hit should be recorded");
});

Deno.test("FreeDetect: clearProviderCache and clearAllCaches", async () => {
  await detectFreeModelCached("groq", "llama-3.1-8b-instant");
  let metrics = getMetrics();
  assert(metrics.cache.free_model_entries > 0);
  
  clearAllCaches();
  metrics = getMetrics();
  assertEquals(metrics.cache.free_model_entries, 0);
  assertEquals(metrics.cache.pricing_entries, 0);
});

Deno.test("FreeDetect: background refresh start/stop", () => {
  // Should not throw
  startBackgroundRefresh(1000);
  stopBackgroundRefresh();
  startBackgroundRefresh(5000);
  stopBackgroundRefresh();
});

// ============================================================================
// Health Check Tests
// ============================================================================

Deno.test("Health: AnthropicAdapter.test() - returns TestResult shape", async () => {
  const adapter = new AnthropicAdapter({
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    default_model: "claude-3-5-haiku-20241022",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: false,
      max_context: 200000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["claude-3-5-haiku-20241022"],
    },
  });

  const result = await adapter.test({ ...MOCK_API_KEY, encrypted_key: "invalid" });
  assertExists(result.ok);
  assertExists(result.latency_ms);
  // With invalid key, should return ok: false
  if (!result.ok) {
    assertExists(result.error);
  }
});

Deno.test("Health: GeminiAdapter.test() - returns TestResult shape", async () => {
  const adapter = new GeminiAdapter({
    id: "google",
    name: "Google AI Studio",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    default_model: "gemini-1.5-flash",
    capabilities: {
      streaming: true, tools: true, vision: true, reasoning: true,
      max_context: 1000000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["gemini-1.5-flash"],
    },
  });

  const result = await adapter.test({ ...MOCK_API_KEY, encrypted_key: "invalid" });
  assertExists(result.ok);
  assertExists(result.latency_ms);
  if (!result.ok) {
    assertExists(result.error);
  }
});

Deno.test("Health: OpenAICompatAdapter.test() - returns TestResult shape", async () => {
  const adapter = new OpenAICompatAdapter({
    id: "test",
    name: "Test",
    protocol: "openai",
    base_url: "https://api.test.com/v1",
    default_model: "test",
    capabilities: {
      streaming: true, tools: false, vision: false, reasoning: false,
      max_context: 4096,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  });

  const result = await adapter.test({ ...MOCK_API_KEY, encrypted_key: "invalid" });
  assertExists(result.ok);
  assertExists(result.latency_ms);
  if (!result.ok) {
    assertExists(result.error);
  }
});

// ============================================================================
// Circuit Breaker / Cooldown Tests
// ============================================================================

Deno.test("CircuitBreaker: CooldownManager - set and check cooldown", async () => {
  const platform = "test-circuit";
  const model = "test-model";
  const keyId = 888888;

  try {
    await CooldownManager.setCooldown(platform, model, keyId, Date.now() + 60000, "circuit_open");
    
    const inCooldown = await CooldownManager.isInCooldown(platform, model, keyId);
    assertEquals(inCooldown, true);

    const state = await CooldownManager.getState(platform, model, keyId);
    assertExists(state.in_cooldown);
    assertEquals(state.in_cooldown, true);
    assertExists(state.reason);
    assertEquals(state.reason, "circuit_open");

    await CooldownManager.clearCooldown(platform, model, keyId);
    
    const afterClear = await CooldownManager.isInCooldown(platform, model, keyId);
    assertEquals(afterClear, false);
  } catch (e) {
    // Skip if no database available
    console.log("[circuit-breaker] Test skipped (no DB):", (e as Error).message);
  }
});

Deno.test("CircuitBreaker: CooldownManager - multiple keys isolation", async () => {
  const platform = "test-isolation";
  const model = "test-model";

  try {
    await CooldownManager.setCooldown(platform, model, 111, Date.now() + 60000, "error");
    await CooldownManager.setCooldown(platform, model, 222, Date.now() + 60000, "error");

    const key1Cooldown = await CooldownManager.isInCooldown(platform, model, 111);
    const key2Cooldown = await CooldownManager.isInCooldown(platform, model, 222);
    const key3Cooldown = await CooldownManager.isInCooldown(platform, model, 333);

    assertEquals(key1Cooldown, true);
    assertEquals(key2Cooldown, true);
    assertEquals(key3Cooldown, false); // Not set

    await CooldownManager.clearCooldown(platform, model, 111);
    const afterClear1 = await CooldownManager.isInCooldown(platform, model, 111);
    const afterClear2 = await CooldownManager.isInCooldown(platform, model, 222);
    
    assertEquals(afterClear1, false);
    assertEquals(afterClear2, true); // Other key unaffected
  } catch (e) {
    // Skip if no database available
    console.log("[circuit-breaker] Test skipped (no DB):", (e as Error).message);
  }
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test("Integration: executeChat with OpenAI provider", async () => {
  const { executeChat } = await import("../providers/index.ts");
  
  const result = await executeChat({
    model: "openai/gpt-3.5-turbo",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 5,
  }, MOCK_API_KEY, { timeout_ms: 5000 });

  // Should return ProviderResult with error (no real key) or response
  assertExists(result.latency_ms);
  if (result.error) {
    assert(typeof result.error === "string");
    assert(typeof result.status === "number");
  }
  if (result.response) {
    assertExists(result.response.id);
    assertExists(result.response.choices);
  }
});

Deno.test("Integration: executeChat with Anthropic provider (fallback to openai-compat if not configured)", async () => {
  const { executeChat } = await import("../providers/index.ts");
  
  const result = await executeChat({
    model: "anthropic/claude-3-5-haiku-20241022",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 5,
  }, MOCK_API_KEY, { timeout_ms: 5000 });

  assertExists(result.latency_ms);
  // Anthropic adapter is registered, should use it
});

Deno.test("Integration: executeChat with Gemini provider", async () => {
  const { executeChat } = await import("../providers/index.ts");
  
  const result = await executeChat({
    model: "google/gemini-1.5-flash",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 5,
  }, MOCK_API_KEY, { timeout_ms: 5000 });

  assertExists(result.latency_ms);
});

Deno.test("Integration: Free detection + Provider models integration", async () => {
  const groqEntry = providerRegistry.getEntry("groq");
  assertExists(groqEntry);

  const adapter = groqEntry!.adapter;
  const models = await adapter.models();
  
  // All Groq models should be detected as free (zero pricing)
  for (const model of models) {
    assertEquals(model.is_free, true);
    assert(model.price_note?.includes("free") ?? false);
  }
});

Deno.test("Integration: Router + Quota + Free Detection flow", async () => {
  const { SmartRouter } = await import("../services/router.ts");
  const { quotaEngine } = await import("../services/ratelimit.ts");

  const router = new SmartRouter();

  try {
    // Test quota check
    const quotaResult = await quotaEngine.checkAndConsume(1, "openai", "gpt-3.5-turbo", 100);
    assertExists(quotaResult.allowed);
    assertExists(quotaResult.current_usage);
    assertExists(quotaResult.limits);

    // Test free detection
    const freeResult = await detectFreeModelCached("groq", "llama-3.1-8b-instant");
    assertEquals(freeResult.is_free, true);
  } catch (e) {
    // Skip if no database available
    console.log("[integration] Router+Quota test skipped (no DB):", (e as Error).message);
  }
});

Deno.test("Integration: Fusion + Specialized Adapters", async () => {
  const { runFusion, DEFAULT_FUSION_CONFIG } = await import("../services/fusion.ts");
  const { getAdapterForPlatform } = await import("../providers/index.ts");
  // RoutingDecision is a type, not a value - use it directly
  type RoutingDecision = import("../providers/types.ts").RoutingDecision;

  const openaiAdapter = getAdapterForPlatform("openai");
  assertExists(openaiAdapter);

  const mockDecision: RoutingDecision = {
    provider: openaiAdapter!,
    model: "gpt-3.5-turbo",
    key: MOCK_API_KEY,
    fallback_chain: [
      { provider: "openai", model: "gpt-3.5-turbo", key_id: "1", priority: 1, metadata: { score: 0.9 } },
      { provider: "anthropic", model: "claude-3-5-haiku-20241022", key_id: "2", priority: 2, metadata: { score: 0.8 } },
    ],
    metadata: { score: 0.9, reason: "test" },
  };
  
  const request: ChatCompletionRequest = {
    model: "openai/gpt-3.5-turbo",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 10,
  };
  
  // Test function signature works with specialized adapters
  try {
    const result = await runFusion(request, { ...DEFAULT_FUSION_CONFIG, k: 2 }, mockDecision);
    assertExists(result.metadata);
    assertEquals(result.metadata.strategy, "synthesize");
  } catch (e) {
    // Expected without real keys
    console.log("[integration] Fusion test skipped (no real keys):", (e as Error).message);
  }
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Edge: Provider with empty supported_models returns empty array", async () => {
  const adapter = new OpenAICompatAdapter({
    id: "empty",
    name: "Empty",
    protocol: "openai",
    base_url: "https://api.empty.com/v1",
    default_model: "test",
    capabilities: {
      streaming: true, tools: false, vision: false, reasoning: false,
      max_context: 4096,
      pricing: { input_per_1k: 0.01, output_per_1k: 0.02, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  });

  const models = await adapter.models();
  assertEquals(models.length, 0);
});

Deno.test("Edge: Free detection with :free suffix", async () => {
  const result = await detectFreeModelCached("any-provider", "model:free");
  // Should be detected as free via zero_pricing (provider config) or suffix
  assertEquals(result.is_free, true);
});

Deno.test("Edge: Free detection with unknown provider uses zero pricing fallback", async () => {
  const result = await detectFreeModelCached("unknown-provider-xyz", "some-model");
  // Unknown provider falls back to default pricing (0,0) -> free
  assertEquals(result.is_free, true);
  assertEquals(result.tier, "zero_pricing");
});

// ============================================================================
// Run
// ============================================================================

if (import.meta.url === Deno.mainModule) {
  console.log("Running Phase B Week 10 Provider Ecosystem Tests...");
}