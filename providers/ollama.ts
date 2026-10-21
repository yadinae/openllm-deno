/**
 * Ollama outbound provider adapter.
 * Supports local Ollama endpoints (http://localhost:11434 or remote) via OpenAI-compatible /v1 interface.
 * Ollama's /api/chat is NOT OpenAI-compatible — this adapter translates to/from Ollama native format.
 */
import type {
  ProviderAdapter, ProviderConfig, ChatCompletionRequest, ChatCompletionResponse,
  ChatCompletionChunk, ModelInfo, ProviderResult, ApiKey, ProviderCapabilities, PricingModel
} from "./types.ts";
import { recordUpstreamQuota } from "./quota-observation.ts";

export class OllamaAdapter implements ProviderAdapter {
  readonly id = "ollama";
  readonly name = "Ollama";
  readonly protocol = "custom" as const;
  readonly base_url: string;
  readonly capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.base_url = config.base_url.replace(/\/+$/, "");
    this.capabilities = config.capabilities;
  }

  async chat(
    request: ChatCompletionRequest,
    key: ApiKey,
    options?: { signal?: AbortSignal; timeout_ms?: number }
  ): Promise<ProviderResult> {
    const startTime = Date.now();
    const model = this.extractModelName(request.model);

    const ollamaReq = {
      model,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      stream: request.stream ?? false,
      options: {
        temperature: request.temperature,
        top_p: request.top_p,
        num_predict: request.max_tokens,
      },
    };

    const url = `${this.base_url}/api/chat`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key.encrypted_key) {
      headers.Authorization = `Bearer ${key.encrypted_key}`;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(ollamaReq),
        signal: options?.signal ?? AbortSignal.timeout(60_000),
      });

      const latency_ms = Date.now() - startTime;
      recordUpstreamQuota(key, this.id, request.model, res.status, res.headers, { endpoint: "/api/chat", origin: "proxy" });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Upstream providers sometimes return JSON errors with various shapes.
        // Try to parse and extract a clean message; fall back to raw text.
        let message = text.slice(0, 300);
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
        return { error: `Ollama ${res.status}: ${message}`, status: res.status, latency_ms };
      }

      if (request.stream) {
        const reader = res.body?.getReader();
        if (!reader) return { error: "No response body", status: 502, latency_ms };

        const stream = this.createOllamaStreamIterator(reader, model);
        return { stream, latency_ms };
      }

      const ollamaResp = await res.json() as any;
      const openaiResp: ChatCompletionResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: ollamaResp.message?.content ?? "" },
          finish_reason: ollamaResp.done ? "stop" : "length",
        }],
        usage: {
          prompt_tokens: ollamaResp.prompt_eval_count ?? 0,
          completion_tokens: ollamaResp.eval_count ?? 0,
          total_tokens: (ollamaResp.prompt_eval_count ?? 0) + (ollamaResp.eval_count ?? 0),
        },
      };
      return { response: openaiResp, latency_ms };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg, status: 502, latency_ms: Date.now() - startTime };
    }
  }

  private async *createOllamaStreamIterator(reader: ReadableStreamDefaultReader<Uint8Array>, model: string): AsyncIterable<ChatCompletionChunk> {
    const decoder = new TextDecoder();
    let buffer = "";
    const chunkId = `chatcmpl-${Date.now()}`;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as any;
            if (chunk.message?.content) {
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: { role: "assistant", content: chunk.message.content },
                  finish_reason: null,
                }],
              } as ChatCompletionChunk;
            }
            if (chunk.done) {
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                }],
              } as ChatCompletionChunk;
              return;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.base_url}/api/tags`, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];

      const data = await res.json() as any;
      return (data.models ?? []).map((m: any) => ({
        id: `ollama/${m.name}`,
        display_name: m.name,
        family: "ollama",
        capabilities: { chat: true, streaming: true, tools: false, vision: false, reasoning: false },
        context_window: undefined,
        is_free: true,
        price_note: undefined,
      }));
    } catch {
      return [];
    }
  }

  estimate_tokens(request: ChatCompletionRequest): number {
    let total = 0;
    for (const msg of request.messages) {
      total += msg.content?.length ?? 0;
    }
    return Math.ceil(total / 4) + (request.max_tokens ?? 0);
  }

  private extractModelName(fullModel: string): string {
    const parts = fullModel.split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : fullModel;
  }

  async test(key: ApiKey): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.base_url}/api/tags`, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: res.ok };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** Validate an API key — /api/tags (no auth typically, but tests connectivity) */
  async validateKey(
    decryptedKey: string,
    options?: { platform?: string; keyId?: number; endpoint?: string; origin?: string }
  ): Promise<{ valid: boolean; error?: string; status?: number } | boolean> {
    // Ollama typically doesn't require auth, but we can test connectivity
    try {
      const res = await fetch(`${this.base_url}/api/tags`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(decryptedKey ? { Authorization: `Bearer ${decryptedKey}` } : {}),
        },
        signal: AbortSignal.timeout(5_000),
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
}

export function createOllamaAdapter(config: ProviderConfig): OllamaAdapter {
  return new OllamaAdapter(config);
}