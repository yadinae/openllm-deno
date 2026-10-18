/**
 * OpenAI-Compatible Provider Adapter — Class-based implementation of ProviderAdapter.
 * Supports all OpenAI-compatible endpoints (OpenAI, Groq, OpenRouter, Agnes, Nvidia, Zhipu, etc.)
 */

import { detectFreeModel } from "./free-detect.ts";
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

/** OpenAI-Compatible Adapter Class */
export class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly protocol: "openai" = "openai";
  readonly base_url: string;
  readonly capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.base_url = config.base_url;
    this.capabilities = config.capabilities;
  }

  /** Chat completions — main entry point */
  async chat(
    req: ChatCompletionRequest,
    key: ApiKey,
    options?: RequestOptions
  ): Promise<ProviderResult> {
    const url = `${this.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key.encrypted_key}`,
    };

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

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          error: text.slice(0, 500),
          status: res.status,
          latency_ms,
        };
      }

      if (req.stream) {
        const reader = res.body?.getReader();
        if (!reader) return { error: "No response body", status: 502, latency_ms };

        const stream = this.createStreamIterator(reader);
        return {
          stream,
          latency_ms,
        };
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

  /** List available models */
  async models(): Promise<ModelInfo[]> {
    const url = `${this.base_url.replace(/\/$/, "")}/models`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.getTestKey()}` },
      });

      if (!res.ok) return [];

      const data = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
      const models = data.data ?? [];

      return models.map((m) => {
        const freeStatus = detectFreeModel(this.id, m.id, this.capabilities.pricing);
        return {
          id: m.id,
          display_name: m.id,
          family: m.owned_by ?? "unknown",
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
      // Try a minimal chat completion
      const result = await this.chat(
        {
          model: this.capabilities.default_model ?? "test",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 5,
        },
        key,
        { timeout_ms: 10_000 }
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

  /** Estimate token count (rough approximation) */
  estimate_tokens(req: ChatCompletionRequest): number {
    let total = 0;
    for (const msg of req.messages) {
      total += msg.content.length / 3; // Rough: 1 token ≈ 3-4 chars
    }
    return Math.ceil(total * 1.2); // Add 20% buffer
  }

  /** Get a test key for models endpoint (some providers need auth) */
  private getTestKey(): string {
    return "test";
  }
}

/** Factory function for creating OpenAI-compatible adapters */
export function createOpenAICompatAdapter(config: ProviderConfig): OpenAICompatAdapter {
  return new OpenAICompatAdapter(config);
}
