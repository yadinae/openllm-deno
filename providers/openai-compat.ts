/**
 * OpenAI-compatible provider — the core adapter for Phase 1.
 * Handles chat completions (streaming + non-streaming) via OpenAI-compatible API.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from "./types.ts";

export interface ProviderResult {
  response?: ChatCompletionResponse;
  error?: string;
  status?: number;
}

/**
 * Send a chat completion request to an OpenAI-compatible endpoint.
 * Supports streaming (SSE) and non-streaming responses.
 * baseUrl is already the full base URL (e.g. https://api.groq.com/openai/v1)
 * The function appends /chat/completions to form the final URL.
 */
export async function chat(
  apiKey: string,
  baseUrl: string,
  body: ChatCompletionRequest,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ProviderResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const reqBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
  };
  if (body.max_tokens !== undefined) reqBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) reqBody.temperature = body.temperature;
  if (body.top_p !== undefined) reqBody.top_p = body.top_p;
  if (body.reasoning_effort !== undefined) reqBody.reasoning_effort = body.reasoning_effort;

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: options?.signal ?? controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: text.slice(0, 500), status: res.status };
    }

    if (body.stream) {
      const reader = res.body?.getReader();
      if (!reader) return { error: "No response body", status: 502 };

      const chunks: ChatCompletionChunk[] = [];
      const decoder = new TextDecoder();
      let buffer = "";
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
              chunks.push(JSON.parse(data) as ChatCompletionChunk);
            } catch { /* skip */ }
          }
        }
      }
      const final = chunks[chunks.length - 1] ?? {
        id: "chatcmpl-deno",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: body.model,
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
      };
      return { response: final as unknown as ChatCompletionResponse };
    }

    const response = (await res.json()) as ChatCompletionResponse;
    return { response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg, status: 502 };
  } finally {
    clearTimeout(timer);
  }
}
