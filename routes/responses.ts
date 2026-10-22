/**
 * OpenAI Responses API inbound — /v1/responses
 * Converts Responses API format → OpenAI chat format → routes via gateway → converts response back.
 */
import { Hono } from "hono";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from "../providers/types.ts";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { getAdapterForPlatform, executeChat } from "../providers/index.ts";
import type { ProviderResult, ApiKey } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";
import { executeWithFallback } from "../services/router.ts";

const responsesRouter = new Hono();

interface ResponsesRequest {
  model: string;
  input: string | Array<{ role: string; content: string }>;
  instructions?: string;
  tools?: any[];
  tool_choice?: any;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  user?: string;
}

function responsesToOpenAI(input: ResponsesRequest["input"], instructions?: string): any[] {
  const messages: any[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: item.content });
    }
  }
  return messages;
}

function openAIToResponses(openai: ChatCompletionResponse, originalModel: string): any {
  const choice = openai.choices?.[0];
  const message = choice?.message;
  return {
    id: openai.id ?? `resp_${Date.now()}`,
    object: "response",
    created_at: openai.created ?? Math.floor(Date.now() / 1000),
    model: openai.model ?? originalModel,
    output: message ? [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content ?? "" }],
    }] : [],
    usage: openai.usage ? { input_tokens: openai.usage.prompt_tokens, output_tokens: openai.usage.completion_tokens } : undefined,
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

async function dispatchChat(body: ChatCompletionRequest): Promise<ProviderResult> {
  const parts = body.model.split("/");
  if (parts[0] === "auto" || parts[0] === "fusion") {
    const ctx = { request: body, available_keys: [] };
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

async function* responsesStreamIterator(stream: AsyncIterable<ChatCompletionChunk>, model: string): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  let seq = 0;
  yield encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now()/1000), model, output: [], usage: null }, sequence_number: seq++ })}\n\n`);
  yield encoder.encode(`data: ${JSON.stringify({ type: "response.in_progress", response: { id: `resp_${Date.now()}`, object: "response", status: "in_progress" }, sequence_number: seq++ })}\n\n`);
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      yield encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: { type: "output_text", text: delta.content }, response: { id: `resp_${Date.now()}`, object: "response" }, sequence_number: seq++ })}\n\n`);
    }
    if (chunk.choices?.[0]?.finish_reason) break;
  }
  yield encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${Date.now()}`, object: "response", status: "completed" }, sequence_number: seq++ })}\n\n`);
}

responsesRouter.post("/responses", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: ResponsesRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }

  const messages = responsesToOpenAI(body.input, body.instructions);
  const openAIReq: ChatCompletionRequest = {
    model: body.model,
    messages,
    max_tokens: body.max_output_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
    user: body.user,
  };

  try {
    const result = await dispatchChat(openAIReq);
    if (result.error) {
      const status: number = result.status ?? 502;
      return c.json({ error: { type: "api_error", message: result.error } }, status as 400 | 500 | 502 | 503);
    }

    if (openAIReq.stream && result.stream) {
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const chunk of responsesStreamIterator(result.stream!, openAIReq.model)) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    if (!result.response) throw new Error(`upstream returned no response body for ${openAIReq.model}`);

    const resp = openAIToResponses(result.response!, openAIReq.model);
    return c.json(resp);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "responses", "responses", 0, undefined, openAIReq, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "api_error", message: msg } }, 503);
  }
});

export default responsesRouter;