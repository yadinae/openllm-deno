/**
 * Provider Abstraction Layer — Unified interface for all LLM providers.
 * Phase A Week 1: Core types and interfaces.
 */

// ============================================================================
// Core Request/Response Types (OpenAI-compatible subset)
// ============================================================================

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  tools?: Tool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown };
  user?: string;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  _fusion?: FusionMetadata;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
}

export interface FusionMetadata {
  panel: PanelMember[];
  judge: string;
  strategy: "synthesize" | "best_of";
  tool_votes: { tool: number; prose: number };
  synthesized: boolean;
}

export interface PanelMember {
  provider: string;
  model: string;
  response: ChatCompletionResponse;
  latency_ms: number;
}

// ============================================================================
// Provider Capabilities & Metadata
// ============================================================================

export type Protocol = "openai" | "anthropic" | "gemini" | "custom";

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  max_context: number;
  pricing: PricingModel;
  supported_models: string[];
  default_model?: string;
}

export interface PricingModel {
  input_per_1k: number;   // USD per 1K input tokens
  output_per_1k: number;  // USD per 1K output tokens
  currency: "USD" | "CNY" | "EUR";
  updated_at: string;     // ISO timestamp
}

export interface ModelInfo {
  id: string;
  display_name: string;
  family: string;
  capabilities: ModelCapabilities;
  pricing?: PricingModel;
  context_window: number;
  is_free: boolean;
  price_note?: string;
}

export interface ModelCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

// ============================================================================
// Provider Adapter Interface
// ============================================================================

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly protocol: Protocol;
  readonly base_url: string;
  readonly capabilities: ProviderCapabilities;

  /** Chat completions - supports both streaming and non-streaming */
  chat(
    req: ChatCompletionRequest,
    key: ApiKey,
    options?: RequestOptions
  ): Promise<ProviderResult>;

  /** List available models */
  models(): Promise<ModelInfo[]>;

  /** Test provider connectivity and key validity */
  test(key: ApiKey): Promise<TestResult>;

  /** Validate an API key (lightweight check, used by health/cooldown probes) */
  validateKey(
    decryptedKey: string,
    options?: { platform?: string; keyId?: number; endpoint?: string; origin?: string }
  ): Promise<{ valid: boolean; error?: string; status?: number } | boolean>;

  /** Estimate token count for a request */
  estimate_tokens(req: ChatCompletionRequest): number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout_ms?: number;
  stream_handler?: (chunk: ChatCompletionChunk) => void;
}

export interface ProviderResult {
  response?: ChatCompletionResponse;
  stream?: AsyncIterable<ChatCompletionChunk>;
  error?: string;
  status?: number;
  latency_ms?: number;
  provider_metadata?: Record<string, unknown>;
}

export interface TestResult {
  ok: boolean;
  latency_ms?: number;
  models_count?: number;
  error?: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// API Key & Configuration (matching db/types)
// ============================================================================

export interface ApiKey {
  id: string;          // Platform name (e.g., "groq") - used for provider registry lookup
  db_id: number;       // Database integer ID - used for quota/rate limiting
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: "healthy" | "error" | "rate_limited" | "invalid";
  enabled: boolean;
  base_url?: string;
  monthly_request_cap?: number;
  monthly_token_cap?: number;
  model_scope?: string[];
}

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  api_key_env?: string;           // Env var name for API key (optional)
  default_model?: string;
  models_endpoint?: string;       // Override models endpoint path
  chat_endpoint?: string;         // Override chat endpoint path
  headers?: Record<string, string>; // Extra headers
  capabilities: ProviderCapabilities;
}

// ============================================================================
// Routing & Fallback Types
// ============================================================================

export interface FallbackEntry {
  provider: string;
  model: string;
  key_id: string;
  priority: number;
  metadata?: Record<string, unknown>;
}

export interface RoutingContext {
  request: ChatCompletionRequest;
  available_keys: ApiKey[];
  client_profile?: ClientProfile;
  preferred_provider?: string;
  excluded_providers?: string[];
}

export interface RoutingDecision {
  provider: ProviderAdapter;
  model: string;
  key: ApiKey;
  fallback_chain: FallbackEntry[];
  metadata: { score: number; reason: string };
}

// ============================================================================
// Client Profile & Quota (for routing context)
// ============================================================================

export interface ClientProfile {
  id: string;
  name: string;
  api_key: string;           // Hashed
  quota_limits: QuotaLimits;
  model_scope?: string[];    // Allowed model IDs
  priority_strategy?: "balanced" | "cost" | "speed" | "quality";
  created_at: string;
  updated_at: string;
}

export interface QuotaLimits {
  rpm?: number;              // Requests per minute
  tpm?: number;              // Tokens per minute
  rpd?: number;              // Requests per day
  tpd?: number;              // Tokens per day
  monthly_token_budget?: number;
}

// ============================================================================
// Embeddings & Media Types
// ============================================================================

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface EmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  response_format?: "url" | "b64_json";
  user?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}

export interface SearchRequest {
  query: string;
  engine?: string;
  max_results?: number;
  recency_days?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  timestamp?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  total_results: number;
  search_time_ms: number;
}

// ============================================================================
// Provider Registry Types
// ============================================================================

export interface ProviderRegistryEntry {
  config: ProviderConfig;
  adapter: ProviderAdapter;
  enabled: boolean;
  health_status: "healthy" | "degraded" | "down";
  last_health_check: number;
}

// ============================================================================
// Free Model Detection Types
// ============================================================================

/** Three-tier free model detection logic:
 * 1. Whitelist first (highest confidence)
 * 2. Zero pricing strict check
 * 3. :free suffix identification
 */
export type FreeDetectionTier = "whitelist" | "zero_pricing" | "free_suffix" | "unknown";

export interface FreeModelInfo {
  is_free: boolean;
  tier: FreeDetectionTier;
  confidence: number; // 0-1
  price_note?: string;
  source: "whitelist" | "pricing" | "suffix" | "default";
}

/** Whitelist of known free models (provider_id -> model_id patterns) */
export interface FreeModelWhitelist {
  [provider_id: string]: string[]; // exact model IDs or glob patterns
}

/** Free model detection result for a single model */
export interface ModelFreeStatus {
  model_id: string;
  provider_id: string;
  is_free: boolean;
  tier: FreeDetectionTier;
  confidence: number;
  price_note?: string;
}