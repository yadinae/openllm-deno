/**
 * Gemini Provider Adapter — Native Generative Language API implementation.
 * Phase B Week 8: Anthropic/Gemini 专用适配器 (P-CORE-015).
 *
 * Maps OpenAI-compatible chat/completions requests to Gemini Generative
 * Language API (POST /v1beta/models/{model}:generateContent) and converts
 * responses back to OpenAI format.
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

// ============================================================================
// Gemini API Types
// ============================================================================

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GeminiGenerationConfig {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_output_tokens?: number;
  stop_sequences?: string[];
}

interface GeminiTool {
  function_declarations: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
}

interface GeminiToolConfig {
  function_calling_config?: { mode: "auto" | "any" | "none"; allowed_function_names?: string[] };
}

interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  system_instruction?: { parts: Array<{ text: string }> };
  generation_config?: GeminiGenerationConfig;
  tools?: GeminiTool[];
  tool_config?: GeminiToolConfig;
  safety_settings?: Array<{
    category: string;
    threshold: string;
  }>;
}

interface GeminiGenerateContentResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
    finish_reason: string;
    finish_message?: string;
    index: number;
    safety_ratings?: Array<{ category: string; probability: string }>;
  }>;
  usage_metadata: {
    prompt_token_count: number;
    candidates_token_count: number;
    total_token_count: number;
  };
}

// ============================================================================
// Gemini Adapter Class
// ============================================================================

export class GeminiAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly protocol: "gemini" = "gemini";
  readonly base_url: string;
  readonly capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.base_url = config.base_url.replace(/\/+$/, "");
    this.capabilities = config.capabilities;
  }

  /** Chat completions — map OpenAI format to Gemini Generative Language API */
  async chat(
    req: ChatCompletionRequest,
    key: ApiKey,
    options?: RequestOptions
  ): Promise<ProviderResult> {
    const modelId = req.model;
    const url = `${this.base_url}/v1beta/models/${modelId}:generateContent${
      req.stream ? "Alt" : ""
    }`;
    // Use streamGenerateContent for streaming
    const streamUrl = req.stream
      ? `${this.base_url}/v1beta/models/${modelId}:streamGenerateContent`
      : `${this.base_url}/v1beta/models/${modelId}:generateContent`;

    const timeoutMs = options?.timeout_ms ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = Date.now();

    try {
      const geminiReq = this.mapRequest(req);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-goog-api-key": key.encrypted_key,
      };

      const res = await fetch(streamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(geminiReq),
        signal: options?.signal ?? controller.signal,
      });

      const latency_ms = Date.now() - startTime;
      recordUpstreamQuota(key, this.id, req.model, res.status, res.headers, { endpoint: "/v1beta/models/:generateContent", origin: "proxy" });

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

      const response = (await res.json()) as GeminiGenerateContentResponse;
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

  /** List available models — Gemini doesn't have a simple public /models endpoint
   * without auth, so return from capabilities.supported_models. */
  async models(): Promise<ModelInfo[]> {
    const models = this.capabilities.supported_models ?? [];
    return models.map((m) => {
      const freeStatus = detectFreeModel(this.id, m, this.capabilities.pricing);
      return {
        id: m,
        display_name: m,
        family: "google",
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
          model: this.capabilities.default_model ?? "gemini-1.5-flash",
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

  /** Validate an API key — minimal generateContent call */
  async validateKey(
    decryptedKey: string,
    options?: { platform?: string; keyId?: number; endpoint?: string; origin?: string }
  ): Promise<{ valid: boolean; error?: string; status?: number } | boolean> {
    const modelId = this.capabilities.default_model ?? "gemini-1.5-flash";
    const url = `${this.base_url}/v1beta/models/${modelId}:generateContent`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": decryptedKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "test" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
        signal: AbortSignal.timeout(10_000),
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

  /** Estimate token count (rough approximation for Gemini) */
  estimate_tokens(req: ChatCompletionRequest): number {
    let total = 0;
    for (const msg of req.messages) {
      total += msg.content.length / 4; // Gemini ~4 chars per token
      if (msg.role === "system") total *= 1.05;
    }
    return Math.ceil(total * 1.15); // Add 15% buffer
  }

  // ============================================================================
  // Request Mapping: OpenAI → Gemini
  // ============================================================================

  private mapRequest(req: ChatCompletionRequest): GeminiGenerateContentRequest {
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const chatMessages = req.messages.filter((m) => m.role !== "system");

    const contents: GeminiContent[] = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : String(m.content) }],
    }));

    const config: GeminiGenerationConfig = {};
    if (req.temperature !== undefined) config.temperature = req.temperature;
    if (req.top_p !== undefined) config.top_p = req.top_p;
    if (req.max_tokens !== undefined) config.max_output_tokens = req.max_tokens;

    const geminiReq: GeminiGenerateContentRequest = {
      contents,
      generation_config: config,
    };

    // System instruction
    if (systemMessages.length > 0) {
      geminiReq.system_instruction = {
        parts: systemMessages.map((m) => ({ text: m.content as string })),
      };
    }

    // Tools
    if (req.tools?.length) {
      geminiReq.tools = [
        {
          function_declarations: req.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];

      // Tool config
      if (req.tool_choice) {
        geminiReq.tool_config = {
          function_calling_config: {
            mode:
              req.tool_choice === "none"
                ? "none"
                : req.tool_choice === "required"
                  ? "any"
                  : "auto",
          },
        };
      }
    }

    // Safety settings - permissive defaults
    geminiReq.safety_settings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    return geminiReq;
  }

  // ============================================================================
  // Response Mapping: Gemini → OpenAI
  // ============================================================================

  private mapResponse(
    gemini: GeminiGenerateContentResponse,
    originalModel: string
  ): ChatCompletionResponse {
    const candidate = gemini.candidates[0];
    const content = candidate?.content?.parts
      .map((p) => p.text ?? "")
      .join("") || "";

    return {
      id: `chatcmpl-gemini-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [
        {
          index: candidate?.index ?? 0,
          message: {
            role: "assistant",
            content: content || null,
          },
          finish_reason: this.mapFinishReason(candidate?.finish_reason),
        },
      ],
      usage: {
        prompt_tokens: gemini.usage_metadata.prompt_token_count,
        completion_tokens: gemini.usage_metadata.candidates_token_count,
        total_tokens: gemini.usage_metadata.total_token_count,
      },
    };
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
        return "content_filter";
      case "RECITATION":
        return "content_filter";
      case "OTHER":
        return "stop";
      default:
        return "stop";
    }
  }

  // ============================================================================
  // Streaming: Gemini SSE → OpenAI chunks
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
              const chunk = this.mapStreamChunk(JSON.parse(data));
              if (chunk) yield chunk;
            } catch {
              // Skip malformed chunks
            }
          }
        }
      }

      // Final chunk with stop
      yield {
        id: `chatcmpl-gemini-stream`,
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

  private mapStreamChunk(data: any): ChatCompletionChunk | null {
    const candidates = data.candidates;
    if (!candidates || candidates.length === 0) return null;

    const candidate = candidates[0];
    const parts = candidate.content?.parts ?? [];
    const text = parts.map((p: any) => p.text ?? "").join("");

    return {
      id: `chatcmpl-gemini-stream`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "",
      choices: [
        {
          index: candidate.index ?? 0,
          delta: text ? { content: text } : {},
          finish_reason: candidate.finish_reason
            ? this.mapFinishReason(candidate.finish_reason)
            : null,
        },
      ],
    };
  }
}

/** Factory function for creating Gemini adapters */
export function createGeminiAdapter(config: ProviderConfig): GeminiAdapter {
  return new GeminiAdapter(config);
}