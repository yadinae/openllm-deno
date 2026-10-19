/**
 * Ollama inbound gateway — /api/tags, /api/chat, /api/generate, /api/version
 */
import { Hono } from "hono";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { getAdapterForPlatform, executeChat } from "../providers/index.ts";
import type { ProviderResult, ApiKey } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const ollamaRouter = new Hono();

ollamaRouter.get("/api/tags", async (c) => {
  const allKeys = await listApiKeys();
  const models = allKeys
    .filter((k) => k.enabled && k.status === "healthy")
    .map((k) => ({
      name: `${k.platform}/default`,
      model: `${k.platform}/default`,
      modified_at: new Date().toISOString(),
      size: 0,
      digest: "",
      details: {
        parent_model: "",
        format: "gguf",
        family: k.platform,
        families: [k.platform],
        parameter_size: "unknown",
        quantization_level: "unknown",
      },
    }));

  return c.json({ models });
});

ollamaRouter.get("/api/version", async (c) => {
  return c.json({ version: "0.1.0-openllm-gateway" });
});

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  options?: { temperature?: number; top_p?: number; num_predict?: number };
}

function openAIToOllamaChat(openai: any, model: string): any {
  const choice = openai.choices?.[0];
  const message = choice?.message;
  return {
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: message?.content ?? "" },
    done: true,
    done_reason: choice?.finish_reason === "length" ? "length" : "stop",
    prompt_eval_count: openai.usage?.prompt_tokens ?? 0,
    eval_count: openai.usage?.completion_tokens ?? 0,
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

async function dispatchChat(body: any): Promise<ProviderResult> {
  const parts = body.model.split("/");
  if (parts[0] === "auto" || parts[0] === "fusion") {
    return { error: "auto/fusion not supported via Ollama endpoint", status: 400 };
  }
  const platform = parts[0];
  const modelId = parts.length > 1 ? parts.slice(1).join("/") : body.model;
  const apiKey = await getApiKeyForPlatform(platform);
  if (!apiKey) return { error: `No healthy key for platform ${platform}`, status: 503 };

  const adapter = getAdapterForPlatform(platform);
  if (!adapter) return { error: `Platform ${platform} not supported`, status: 503 };

  return executeChat({ ...body, model: modelId }, apiKey);
}

ollamaRouter.post("/api/chat", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: OllamaChatRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }

  if (!body.model || !body.messages?.length) {
    return c.json({ error: { message: "model and messages are required" } }, 400);
  }

  const openAIReq = {
    model: body.model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: body.options?.num_predict,
    temperature: body.options?.temperature,
    top_p: body.options?.top_p,
    stream: body.stream ?? false,
  };

  try {
    const result = await dispatchChat(openAIReq);
    if (result.error) {
      return c.json({ error: { message: result.error } }, (result.status ?? 500) as 400 | 500 | 502 | 503);
    }

    if (openAIReq.stream && result.stream) {
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for await (const chunk of result.stream!) {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              controller.enqueue(encoder.encode(JSON.stringify({
                model: body.model,
                created_at: new Date().toISOString(),
                message: { role: "assistant", content: delta.content },
                done: false,
              }) + "\n"));
            }
            if (chunk.choices?.[0]?.finish_reason) {
              controller.enqueue(encoder.encode(JSON.stringify({
                model: body.model,
                created_at: new Date().toISOString(),
                message: { role: "assistant", content: "" },
                done: true,
                done_reason: chunk.choices[0].finish_reason,
              }) + "\n"));
              break;
            }
          }
          controller.close();
        },
      });
      return new Response(readable, { headers: { "Content-Type": "application/x-ndjson" } });
    }

    return c.json(openAIToOllamaChat(result.response, body.model));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "ollama", "ollama", 0, undefined, openAIReq as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { message: msg } }, 503);
  }
});

ollamaRouter.post("/api/generate", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: { model: string; prompt: string; stream?: boolean; options?: any };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }

  if (!body.model || !body.prompt) {
    return c.json({ error: { message: "model and prompt are required" } }, 400);
  }

  const openAIReq = {
    model: body.model,
    messages: [{ role: "user", content: body.prompt }],
    max_tokens: body.options?.num_predict,
    temperature: body.options?.temperature,
    top_p: body.options?.top_p,
    stream: body.stream ?? false,
  };

  try {
    const result = await dispatchChat(openAIReq);
    if (result.error) {
      return c.json({ error: { message: result.error } }, (result.status ?? 500) as 400 | 500 | 502 | 503);
    }

    if (openAIReq.stream && result.stream) {
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for await (const chunk of result.stream!) {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              controller.enqueue(encoder.encode(JSON.stringify({
                model: body.model,
                created_at: new Date().toISOString(),
                response: delta.content,
                done: false,
              }) + "\n"));
            }
            if (chunk.choices?.[0]?.finish_reason) {
              controller.enqueue(encoder.encode(JSON.stringify({
                model: body.model,
                created_at: new Date().toISOString(),
                response: "",
                done: true,
                done_reason: chunk.choices[0].finish_reason,
              }) + "\n"));
              break;
            }
          }
          controller.close();
        },
      });
      return new Response(readable, { headers: { "Content-Type": "application/x-ndjson" } });
    }

    const choice = result.response?.choices?.[0];
    return c.json({
      model: body.model,
      created_at: new Date().toISOString(),
      response: choice?.message?.content ?? "",
      done: true,
      done_reason: choice?.finish_reason === "length" ? "length" : "stop",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "ollama", "ollama", 0, undefined, openAIReq as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { message: msg } }, 503);
  }
});

export default ollamaRouter;