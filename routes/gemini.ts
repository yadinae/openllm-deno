/**
 * Gemini Native Protocol — /v1beta/models/{model}:generateContent|streamGenerateContent|countTokens
 * Inbound gateway for native Gemini Generative Language API calls.
 *
 * Maps native Gemini requests to internal providers (which may be Gemini or other providers).
 * This allows clients using the official Google AI SDK to connect via OpenLLM gateway.
 */
import { Hono } from "hono";
import { listApiKeys } from "../db/pg.ts";
import { decryptKey } from "../db/mod.ts";
import { getAdapterForPlatform, executeChat } from "../providers/index.ts";
import type { ProviderResult, ApiKey } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const geminiRouter = new Hono();

/** List available models — native /v1beta/models endpoint */
geminiRouter.get("/v1beta/models", async (c) => {
  const allKeys = await listApiKeys();
  const models = allKeys
    .filter((k) => k.enabled && k.status === "healthy")
    .map((k) => ({
      name: `models/${k.platform}/default`,
      displayName: k.platform,
      description: `${k.platform} default model via OpenLLM`,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    }));

  return c.json({ models });
});

/** Get single model info — /v1beta/models/{model} */
geminiRouter.get("/v1beta/models/*", async (c) => {
  const modelPath = c.req.path.replace("/v1beta/models/", "");
  const allKeys = await listApiKeys();
  const model = allKeys
    .filter((k) => k.enabled && k.status === "healthy")
    .find((k) => modelPath.startsWith(k.platform));

  if (!model) {
    return c.json({ error: { code: 404, message: "Model not found" } }, 404);
  }

  return c.json({
    name: `models/${model.platform}/default`,
    displayName: model.platform,
    description: `${model.platform} default model via OpenLLM`,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  });
});

/** Parse native Gemini request body */
interface GeminiGenerateContentRequest {
  contents: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }>;
  system_instruction?: {
    parts: Array<{ text: string }>;
  };
  generation_config?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    max_output_tokens?: number;
    stop_sequences?: string[];
  };
  tools?: Array<{
    function_declarations: Array<{
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
  tool_config?: {
    function_calling_config?: {
      mode: "auto" | "any" | "none";
      allowed_function_names?: string[];
    };
  };
  safety_settings?: Array<{
    category: string;
    threshold: string;
  }>;
}

interface GeminiCountTokensRequest {
  contents: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }>;
}

/** Convert native Gemini request to OpenAI-compatible format */
function geminiToOpenAI(req: GeminiGenerateContentRequest, modelId: string, stream: boolean) {
  const systemMessages = req.system_instruction?.parts.map((p) => p.text).join("\n") ?? "";
  const contents = req.contents.map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: c.parts.map((p) => p.text).join(""),
  }));

  const messages = [
    ...(systemMessages ? [{ role: "system" as const, content: systemMessages }] : []),
    ...contents,
  ];

  return {
    model: modelId,
    messages,
    temperature: req.generation_config?.temperature,
    top_p: req.generation_config?.top_p,
    max_tokens: req.generation_config?.max_output_tokens,
    stream,
  };
}

/** Convert OpenAI response to native Gemini format */
function openAIToGemini(openai: any, modelId: string) {
  const choice = openai.choices?.[0];
  const message = choice?.message;

  return {
    candidates: [
      {
        content: {
          parts: [{ text: message?.content ?? "" }],
          role: "model",
        },
        finishReason: choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP",
        index: choice?.index ?? 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: openai.usage?.prompt_tokens ?? 0,
      candidatesTokenCount: openai.usage?.completion_tokens ?? 0,
      totalTokenCount: openai.usage?.total_tokens ?? 0,
    },
  };
}

/** Get API key for a platform */
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

/** Dispatch chat to appropriate provider */
async function dispatchChat(body: any): Promise<ProviderResult> {
  const parts = body.model.split("/");
  if (parts[0] === "auto" || parts[0] === "fusion") {
    return { error: "auto/fusion not supported via native Gemini endpoint", status: 400 };
  }
  const platform = parts[0];
  const modelId = parts.length > 1 ? parts.slice(1).join("/") : body.model;
  const apiKey = await getApiKeyForPlatform(platform);
  if (!apiKey) return { error: `No healthy key for platform ${platform}`, status: 503 };

  const adapter = getAdapterForPlatform(platform);
  if (!adapter) return { error: `Platform ${platform} not supported`, status: 503 };

  return executeChat({ ...body, model: modelId }, apiKey);
}

/**
 * Handle generateContent / streamGenerateContent / countTokens
 * Path: POST /v1beta/models/{model}:generateContent|streamGenerateContent|countTokens
 */
async function handleGenerateContent(c: any, _streamHint: boolean) {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  // Extract model and action from path: /v1beta/models/google/gemini-1.5-flash:generateContent
  const path = c.req.path;
  const match = path.match(/\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)/);
  if (!match) {
    return c.json({ error: { code: 400, message: "Invalid model path" } }, 400);
  }
  const modelName = match[1]; // e.g., "gemini-1.5-flash" or "google/gemini-1.5-flash"
  const action = match[2]; // "generateContent" | "streamGenerateContent" | "countTokens"
  const stream = action === "streamGenerateContent";

  // countTokens uses different request/response format
  if (action === "countTokens") {
    return handleCountTokens(c, modelName, vRequestId, vStart);
  }

  let body: GeminiGenerateContentRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 400, message: "Invalid JSON" } }, 400);
  }

  if (!body.contents?.length) {
    return c.json({ error: { code: 400, message: "contents is required" } }, 400);
  }

  // Build full model ID (platform/model) — default to google if no platform prefix
  const modelParts = modelName.split("/");
  const fullModel = modelParts.length > 1 ? modelName : `google/${modelName}`;

  const openAIReq = geminiToOpenAI(body, fullModel, stream);

  try {
    const result = await dispatchChat(openAIReq);
    if (result.error) {
      return c.json({ error: { code: result.status ?? 500, message: result.error } }, (result.status ?? 500) as 400 | 500 | 502 | 503);
    }

    if (stream && result.stream) {
      // Stream native Gemini SSE format
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of result.stream!) {
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                const geminiChunk = {
                  candidates: [{
                    content: { parts: [{ text: delta.content }], role: "model" },
                    finishReason: null,
                    index: 0,
                  }],
                  usageMetadata: null,
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(geminiChunk)}\n\n`));
              }
              if (chunk.choices?.[0]?.finish_reason) {
                const finalChunk = {
                  candidates: [{
                    content: { parts: [{ text: "" }], role: "model" },
                    finishReason: chunk.choices[0].finish_reason === "length" ? "MAX_TOKENS" : "STOP",
                    index: 0,
                  }],
                  usageMetadata: {
                    promptTokenCount: 0,
                    candidatesTokenCount: 0,
                    totalTokenCount: 0,
                  },
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                break;
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { code: 500, message: msg } })}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(readable, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Goog-API-Format-Version": "v1beta",
        },
      });
    }

    return c.json(openAIToGemini(result.response, modelName));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "google", "google", 0, undefined, openAIReq as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { code: 503, message: msg } }, 503);
  }
}

/** Handle countTokens */
async function handleCountTokens(c: any, modelName: string, vRequestId: string, vStart: number) {
  let body: GeminiCountTokensRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 400, message: "Invalid JSON" } }, 400);
  }

  if (!body.contents?.length) {
    return c.json({ error: { code: 400, message: "contents is required" } }, 400);
  }

  // Rough token estimation (4 chars per token for Gemini)
  let totalChars = 0;
  for (const content of body.contents) {
    for (const part of content.parts) {
      totalChars += part.text?.length ?? 0;
    }
  }
  const totalTokens = Math.ceil(totalChars / 4);

  return c.json({
    totalTokens,
    totalBillableCharacters: totalChars,
  });
}

// GenerateContent / streamGenerateContent / countTokens (catch-all, parse action in handler)
geminiRouter.post("/v1beta/models/*", async (c) => handleGenerateContent(c, false));

export default geminiRouter;