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
geminiRouter.get("/models", async (c) => {
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
geminiRouter.get("/models/*", async (c) => {
  const modelPath = c.req.path.replace("/models/", "");
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
  const match = path.match(/\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)/);
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

/** Parse embedContent request */
interface GeminiEmbedContentRequest {
  content: {
    parts: Array<{ text: string }>;
  };
  task_type?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY" | "CLASSIFICATION" | "CLUSTERING";
  title?: string;
}

/** Handle embedContent — POST /v1beta/models/{model}:embedContent */
async function handleEmbedContent(c: any) {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  const path = c.req.path;
  const match = path.match(/\/models\/([^:]+):embedContent/);
  if (!match) {
    return c.json({ error: { code: 400, message: "Invalid model path" } }, 400);
  }
  const modelName = match[1];

  let body: GeminiEmbedContentRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 400, message: "Invalid JSON" } }, 400);
  }

  if (!body.content?.parts?.length) {
    return c.json({ error: { code: 400, message: "content.parts is required" } }, 400);
  }

  // Build full model ID (platform/model) — default to google if no platform prefix
  const modelParts = modelName.split("/");
  const fullModel = modelParts.length > 1 ? modelName : `google/${modelName}`;

  const parts = fullModel.split("/");
  const platform = parts[0];
  const modelId = parts.slice(1).join("/");

  const adapter = getAdapterForPlatform(platform);
  if (!adapter || typeof (adapter as any).embeddings !== "function") {
    return c.json({ error: { code: 503, message: `Embeddings not supported for ${platform}` } }, 503);
  }

  const apiKey = await getApiKeyForPlatform(platform);
  if (!apiKey) return c.json({ error: { code: 503, message: `No healthy key for ${platform}` } }, 503);

  try {
    const result = await (adapter as any).embeddings({ model: modelId, input: [body.content.parts[0].text] }, apiKey);
    const embedding = result.response?.data?.[0]?.embedding ?? [];

    return c.json({
      embedding: {
        values: embedding,
      },
      metadata: {
        totalTokenCount: result.response?.usage?.prompt_tokens ?? 0,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, platform, platform, 0, undefined, { model: modelId, messages: [{ role: "user", content: body.content.parts[0].text }] } as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { code: 503, message: msg } }, 503);
  }
}

/** Parse generateImage request (maps to providers that support image generation) */
interface GeminiGenerateImageRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
}

/** Handle generateImage — POST /v1beta/models/{model}:generateImage */
async function handleGenerateImage(c: any) {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  const path = c.req.path;
  const match = path.match(/\/models\/([^:]+):generateImage/);
  if (!match) {
    return c.json({ error: { code: 400, message: "Invalid model path" } }, 400);
  }
  const modelName = match[1];

  let body: GeminiGenerateImageRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 400, message: "Invalid JSON" } }, 400);
  }

  if (!body.prompt) {
    return c.json({ error: { code: 400, message: "prompt is required" } }, 400);
  }

  // Build full model ID (platform/model) — default to google if no platform prefix
  const modelParts = modelName.split("/");
  const fullModel = modelParts.length > 1 ? modelName : `google/${modelName}`;

  const parts = fullModel.split("/");
  const platform = parts[0];
  const modelId = parts.slice(1).join("/");

  const adapter = getAdapterForPlatform(platform);
  if (!adapter || typeof (adapter as any).generateImage !== "function") {
    return c.json({ error: { code: 503, message: `Image generation not supported for ${platform}` } }, 503);
  }

  const apiKey = await getApiKeyForPlatform(platform);
  if (!apiKey) return c.json({ error: { code: 503, message: `No healthy key for ${platform}` } }, 503);

  try {
    const result = await (adapter as any).generateImage({ model: modelId, prompt: body.prompt, n: body.n, size: body.size, quality: body.quality, style: body.style }, apiKey);
    const images = result.response?.data ?? [];

    return c.json({
      generatedImages: images.map((img: any, i: number) => ({
        image: {
          imageBytes: img.b64_json ? img.b64_json : img.url,
          mimeType: "image/png",
        },
        generationMetadata: {
          prompt: body.prompt,
          modelVersion: modelId,
          seed: i,
        },
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, platform, platform, 0, undefined, { model: modelId, messages: [{ role: "user", content: body.prompt }] } as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { code: 503, message: msg } }, 503);
  }
}

// Custom route handler for /models/* with colon actions
// Hono doesn't match colon in path params, so we use a catch-all and dispatch manually
const GEMINI_ACTIONS = [":generateContent", ":streamGenerateContent", ":countTokens", ":embedContent", ":generateImage"];

function matchGeminiAction(path: string): string | null {
  for (const action of GEMINI_ACTIONS) {
    if (path.includes(action)) return action;
  }
  return null;
}

// Custom route handler for /models/* with colon actions — Hono doesn't match colon in path params, so we use a catch-all and dispatch manually
const GEMINI_ACTIONS = [":generateContent", ":streamGenerateContent", ":countTokens", ":embedContent", ":generateImage"];

function matchGeminiAction(path: string): string | null {
  for (const action of GEMINI_ACTIONS) {
    if (path.includes(action)) return action;
  }
  return null;
}

// Handle /models/* with colon actions — Hono's /models/** only matches paths
// with at least one path segment after /models. Register explicit routes to
// ensure /models/foo also reaches the handler (so we can return 400 "Invalid model path"
// instead of the SPA 404).
geminiRouter.post("/models/*", async (c) => {
  const path = c.req.path;
  const action = matchGeminiAction(path);
  if (action === ":embedContent") return handleEmbedContent(c);
  if (action === ":generateImage") return handleGenerateImage(c);
  return handleGenerateContent(c, false);
});
geminiRouter.post("/models/**", async (c) => {
  const path = c.req.path;
  const action = matchGeminiAction(path);
  if (action === ":embedContent") return handleEmbedContent(c);
  if (action === ":generateImage") return handleGenerateImage(c);
  return handleGenerateContent(c, false);
});

export default geminiRouter;