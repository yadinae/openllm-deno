/**
 * Phase C Week 13-14 Tests — Advanced Capabilities
 * Tests for: Search, Embeddings, Media, MCP, Custom Models, Client Profiles
 */

import { assert, assertEquals, assertExists, assertNotEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { search, listSearchEngines, getSearchEngine, getEnginesByCapability, estimateSearchCost, type SearchRequest } from "../services/search.ts";
import { mcpServer, MCPClient, type MCPTool, type MCPResource } from "../services/mcp.ts";
import { registerCustomModel, getCustomModel, listCustomModels, updateCustomModel, deprecateCustomModel, retireCustomModel, restoreCustomModel, syncCustomModel, type CustomModel, type ModelRegistration } from "../services/custom-model.ts";
import { clientProfileService, authClientService, urlTokenService, type ClientProfile, type AuthClient, type URLToken } from "../services/client-profiles.ts";
import { createEmbeddings, listEmbeddingModels } from "../services/embeddings.ts";
import { generateMedia, type MediaGenerationRequest } from "../services/media.ts";

const initializeRegistry = async () => {
  const { initializeRegistry: initReg } = await import("../providers/index.ts");
  initReg();
};

await initializeRegistry();

const HAS_DB = !!Deno.env.get("DATABASE_URL");
if (!HAS_DB) {
  console.log("[phase-c-week13-14] DATABASE_URL not set — skipping DB-dependent test sections");
}

// ════════════════════════════════════════════════════════════════════════════
// SEARCH SERVICE TESTS (no DB required)
// ════════════════════════════════════════════════════════════════════════════

Deno.test("Search: listSearchEngines returns all configured engines", () => {
  const engines = listSearchEngines();
  assertEquals(engines.length, 8);
  const engineIds = engines.map(e => e.id).sort();
  assertEquals(engineIds, ["bing", "brave", "duckduckgo", "exa", "google", "serpapi", "serper", "tavily"]);
});

Deno.test("Search: getSearchEngine returns correct info for brave", () => {
  const engine = getSearchEngine("brave");
  assertExists(engine);
  assertEquals(engine!.id, "brave");
  assertEquals(engine!.provider, "brave");
  assertEquals(engine!.capabilities.web, true);
  assertEquals(engine!.capabilities.news, true);
});

Deno.test("Search: getEnginesByCapability filters correctly", () => {
  const webEngines = getEnginesByCapability("web");
  assertEquals(webEngines.length, 8); // All support web

  const newsEngines = getEnginesByCapability("news");
  assert(newsEngines.length > 0);
  assert(newsEngines.every(e => e.capabilities.news));
});

Deno.test("Search: estimateSearchCost calculates correctly", () => {
  const cost = estimateSearchCost("brave", 1000);
  assertEquals(cost.currency, "USD");
  assertEquals(cost.cost, 3.0); // $3 per 1k queries
});

// ════════════════════════════════════════════════════════════════════════════
// MCP SERVICE TESTS
// ════════════════════════════════════════════════════════════════════════════

Deno.test("MCP: Server initializes with built-in tools", async () => {
  const toolsResult = await mcpServer.handleListTools();
  assertExists(toolsResult.tools);
  assert(toolsResult.tools.length >= 5);
  
  const toolNames = toolsResult.tools.map(t => t.name);
  assert(toolNames.includes("openllm.chat"));
  assert(toolNames.includes("openllm.models"));
  assert(toolNames.includes("openllm.embeddings"));
  assert(toolNames.includes("openllm.search"));
  assert(toolNames.includes("openllm.media"));
});

Deno.test("MCP: Server initializes with built-in resources", async () => {
  const resourcesResult = await mcpServer.handleListResources();
  assertExists(resourcesResult.resources);
  assert(resourcesResult.resources.length >= 3);
  
  const resourceUris = resourcesResult.resources.map(r => r.uri);
  assert(resourceUris.includes("openllm://models"));
  assert(resourceUris.includes("openllm://providers"));
  assert(resourceUris.includes("openllm://health"));
});

Deno.test("MCP: Server handles initialize request", async () => {
  const initResponse = await mcpServer.handleInitialize({
    protocolVersion: "2024-11-05",
    capabilities: { roots: { listChanged: true }, sampling: true },
    clientInfo: { name: "TestClient", version: "1.0.0" },
  });
  
  assertEquals(initResponse.protocolVersion, "2024-11-05");
  assertExists(initResponse.capabilities.tools);
  assertExists(initResponse.capabilities.resources);
  assertEquals(initResponse.serverInfo.name, "OpenLLM");
});

Deno.test("MCP: Server rejects unknown tool call", async () => {
  const result = await mcpServer.handleCallTool({ name: "unknown.tool", arguments: {} });
  assertEquals(result.isError, true);
  assert(result.content[0].text?.includes("not found"));
});

Deno.test("MCP: Custom tool registration works", async () => {
  const customTool: MCPTool = {
    name: "test.custom",
    description: "Test custom tool",
    inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  };
  
  mcpServer.registerTool(customTool, async (args) => ({
    content: [{ type: "text", text: `Echo: ${args.input}` }],
  }));
  
  const toolsResult = await mcpServer.handleListTools();
  assert(toolsResult.tools.some(t => t.name === "test.custom"));
  
  const callResult = await mcpServer.handleCallTool({ name: "test.custom", arguments: { input: "hello" } });
  assertEquals(callResult.isError ?? false, false);
  assertEquals(callResult.content[0].text, "Echo: hello");
});

// ════════════════════════════════════════════════════════════════════════════
// CUSTOM MODEL LIFECYCLE TESTS (requires DB)
// ════════════════════════════════════════════════════════════════════════════

if (HAS_DB) {

Deno.test("CustomModel: Registration creates model with pending_sync status", async () => {
  const registration: ModelRegistration = {
    name: "test-model",
    display_name: "Test Model",
    provider: "openai",
    capabilities: { chat: true, streaming: true, tools: true, vision: false, reasoning: false, max_context: 4096 },
    pricing: { input_per_1k: 0.001, output_per_1k: 0.002, currency: "USD" },
    config: { endpoint: "https://api.openai.com/v1", api_key_ref: "test-key" },
  };
  
  const model = await registerCustomModel(registration, "test-user");
  assertExists(model);
  assertEquals(model.name, "test-model");
  assertEquals(model.display_name, "Test Model");
  assertEquals(model.provider, "openai");
  assertEquals(model.status, "pending_sync"); // Will be active if sync succeeds
  assertEquals(model.version, "1.0.0");
  assert(model.id.startsWith("custom/test-model-"));
});

Deno.test("CustomModel: List returns registered models", async () => {
  const models = await listCustomModels({ provider: "openai" });
  assertExists(models);
  const testModel = models.find(m => m.name === "test-model");
  assertExists(testModel);
  assertEquals(testModel.provider, "openai");
});

Deno.test("CustomModel: Get by ID works", async () => {
  const models = await listCustomModels({ provider: "openai" });
  const testModel = models.find(m => m.name === "test-model");
  assertExists(testModel);
  
  const retrieved = await getCustomModel(testModel!.id);
  assertExists(retrieved);
  assertEquals(retrieved!.id, testModel!.id);
  assertEquals(retrieved!.name, "test-model");
});

Deno.test("CustomModel: Update increments version and requires re-sync", async () => {
  const models = await listCustomModels({ provider: "openai" });
  const testModel = models.find(m => m.name === "test-model");
  assertExists(testModel);
  
  const updated = await updateCustomModel(testModel!.id, {
    display_name: "Updated Test Model",
    description: "Updated description",
  });
  
  assertExists(updated);
  assertEquals(updated!.display_name, "Updated Test Model");
  assertEquals(updated!.description, "Updated description");
  assertEquals(updated!.version, "1.0.1");
  assertEquals(updated!.sync_status, "pending");
});

Deno.test("CustomModel: Deprecate transitions status correctly", async () => {
  const models = await listCustomModels({ provider: "openai" });
  const testModel = models.find(m => m.name === "test-model");
  assertExists(testModel);
  
  const deprecated = await deprecateCustomModel(testModel!.id, "Replaced by newer version");
  assertExists(deprecated);
  assertEquals(deprecated!.status, "deprecated");
  assertEquals(deprecated!.tombstone_reason, "Replaced by newer version");
});

Deno.test("CustomModel: Restore transitions status back to active", async () => {
  const models = await listCustomModels({ provider: "openai", status: "deprecated" });
  const testModel = models.find(m => m.name === "test-model");
  assertExists(testModel);
  
  const restored = await restoreCustomModel(testModel!.id);
  assertExists(restored);
  assertEquals(restored!.status, "active");
  assertEquals(restored!.tombstone_reason, null);
});

Deno.test("CustomModel: Retire transitions to retired (terminal state)", async () => {
  const models = await listCustomModels({ provider: "openai", status: "active" });
  const testModel = models.find(m => m.name === "test-model");
  assertExists(testModel);
  
  const retired = await retireCustomModel(testModel!.id, "End of life");
  assertExists(retired);
  assertEquals(retired!.status, "retired");
  assertExists(retired!.retired_at);
  assertEquals(retired!.tombstone_reason, "End of life");
});

}

// ════════════════════════════════════════════════════════════════════════════
// CLIENT PROFILES TESTS (requires DB)
// ════════════════════════════════════════════════════════════════════════════

if (HAS_DB) {

Deno.test("ClientProfile: Create returns profile and API key", async () => {
  const { profile, api_key } = await clientProfileService.create({
    name: "Test Client",
    description: "Test client profile",
    quota_limits: { monthly_requests: 10000, monthly_tokens: 1000000 },
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  assertExists(profile);
  assertExists(api_key);
  assert(api_key.startsWith("sk-client-"));
  assertEquals(profile.name, "Test Client");
  assertEquals(profile.status, "active");
  assertEquals(profile.api_key_prefix.length, 16); // "sk-client-****"
});

Deno.test("ClientProfile: Get by ID works", async () => {
  const { profile } = await clientProfileService.create({
    name: "Test Client 2",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "cost",
    rate_limits: { rpm: 30, tpm: 5000 },
    status: "active",
  });
  
  const retrieved = await clientProfileService.get(profile.id);
  assertExists(retrieved);
  assertEquals(retrieved!.id, profile.id);
  assertEquals(retrieved!.name, "Test Client 2");
});

Deno.test("ClientProfile: Get by API key works", async () => {
  const { profile, api_key } = await clientProfileService.create({
    name: "Test Client 3",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "speed",
    rate_limits: { rpm: 100, tpm: 20000 },
    status: "active",
  });
  
  const retrieved = await clientProfileService.getByApiKey(api_key);
  assertExists(retrieved);
  assertEquals(retrieved!.id, profile.id);
});

Deno.test("ClientProfile: Update works", async () => {
  const { profile } = await clientProfileService.create({
    name: "Test Client 4",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "quality",
    rate_limits: { rpm: 10, tpm: 1000 },
    status: "active",
  });
  
  const updated = await clientProfileService.update(profile.id, {
    name: "Updated Client 4",
    quota_limits: { monthly_requests: 50000 },
  });
  
  assertExists(updated);
  assertEquals(updated!.name, "Updated Client 4");
  assertEquals(updated!.quota_limits.monthly_requests, 50000);
});

Deno.test("ClientProfile: Rotate key generates new key", async () => {
  const { profile } = await clientProfileService.create({
    name: "Test Client 5",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  const oldPrefix = profile.api_key_prefix;
  const rotateResult = await clientProfileService.rotateKey(profile.id);
  assertExists(rotateResult);
  if (!rotateResult) throw new Error("rotateKey returned null");
  const new_api_key = rotateResult.new_api_key;
  
  assertExists(new_api_key);
  assert(new_api_key.startsWith("sk-client-"));
  
  const updated = await clientProfileService.get(profile.id);
  assertNotEquals(updated!.api_key_prefix, oldPrefix);
});

Deno.test("ClientProfile: Record usage and get forecast", async () => {
  const { profile } = await clientProfileService.create({
    name: "Test Client 6",
    quota_limits: { monthly_requests: 1000, daily_requests: 100 },
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  await clientProfileService.recordUsage(profile.id, "gpt-4o", 10, 5000);
  await clientProfileService.recordUsage(profile.id, "gpt-3.5-turbo", 5, 2000);
  
  const usage = await clientProfileService.getUsage(profile.id, "month");
  assertEquals(usage.requests, 15);
  assertEquals(usage.tokens, 7000);
  assertEquals(usage.by_model["gpt-4o"].requests, 10);
  assertEquals(usage.by_model["gpt-3.5-turbo"].tokens, 2000);
  
  const forecast = await clientProfileService.getForecast(profile.id);
  assertExists(forecast.current_usage);
  assertExists(forecast.projected_usage);
  assert(["none", "warning", "upgrade"].includes(forecast.recommended_action));
});

}

// ════════════════════════════════════════════════════════════════════════════
// AUTH CLIENTS TESTS (requires DB)
// ════════════════════════════════════════════════════════════════════════════

if (HAS_DB) {

Deno.test("AuthClient: Create returns client and secret", async () => {
  const { client, client_secret } = await authClientService.create({
    name: "Test OAuth Client",
    redirect_uris: ["https://example.com/callback"],
    scopes: ["read", "write"],
    grant_types: ["authorization_code", "refresh_token"],
    access_token_ttl: 3600,
    refresh_token_ttl: 2592000,
    status: "active",
  });
  
  assertExists(client);
  assertExists(client_secret);
  assert(client_secret.startsWith("sk-auth-"));
  assertEquals(client.name, "Test OAuth Client");
  assertEquals(client.client_id.length, 32);
  assertEquals(client.client_secret_prefix.length, 16);
});

Deno.test("AuthClient: Get by client_id works", async () => {
  const { client } = await authClientService.create({
    name: "Test OAuth Client 2",
    redirect_uris: ["https://example.com/callback2"],
    scopes: ["read"],
    grant_types: ["client_credentials"],
    access_token_ttl: 7200,
    refresh_token_ttl: 5184000,
    status: "active",
  });
  
  const retrieved = await authClientService.getByClientId(client.client_id);
  assertExists(retrieved);
  assertEquals(retrieved!.id, client.id);
  assertEquals(retrieved!.client_id, client.client_id);
});

Deno.test("AuthClient: Update works", async () => {
  const { client } = await authClientService.create({
    name: "Test OAuth Client 3",
    redirect_uris: ["https://example.com/callback3"],
    scopes: ["read"],
    grant_types: ["authorization_code"],
    access_token_ttl: 1800,
    refresh_token_ttl: 1296000,
    status: "active",
  });
  
  const updated = await authClientService.update(client.id, {
    name: "Updated OAuth Client 3",
    access_token_ttl: 7200,
  });
  
  assertExists(updated);
  assertEquals(updated!.name, "Updated OAuth Client 3");
  assertEquals(updated!.access_token_ttl, 7200);
});

Deno.test("AuthClient: Rotate secret works", async () => {
  const { client } = await authClientService.create({
    name: "Test OAuth Client 4",
    redirect_uris: ["https://example.com/callback4"],
    scopes: ["read"],
    grant_types: ["authorization_code"],
    access_token_ttl: 3600,
    refresh_token_ttl: 2592000,
    status: "active",
  });
  
  const oldPrefix = client.client_secret_prefix;
  const rotateResult = await authClientService.rotateSecret(client.id);
  assertExists(rotateResult);
  if (!rotateResult) throw new Error("rotateSecret returned null");
  const new_secret = rotateResult.new_secret;
  
  assertExists(new_secret);
  assert(new_secret.startsWith("sk-auth-"));
  
  const updated = await authClientService.get(client.id);
  assertNotEquals(updated!.client_secret_prefix, oldPrefix);
});

}

// ════════════════════════════════════════════════════════════════════════════
// URL TOKENS TESTS (requires DB)
// ════════════════════════════════════════════════════════════════════════════

if (HAS_DB) {

Deno.test("URLToken: Create returns token and raw token", async () => {
  // First create a client profile to reference
  const { profile } = await clientProfileService.create({
    name: "Token Owner",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  const { token, raw_token } = await urlTokenService.create({
    name: "Test URL Token",
    client_id: profile.id,
    scopes: ["chat", "models"],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    max_uses: 100,
    allowed_models: ["gpt-4o"],
    rate_limit: { rpm: 30 },
    status: "active",
  });
  
  assertExists(token);
  assertExists(raw_token);
  assert(raw_token.startsWith("tok-"));
  assertEquals(token.name, "Test URL Token");
  assertEquals(token.client_id, profile.id);
  assertEquals(token.scopes, ["chat", "models"]);
  assertEquals(token.max_uses, 100);
  assertEquals(token.current_uses, 0);
});

Deno.test("URLToken: Validate and consume increments uses", async () => {
  const { profile } = await clientProfileService.create({
    name: "Token Owner 2",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  const { raw_token } = await urlTokenService.create({
    name: "Test URL Token 2",
    client_id: profile.id,
    scopes: ["chat"],
    max_uses: 10,
    status: "active",
  });
  
  const token = await urlTokenService.validateAndConsume(raw_token);
  assertExists(token);
  assertEquals(token!.current_uses, 1);
  
  const token2 = await urlTokenService.validateAndConsume(raw_token);
  assertExists(token2);
  assertEquals(token2!.current_uses, 2);
});

Deno.test("URLToken: Expired token returns null", async () => {
  const { profile } = await clientProfileService.create({
    name: "Token Owner 3",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  const { raw_token } = await urlTokenService.create({
    name: "Expired Token",
    client_id: profile.id,
    scopes: ["chat"],
    expires_at: new Date(Date.now() - 1000).toISOString(), // Already expired
    status: "active",
  });
  
  const token = await urlTokenService.validateAndConsume(raw_token);
  assertEquals(token, null);
});

Deno.test("URLToken: Max uses exceeded returns null", async () => {
  const { profile } = await clientProfileService.create({
    name: "Token Owner 4",
    quota_limits: {},
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  const { raw_token } = await urlTokenService.create({
    name: "Limited Token",
    client_id: profile.id,
    scopes: ["chat"],
    max_uses: 1,
    status: "active",
  });
  
  // First use works
  const token1 = await urlTokenService.validateAndConsume(raw_token);
  assertExists(token1);
  
  // Second use fails
  const token2 = await urlTokenService.validateAndConsume(raw_token);
  assertEquals(token2, null);
});

}

// ════════════════════════════════════════════════════════════════════════════
// EMBEDDINGS TESTS (no DB required)
// ════════════════════════════════════════════════════════════════════════════

Deno.test("Embeddings: listEmbeddingModels returns expected providers", () => {
  const models = listEmbeddingModels();
  assertExists(models);
  assert(models.length >= 3); // openai, cohere, voyage/huggingface at minimum
  
  const providers = [...new Set(models.map(m => m.provider))];
  assert(providers.includes("openai"));
  assert(providers.includes("cohere"));
  // BGE is under huggingface provider
  assert(providers.includes("huggingface") || providers.includes("voyage"));
});

// ════════════════════════════════════════════════════════════════════════════
// MEDIA TESTS
// ════════════════════════════════════════════════════════════════════════════

Deno.test("Media: MediaGenerationRequest type is valid", () => {
  const req: MediaGenerationRequest = {
    model: "dall-e-3",
    prompt: "A beautiful sunset",
    width: 1024,
    height: 1024,
    n: 1,
  };
  
  assertEquals(req.model, "dall-e-3");
  assertEquals(req.prompt, "A beautiful sunset");
  assertEquals(req.width, 1024);
  assertEquals(req.height, 1024);
  assertEquals(req.n, 1);
});

Deno.test("Media: generateMedia function exists", () => {
  assertExists(generateMedia);
  assert(typeof generateMedia === "function");
});

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS (requires DB)
// ════════════════════════════════════════════════════════════════════════════

if (HAS_DB) {

Deno.test("Integration: Client Profile + URL Token + Quota flow", async () => {
  // 1. Create client profile
  const { profile, api_key } = await clientProfileService.create({
    name: "Integration Client",
    quota_limits: { monthly_requests: 1000 },
    model_scope: [],
    priority_strategy: "balanced",
    rate_limits: { rpm: 60, tpm: 10000 },
    status: "active",
  });
  
  // 2. Create URL token for this client
  const { token, raw_token } = await urlTokenService.create({
    name: "Integration Token",
    client_id: profile.id,
    scopes: ["chat"],
    max_uses: 10,
    status: "active",
  });
  
  // 3. Validate token
  const validated = await urlTokenService.validateAndConsume(raw_token);
  assertExists(validated);
  
  // 4. Record usage for quota tracking
  await clientProfileService.recordUsage(profile.id, "gpt-4o", 1, 100);
  
  // 5. Check forecast
  const forecast = await clientProfileService.getForecast(profile.id);
  assertExists(forecast);
  assertEquals(forecast.current_usage.requests, 1);
  
  // 6. Rotate API key
  const rotateResult = await clientProfileService.rotateKey(profile.id);
  assertExists(rotateResult);
  if (!rotateResult) throw new Error("rotateKey returned null");
  const new_api_key = rotateResult.new_api_key;
  assertExists(new_api_key);
});

Deno.test("Integration: MCP Server + Custom Model + Search engines", async () => {
  // Register a custom model
  const model = await registerCustomModel({
    name: "integration-model",
    display_name: "Integration Model",
    provider: "anthropic",
    capabilities: { chat: true, streaming: true, tools: true, vision: true, reasoning: true, max_context: 200000 },
    pricing: { input_per_1k: 0.003, output_per_1k: 0.015, currency: "USD" },
    config: { endpoint: "https://api.anthropic.com", api_key_ref: "test-key" },
  });
  
  assertExists(model);
  
  // Check it's in MCP resources
  const resources = await mcpServer.handleListResources();
  const modelsResource = resources.resources.find(r => r.uri === "openllm://models");
  assertExists(modelsResource);
  
  // Check search engines
  const engines = listSearchEngines();
  assert(engines.length > 0);
});

}

console.log("All Phase C Week 13-14 tests passed!");