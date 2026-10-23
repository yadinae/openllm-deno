/**
 * Anthropic inbound gateway — /v1/messages
 * Converts Anthropic format → OpenAI chat format → routes via gateway → converts response back.
 */
import { Hono } from "hono";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ChatMessage } from "../providers/types.ts";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { getAdapterForPlatform, executeChat } from "../providers/index.ts";
import type { ProviderResult, ApiKey } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";
import { smartRouter, executeWithFallback } from "../services/router.ts";
import { resolveAnthropicModel } from "../services/anthropic-map.ts";

const anthropicRouter = new Hono();

interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  metadata?: { user_id?: string };
}

function anthropicToOpenAI(msg: AnthropicMessage): ChatMessage {
  const role = msg.role === "assistant" ? "assistant" : "user";
  if (typeof msg.content === "string") return { role, content: msg.content };
  const textParts = msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
  return { role, content: textParts.map((b) => b.text).join("\n") };
}

function openAIToAnthropic(openai: ChatCompletionResponse, originalModel: string): any {
  const choice = openai.choices?.[0];
  const message = choice?.message;
  if (!message) return { type: "message", role: "assistant", content: [{ type: "text", text: "" }], model: originalModel, id: openai.id, stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  return {
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: message.content ?? "" }],
    model: openai.model ?? originalModel,
    id: openai.id ?? `msg_${Date.now()}`,
    stop_reason: choice?.finish_reason === "length" ? "max_tokens" : choice?.finish_reason ?? "end_turn",
    usage: openai.usage ? { input_tokens: openai.usage.prompt_tokens, output_tokens: openai.usage.completion_tokens } : { input_tokens: 0, output_tokens: 0 },
  };
}

async function getApiKeyForPlatform(platform: string): Promise<ApiKey | null> {
  const allKeys = await listApiKeys();
  const candidate = allKeys
    .filter((k) => k.enabled && k.status === "healthy" && k.platform === platform)
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""))[0];
  if (!candidate) return null;

  const secret = await decryptKey(candidate.encrypted_key!, candidate.iv!, candidate.auth_tag!).catch(() => null);
  if (!secret) return null;

  return {
    id: String(candidate.db_id),
    platform,
    label: candidate.label ?? platform,
    encrypted_key: secret,
    iv: "",
    auth_tag: "",
    status: candidate.status as "healthy",
    enabled: candidate.enabled,
    base_url: candidate.base_url,
    monthly_request_cap: candidate.monthly_request_cap ?? 0,
    monthly_token_cap: candidate.monthly_token_cap ?? 0,
    db_id: candidate.db_id,
  };
}

async function dispatchChat(body: ChatCompletionRequest, sessionId?: string): Promise<ProviderResult> {
  const parts = body.model.split("/");
  if (parts[0] === "auto" || parts[0] === "fusion") {
    const ctx = { request: body, available_keys: [], session_id: sessionId };
    return executeWithFallback(body, ctx);
  }
  const platform = parts[0];
  const modelId = parts.length > 1 ? parts.slice(1).join("/") : body.model;
  const apiKey = await getApiKeyForPlatform(platform);
  if (!apiKey) return { error: `No healthy key for platform ${platform}`, status: 503 };

  const adapter = getAdapterForPlatform(platform);
  if (!adapter) return { error: `Platform ${platform} not supported`, status: 503 };

  return executeChat({ ...body, model: modelId }, apiKey);
}

async function* anthropicStreamIterator(stream: AsyncIterable<ChatCompletionChunk>): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  let first = true;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (first) {
      yield encoder.encode(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${Date.now()}","type":"message","role":"assistant","content":[],"model":"${chunk.model}","usage":{"input_tokens":0,"output_tokens":0}}}\n\n`);
      yield encoder.encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
      first = false;
    }
    if (delta?.content) {
      const text = delta.content.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      yield encoder.encode(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`);
    }
    if (chunk.choices?.[0]?.finish_reason) {
      yield encoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
      yield encoder.encode(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${chunk.choices[0].finish_reason === "length" ? "max_tokens" : "end_turn"}"}}\n\n`);
      yield encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      break;
    }
  }
}

anthropicRouter.post("/messages", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: AnthropicRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "authentication_error", message: "Invalid JSON" } }, 400);
  }

  const systemPrompt = typeof body.system === "string" ? body.system :
    Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : undefined;
  const messages = body.messages.map(anthropicToOpenAI);
  if (systemPrompt) messages.unshift({ role: "system", content: systemPrompt });

  const openAIReq: ChatCompletionRequest = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
    user: body.metadata?.user_id,
  };

  // Resolve Anthropic family aliases to actual catalog models
  const resolved = await resolveAnthropicModel(openAIReq.model);
  if (resolved.pinned && resolved.modelId) {
    openAIReq.model = resolved.modelId;
  }
  // Note: tierDbIds could be used to restrict the fallback chain to a specific tier
  // For now, we pass the pinned model and let the router handle fallback

  try {
    const result = await dispatchChat(openAIReq, c.req.header("x-session-id") ?? undefined);
    if (result.error) {
      const status: number = result.status ?? 502;
      return c.json({ error: { type: "api_error", message: result.error } }, status as 400 | 500 | 502 | 503);
    }

    if (openAIReq.stream && result.stream) {
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const chunk of anthropicStreamIterator(result.stream!)) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    if (!result.response) throw new Error(`upstream returned no response body for ${body.model}`);

    const anthropicResp = openAIToAnthropic(result.response!, body.model);
    return c.json(anthropicResp);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "anthropic", "anthropic", 0, undefined, openAIReq, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "api_error", message: msg } }, 503);
  }
});

export default anthropicRouter;