/**
 * OpenCode Zen Provider Adapter — OpenAI-compatible with free tier support.
 * 
 * OpenCode Zen (https://opencode.ai/zen/v1) provides a curated set of models
 * optimized for coding agents, including several free models.
 * 
 * Free models require special headers to work outside the OpenCode client:
 * - User-Agent: opencode/...
 * - x-opencode-client: true
 * - x-opencode-session: <session_id> (required for free tier)
 * 
 * Anonymous free access uses "Bearer public" with proper headers.
 * Keyed access uses "Bearer <zen_key>" from https://opencode.ai/auth
 */

import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderCapabilities,
  ProviderResult,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ModelInfo,
  TestResult,
  ApiKey,
  RequestOptions,
} from "./types.ts";
import { detectFreeModel } from "./free-detect.ts";
import { recordUpstreamQuota } from "./quota-observation.ts";

/** OpenCode Zen free models (from FreeLLMAPI migrateModelsV18 + current docs) */
export const OPencode_FREE_MODELS = [
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
] as const;

/** OpenCode Zen paid models (for reference) */
export const OPencode_PAID_MODELS = [
  "mini-max-m3",
  "mini-max-m2.7",
  "mini-max-m2.5",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "jev-1.13",
] as const;

/** Generate a session ID that mimics OpenCode client format */
function generateOpencodeSessionId(): string {
  // OpenCode uses ses_<12 lowercase hex><14 chars>
  const part1 = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const part2 = Array.from({ length: 14 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `ses_${part1}${part2}`;
}

/** Default OpenCode client headers for free tier access */
export const OPENCODE_CLIENT_HEADERS = {
  "User-Agent": "opencode/2.0.0 (OpenLLM)", // Mimic OpenCode client UA
  "x-opencode-client": "true",
  "x-opencode-request": "true",
} as const;

/** OpenCode Zen Provider Adapter */
export class OpencodeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly protocol: "openai" = "openai";
  readonly base_url: string;
  readonly capabilities: ProviderCapabilities;

  private readonly config: ProviderConfig;
  private readonly isAnonymous: boolean;

  constructor(config: ProviderConfig, isAnonymous = false) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.base_url = config.base_url;
    this.capabilities = config.capabilities;
    this.isAnonymous = isAnonymous;
  }

  /** Create async iterator for streaming response */
  private async *createStreamIterator(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              yield JSON.parse(data) as ChatCompletionChunk;
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Chat completions — main entry point */
  async chat(
    req: ChatCompletionRequest,
    key: ApiKey,
    options?: RequestOptions
  ): Promise<ProviderResult> {
    const url = `${this.base_url.replace(/\/$/, "")}/chat/completions`;

    // Determine auth: anonymous (Bearer public) or keyed
    const authHeader = this.isAnonymous || !key?.encrypted_key
      ? "Bearer public"
      : `Bearer ${key.encrypted_key}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: authHeader,
      ...OPENCODE_CLIENT_HEADERS,
      // Generate a session ID for each request (required for free tier)
      "x-opencode-session": generateOpencodeSessionId(),
    };

    // Add any extra headers from config
    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    const reqBody: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };

    // Copy optional parameters
    if (req.max_tokens !== undefined) reqBody.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) reqBody.temperature = req.temperature;
    if (req.top_p !== undefined) reqBody.top_p = req.top_p;
    if (req.reasoning_effort !== undefined) reqBody.reasoning_effort = req.reasoning_effort;
    if (req.tools !== undefined) reqBody.tools = req.tools;
    if (req.tool_choice !== undefined) reqBody.tool_choice = req.tool_choice;
    if (req.response_format !== undefined) reqBody.response_format = req.response_format;
    if (req.user !== undefined) reqBody.user = req.user;

    const controller = new AbortController();
    const timeoutMs = options?.timeout_ms ?? 60_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = Date.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
        signal: options?.signal ?? controller.signal,
      });

      const latency_ms = Date.now() - startTime;
      recordUpstreamQuota(key, this.id, req.model, res.status, res.headers, { endpoint: "/chat/completions", origin: "proxy" });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Upstream providers sometimes return JSON errors with various shapes.
        // Try to parse and extract a clean message; fall back to raw text.
        let message = text.slice(0, 500);
        try {
          const parsed = JSON.parse(text);
          if (parsed.error?.message) {
            message = parsed.error.message;
          } else if (parsed.error?.detail) {
            message = parsed.error.detail;
          } else if (parsed.message) {
            message = parsed.message;
          } else if (parsed.detail) {
            message = parsed.detail;
          } else if (typeof parsed === "string") {
            message = parsed;
          }
        } catch {
          // Not JSON, use raw text
        }
        if (!message.trim()) message = `HTTP ${res.status} from ${key.platform} (empty upstream error body)`;
        return {
          error: message,
          status: res.status,
          latency_ms,
        };
      }

      if (req.stream) {
        const reader = res.body?.getReader();
        if (!reader) return { error: "No response body", status: 502, latency_ms };

        const stream = this.createStreamIterator(reader);
        return { stream, latency_ms };
      }

      const response = (await res.json()) as ChatCompletionResponse;
      return { response, latency_ms };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg, status: 502, latency_ms: Date.now() - startTime };
    } finally {
      clearTimeout(timer);
    }
  }

  /** List available models */
  async models(): Promise<ModelInfo[]> {
    const url = `${this.base_url.replace(/\/$/, "")}/models`;

    const authHeader = this.isAnonymous ? "Bearer public" : "Bearer test";

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: authHeader,
          ...OPENCODE_CLIENT_HEADERS,
          "x-opencode-session": generateOpencodeSessionId(),
        },
      });

      if (!res.ok) return [];

      const data = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
      const models = data.data ?? [];

      return models.map((m) => {
        const freeStatus = detectFreeModel(this.id, m.id, this.capabilities.pricing);
        return {
          id: m.id,
          display_name: m.id,
          family: m.owned_by ?? "opencode",
          capabilities: {
            chat: true,
            streaming: this.capabilities.streaming,
            tools: this.capabilities.tools,
            vision: this.capabilities.vision,
            reasoning: this.capabilities.reasoning,
          },
          pricing: this.capabilities.pricing,
          context_window: this.capabilities.max_context,
          is_free: freeStatus.is_free,
          price_note: freeStatus.price_note,
        };
      });
    } catch {
      return [];
    }
  }

  /** Test provider connectivity and key validity */
  async test(key: ApiKey): Promise<TestResult> {
    const startTime = Date.now();

    try {
      // Test with a known free model
      const result = await this.chat(
        {
          model: "big-pickle", // Free model that should always be available
          messages: [{ role: "user", content: "test" }],
          max_tokens: 5,
        },
        key,
        { timeout_ms: 15_000 } // Longer timeout for free tier
      );

      const latency_ms = Date.now() - startTime;

      if (result.error) {
        return { ok: false, latency_ms, error: result.error };
      }

      // Also try to get model count
      const models = await this.models();

      return {
        ok: true,
        latency_ms,
        models_count: models.length,
        details: { models: models.slice(0, 5).map(m => m.id) },
      };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Validate an API key — minimal chat completion (uses free model) */
  async validateKey(
    decryptedKey: string,
    options?: { platform?: string; keyId?: number; endpoint?: string; origin?: string }
  ): Promise<{ valid: boolean; error?: string; status?: number } | boolean> {
    const url = `${this.base_url.replace(/\/$/, "")}/chat/completions`;
    const authHeader = this.isAnonymous || !decryptedKey
      ? "Bearer public"
      : `Bearer ${decryptedKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          ...OPENCODE_CLIENT_HEADERS,
          "x-opencode-session": generateOpencodeSessionId(),
        },
        body: JSON.stringify({
          model: "big-pickle",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) {
        return { valid: false, status: res.status, error: "Invalid API key" };
      }
      return { valid: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Estimate token count (rough approximation) */
  estimate_tokens(req: ChatCompletionRequest): number {
    let total = 0;
    for (const msg of req.messages) {
      total += msg.content.length / 3; // Rough: 1 token ≈ 3-4 chars
    }
    return Math.ceil(total * 1.2); // Add 20% buffer
  }
}

/** Factory function for creating OpenCode adapters */
export function createOpencodeAdapter(config: ProviderConfig, isAnonymous = false): OpencodeAdapter {
  return new OpencodeAdapter(config, isAnonymous);
}

/** Configuration for the keyed OpenCode Zen provider */
export const OPencode_KEYED_CONFIG: ProviderConfig = {
  id: "opencode",
  name: "OpenCode Zen",
  protocol: "openai",
  base_url: "https://opencode.ai/zen/v1",
  default_model: "big-pickle",
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    max_context: 131072,
    pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
    supported_models: [...OPencode_FREE_MODELS, ...OPencode_PAID_MODELS],
    default_model: "big-pickle",
  },
};

/** Configuration for the anonymous OpenCode Zen provider (free tier) */
export const OPencode_ANONYMOUS_CONFIG: ProviderConfig = {
  id: "opencode-free",
  name: "OpenCode Zen (Free)",
  protocol: "openai",
  base_url: "https://opencode.ai/zen/v1",
  default_model: "big-pickle",
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    max_context: 131072,
    pricing: { input_per_1k: 0, output_per_1k: 0, currency: "USD", updated_at: new Date().toISOString() },
    supported_models: [...OPencode_FREE_MODELS],
    default_model: "big-pickle",
  },
};