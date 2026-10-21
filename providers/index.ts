/**
 * Provider Registry — Factory and registry for all provider adapters.
 * Phase A Week 1: Central registry with lazy loading.
 */

import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderRegistryEntry,
  ProviderResult,
  ChatCompletionRequest,
  ModelInfo,
  TestResult,
  ApiKey,
  RequestOptions,
  Protocol,
  ProviderCapabilities,
} from "./types.ts";

import { OpenAICompatAdapter } from "./openai-compat.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OllamaAdapter } from "./ollama.ts";
import { OpencodeAdapter, OPencode_KEYED_CONFIG, OPencode_ANONYMOUS_CONFIG } from "./opencode.ts";
import { quotaEngine, checkQuotaAndCooldown } from "../services/ratelimit.ts";

/** Simple string hash for fallback keyId generation */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export class ProviderRegistry {
  private entries = new Map<string, ProviderRegistryEntry>();
  private adapters = new Map<string, ProviderAdapter>();

  /** Register a provider adapter */
  register(config: ProviderConfig, adapter: ProviderAdapter): void {
    this.entries.set(config.id, {
      config,
      adapter,
      enabled: true,
      health_status: "healthy",
      last_health_check: 0,
    });
    this.adapters.set(config.id, adapter);
  }

  /** Get adapter by provider ID */
  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Get adapter by protocol */
  getByProtocol(protocol: Protocol): ProviderAdapter[] {
    const result: ProviderAdapter[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.config.protocol === protocol && entry.enabled) {
        const adapter = this.adapters.get(id);
        if (adapter) result.push(adapter);
      }
    }
    return result;
  }

  /** Get all enabled adapters */
  getAllEnabled(): ProviderAdapter[] {
    const result: ProviderAdapter[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.enabled) {
        const adapter = this.adapters.get(id);
        if (adapter) result.push(adapter);
      }
    }
    return result;
  }

  /** Get all registered provider IDs */
  getAllIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Get registry entry (config + metadata) */
  getEntry(id: string): ProviderRegistryEntry | undefined {
    return this.entries.get(id);
  }

  /** Enable/disable a provider */
  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.enabled = enabled;
    return true;
  }

  /** Update health status */
  updateHealth(id: string, status: "healthy" | "degraded" | "down"): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.health_status = status;
      entry.last_health_check = Date.now();
    }
  }

  /** Get health status */
  getHealth(id: string): "healthy" | "degraded" | "down" | undefined {
    return this.entries.get(id)?.health_status;
  }

  /** List all providers with metadata (for dashboard) */
  list(): Array<{
    id: string;
    name: string;
    protocol: Protocol;
    enabled: boolean;
    health_status: "healthy" | "degraded" | "down";
    last_health_check: number;
    capabilities: ProviderCapabilities;
  }> {
    const result: Array<{
      id: string;
      name: string;
      protocol: Protocol;
      enabled: boolean;
      health_status: "healthy" | "degraded" | "down";
      last_health_check: number;
      capabilities: ProviderCapabilities;
    }> = [];
    for (const [id, entry] of this.entries) {
      result.push({
        id,
        name: entry.config.name,
        protocol: entry.config.protocol,
        enabled: entry.enabled,
        health_status: entry.health_status,
        last_health_check: entry.last_health_check,
        capabilities: entry.adapter.capabilities,
      });
    }
    return result;
  }
}

/** Global registry instance */
export const providerRegistry = new ProviderRegistry();

/** Built-in provider configurations */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  // OpenAI & Compatible
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o-mini",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0.00015, output_per_1k: 0.0006, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    },
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    protocol: "openai",
    base_url: "", // Configured per deployment
    default_model: "gpt-4o-mini",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "openrouter/auto",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      max_context: 200000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "groq",
    name: "Groq",
    protocol: "openai",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      max_context: 131072,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [
        "llama-3.3-70b-versatile",
        "llama-3.1-70b-versatile",
        "llama-3.1-8b-instant",
        "mixtral-8x7b-32768",
        "gemma2-9b-it",
      ],
    },
  },
  {
    id: "agnes",
    name: "Agnes AI",
    protocol: "openai",
    base_url: "https://apihub.agnes-ai.com/v1",
    default_model: "agnes-v2.6-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "CNY", updated_at: new Date().toISOString() },
      supported_models: ["agnes-v2.6-flash", "agnes-v2.6-pro"],
    },
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    protocol: "openai",
    base_url: "https://integrate.api.nvidia.com/v1",
    default_model: "meta/llama-3.1-70b-instruct",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "zhipu",
    name: "Zhipu AI",
    protocol: "openai",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-4-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0.0001, output_per_1k: 0.0001, currency: "CNY", updated_at: new Date().toISOString() },
      supported_models: ["glm-4-flash", "glm-4", "glm-3-turbo"],
    },
  },
  {
    id: "google",
    name: "Google AI Studio",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com",
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
  },
  {
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
  },
  {
    id: "mistral",
    name: "Mistral AI",
    protocol: "openai",
    base_url: "https://api.mistral.ai/v1",
    default_model: "mistral-small-latest",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0.0002, output_per_1k: 0.0006, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["mistral-large-latest", "mistral-small-latest", "pixtral-large-latest"],
    },
  },
  {
    id: "cohere",
    name: "Cohere",
    protocol: "openai",
    base_url: "https://api.cohere.ai/v1",
    default_model: "command-r-plus",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0.0005, output_per_1k: 0.0015, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["command-r-plus", "command-r", "command-light"],
    },
  },
  {
    id: "ovh",
    name: "OVHcloud AI Endpoints",
    protocol: "openai",
    base_url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    default_model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "EUR", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    protocol: "openai",
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.1",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 8192,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "custom",
    name: "Custom OpenAI-Compatible",
    protocol: "openai",
    base_url: "",
    default_model: "custom-model",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 4096,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  // ── Additional OpenAI-Compatible Providers (Phase B Week 7) ──
  {
    id: "auray",
    name: "Auray AI",
    protocol: "openai",
    base_url: "https://api.auray.ai/openai/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "blockrun",
    name: "BlockRun",
    protocol: "openai",
    base_url: "https://api.blockrun.ai/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "electronhub",
    name: "ElectronHub",
    protocol: "openai",
    base_url: "https://api.electronhub.ai/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "gizmo",
    name: "Gizmo",
    protocol: "openai",
    base_url: "https://api.gizmoplatforms.com/api/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "inferbase",
    name: "Inferbase",
    protocol: "openai",
    base_url: "https://api.inferbase.ai/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "llmtr",
    name: "LLMTR",
    protocol: "openai",
    base_url: "https://llmtr.com/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "plugsky",
    name: "PlugSky",
    protocol: "openai",
    base_url: "https://plugsky.com/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "simplellm",
    name: "SimpleLLM",
    protocol: "openai",
    base_url: "https://api.simplellm.eu/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "speka",
    name: "Speka",
    protocol: "openai",
    base_url: "https://speka.me/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "typhoon",
    name: "Typhoon",
    protocol: "openai",
    base_url: "https://api.opentyphoon.ai/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "freeai",
    name: "FreeAI",
    protocol: "openai",
    base_url: "https://api.free.ai",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "pollinations",
    name: "Pollinations",
    protocol: "openai",
    base_url: "https://api.pollinations.ai/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "router9",
    name: "Router9",
    protocol: "openai",
    base_url: "",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "septor",
    name: "Septor",
    protocol: "openai",
    base_url: "",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "waterfall",
    name: "Waterfall",
    protocol: "openai",
    base_url: "",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "github",
    name: "GitHub Models",
    protocol: "openai",
    base_url: "https://models.inference.ai.azure.com",
    default_model: "gpt-4o-mini",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 128000,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "longcat",
    name: "LongCat",
    protocol: "openai",
    base_url: "",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    protocol: "openai",
    base_url: "https://api.firecrawl.dev/v2",
    default_model: "default",
    capabilities: {
      streaming: false,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    protocol: "openai",
    base_url: "https://api.siliconflow.cn/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  {
    id: "unorouter",
    name: "UnoRouter",
    protocol: "openai",
    base_url: "https://api.unorouter.com/v1",
    default_model: "default",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 32768,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: [],
    },
  },
  // OpenCode Zen — OpenAI-compatible with free tier support
  // Free models require OpenCode client headers (User-Agent, x-opencode-client, x-opencode-session)
  // Anonymous access uses "Bearer public" with proper headers
  OPencode_KEYED_CONFIG,
  OPencode_ANONYMOUS_CONFIG,

  // Ollama (local/remote) — OpenAI-compatible via translation adapter
  {
    id: "ollama",
    name: "Ollama",
    protocol: "custom",
    base_url: "http://localhost:11434", // Default local; can be overridden per-key
    default_model: "llama3.1",
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      max_context: 131072,
      pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
      supported_models: ["llama3.1", "llama3.2", "mistral", "codellama", "phi3"],
    },
  },
];

/** Initialize registry with built-in providers */
export function initializeRegistry(): void {
  for (const config of BUILTIN_PROVIDERS) {
    if (!providerRegistry.get(config.id)) {
      let adapter: ProviderAdapter;
      switch (config.id) {
        case "opencode":
          adapter = new OpencodeAdapter(config, false); // keyed
          break;
        case "opencode-free":
          adapter = new OpencodeAdapter(config, true); // anonymous
          break;
        case "anthropic":
          adapter = new AnthropicAdapter(config);
          break;
        case "gemini":
          adapter = new GeminiAdapter(config);
          break;
        case "ollama":
          adapter = new OllamaAdapter(config);
          break;
        default:
          adapter = new OpenAICompatAdapter(config);
      }
      providerRegistry.register(config, adapter);
    }
  }
}

/** Convenience function to get adapter for a platform from api_keys table */
export function getAdapterForPlatform(platform: string): ProviderAdapter | undefined {
  return providerRegistry.get(platform);
}

/** Convenience function to test a provider with an API key */
export async function testProvider(platform: string, key: ApiKey): Promise<TestResult> {
  const adapter = providerRegistry.get(platform);
  if (!adapter) {
    return { ok: false, error: `Provider ${platform} not registered` };
  }
  return adapter.test(key);
}

/** Convenience function to list models for a provider */
export async function listProviderModels(platform: string): Promise<ModelInfo[]> {
  const adapter = providerRegistry.get(platform);
  if (!adapter) {
    return [];
  }
  return adapter.models();
}

/** Execute chat completion with automatic provider selection and quota enforcement */
export async function executeChat(
  request: ChatCompletionRequest,
  key: ApiKey,
  options?: RequestOptions
): Promise<ProviderResult> {
  const adapter = providerRegistry.get(key.platform);
  if (!adapter) {
    return { error: `Provider ${key.platform} not registered`, status: 503 };
  }

  // Estimate tokens for quota check
  const estimatedTokens = adapter.estimate_tokens(request);

  // Check quota and cooldown before making request
  let keyId: number;
  if (Number.isFinite(key.db_id)) {
    keyId = key.db_id;
  } else if (Number.isFinite(parseInt(key.id))) {
    keyId = parseInt(key.id);
  } else {
    // Fallback: use a hash of the platform name for quota tracking
    keyId = Math.abs(hashString(key.platform)) % 1000000 + 1000000;
    console.warn("[quota] Using platform-hash keyId for", key.platform, ":", keyId);
  }
  const quotaCheck = await checkQuotaAndCooldown(keyId, key.platform, request.model, estimatedTokens);
  if (!quotaCheck.allowed) {
    return {
      error: `Quota exceeded: ${quotaCheck.reason}`,
      status: 429,
      provider_metadata: { retry_after_ms: quotaCheck.retry_after_ms },
    };
  }

  try {
    const result = await adapter.chat(request, key, options);

    // Record usage on success
    if (!result.error && result.response?.usage) {
      await quotaEngine.onResponse(
        keyId,
        key.platform,
        request.model,
        result.response.usage,
        new Headers() // We don't have provider headers here
      );
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg, status: 502 };
  }
}