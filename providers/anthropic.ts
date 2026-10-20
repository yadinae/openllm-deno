/**
 * Anthropic Provider Adapter — Native Messages API implementation.
 * Phase B Week 8: Anthropic/Gemini 专用适配器 (P-CORE-015).
 *
 * Maps OpenAI-compatible chat/completions requests to Anthropic Messages API
 * (POST /v1/messages) and converts responses back to OpenAI format.
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

// ============================================================================
// Anthropic Message Types
// ============================================================================

interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: string; text?: string }>;
  }>;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  metadata?: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicMessageChunk {
  type: string;
  index?: number;
  content_block?: { type: string; text?: string };
  delta?: { type: string; text?: string; stop_reason?: string };
  usage?: { input_tokens: number; output_tokens: number };
}

// ============================================================================
// Anthropic Adapter Class
// ============================================================================

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly protocol: "anthropic" = "anthropic";
  readonly base_url: string;
  readonly capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.base_url = config.base_url.replace(/\/+$/, "");
    this.capabilities = config.capabilities;
  }

  /** Chat completions — map OpenAI format to Anthropic Messages API */
  async chat(
    req: ChatCompletionRequest,
    key: ApiKey,
    options?: RequestOptions
  ): Promise<ProviderResult> {
    const url = `${this.base_url}/messages`;
    const timeoutMs = options?.timeout_ms ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = Date.now();

    try {
      const anthropicReq = this.mapRequest(req);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": key.encrypted_key,
        "anthropic-version": "2023-06-01",
      };

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(anthropicReq),
        signal: options?.signal ?? controller.signal,
      });

      const latency_ms = Date.now() - startTime;

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
        return { error: message, status: res.status, latency_ms };
      }

      if (req.stream) {
        const reader = res.body?.getReader();
        if (!reader) return { error: "No response body", status: 502, latency_ms };
        const stream = this.createStreamIterator(reader);
        return { stream, latency_ms };
      }

      const response = (await res.json()) as AnthropicMessageResponse;
      return {
        response: this.mapResponse(response, req.model),
        latency_ms,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg, status: 502, latency_ms: Date.now() - startTime };
    } finally {
      clearTimeout(timer);
    }
  }

  /** List available models — Anthropic doesn't have a public /models endpoint,
   * so return from capabilities.supported_models with free detection. */
  async models(): Promise<ModelInfo[]> {
    const models = this.capabilities.supported_models ?? [];
    return models.map((m) => {
      const freeStatus = detectFreeModel(this.id, m, this.capabilities.pricing);
      return {
        id: m,
        display_name: m,
        family: "anthropic",
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
  }

  /** Test provider connectivity and key validity */
  async test(key: ApiKey): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const result = await this.chat(
        {
          model: this.capabilities.default_model ?? "claude-3-haiku-20240307",
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

      const models = await this.models();
      return {
        ok: true,
        latency_ms,
        models_count: models.length,
        details: { models: models.slice(0, 5).map((m) => m.id) },
      };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Estimate token count (rough approximation for Anthropic) */
  estimate_tokens(req: ChatCompletionRequest): number {
    let total = 0;
    for (const msg of req.messages) {
      total += msg.content.length / 3.5; // Anthropic ~3.5 chars per token
      if (msg.role === "system") total *= 1.1; // system prompts slightly more expensive
    }
    return Math.ceil(total * 1.2); // Add 20% buffer
  }

  // ============================================================================
  // Request Mapping: OpenAI → Anthropic
  // ============================================================================

  private mapRequest(req: ChatCompletionRequest): AnthropicMessageRequest {
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const chatMessages = req.messages.filter((m) => m.role !== "system");

    const anthropicMessages = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as any).map((c: any) => ({ type: "text", text: c })).filter(Boolean)
          : String(m.content),
    } as any));

    const maxTokens = req.max_tokens ?? 1024;

    return {
      model: req.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      system: systemMessages.length > 0
        ? (systemMessages.map((m) => m.content as string).join("\n"))
        : undefined,
      temperature: req.temperature,
      top_p: req.top_p,
      stop_sequences: req.tools?.length ? undefined : undefined, // tools may conflict with stop
      stream: req.stream ?? false,
      tools: req.tools?.length ? req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })) : undefined,
      tool_choice: req.tools?.length && req.tool_choice
        ? req.tool_choice === "none"
          ? { type: "auto" }
          : req.tool_choice === "required"
            ? { type: "any" }
            : { type: "auto" }
        : undefined,
    };
  }

  // ============================================================================
  // Response Mapping: Anthropic → OpenAI
  // ============================================================================

  private mapResponse(
    anthropic: AnthropicMessageResponse,
    originalModel: string
  ): ChatCompletionResponse {
    const content = anthropic.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    const finishReason = this.mapFinishReason(anthropic.stop_reason);

    return {
      id: `chatcmpl-${anthropic.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || null,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: anthropic.usage.input_tokens,
        completion_tokens: anthropic.usage.output_tokens,
        total_tokens:
          anthropic.usage.input_tokens + anthropic.usage.output_tokens,
      },
    };
  }

  private mapFinishReason(reason: string | null): string {
    switch (reason) {
      case "end_turn":
        return "stop";
      case "max_tokens":
        return "length";
      case "tool_use":
        return "tool_calls";
      case "refusal":
        return "content_filter";
      default:
        return "stop";
    }
  }

  // ============================================================================
  // Streaming: Anthropic SSE → OpenAI chunks
  // ============================================================================

  private async *createStreamIterator(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): AsyncIterable<ChatCompletionChunk> {
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
              const parsed = JSON.parse(data) as AnthropicMessageChunk;
              const chunk = this.mapChunk(parsed);
              if (chunk) yield chunk;
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }

      // Final chunk with stop
      yield {
        id: `chatcmpl-stream`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
    } finally {
      reader.releaseLock();
    }
  }

  private mapChunk(anthropic: AnthropicMessageChunk): ChatCompletionChunk | null {
    switch (anthropic.type) {
      case "message_start":
        return {
          id: `chatcmpl-stream`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "",
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        };
      case "content_block_delta":
        if (anthropic.delta?.type === "text_delta" && anthropic.delta.text) {
          return {
            id: `chatcmpl-stream`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "",
            choices: [
              {
                index: 0,
                delta: { content: anthropic.delta.text },
                finish_reason: null,
              },
            ],
          };
        }
        return null;
      case "message_delta":
        return anthropic.delta?.stop_reason
          ? {
              id: `chatcmpl-stream`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: this.mapFinishReason(anthropic.delta.stop_reason),
                },
              ],
            }
          : null;
      default:
        return null;
    }
  }
}

/** Factory function for creating Anthropic adapters */
export function createAnthropicAdapter(config: ProviderConfig): AnthropicAdapter {
  return new AnthropicAdapter(config);
}