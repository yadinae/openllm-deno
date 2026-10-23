/**
 * Embeddings inbound — /v1/embeddings
 * Routes to services/embeddings.ts (runEmbeddings).
 *
 * Ported from FreeLLMAPI routes/embeddings.ts (286 lines, 11KB).
 * Now supports family-based failover, model listing, and usage tracking.
 */
import { Hono } from "hono";
import type { ChatCompletionRequest } from "../providers/types.ts";
import { traceRouteEvent } from "../services/proxy-helpers.ts";
import { runEmbeddings, listEmbeddingModels, getEmbeddingLogs, EmbeddingsError } from "../services/embeddings.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const embeddingsRouter = new Hono();

embeddingsRouter.post("/embeddings", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: { model: string; input: string | string[]; encoding_format?: "float" | "base64"; dimensions?: number; user?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }

  if (!body.input) {
    return c.json({ error: { type: "invalid_request_error", message: "input is required" } }, 400);
  }

  // Normalize input to array of strings
  const inputs = Array.isArray(body.input)
    ? body.input.map((s) => String(s))
    : [String(body.input)];

  // Validate input size
  if (inputs.length === 0) {
    return c.json({ error: { type: "invalid_request_error", message: "input cannot be empty" } }, 400);
  }

  // Pre-flight trace
  traceRouteEvent("Proxy", {
    event: "start",
    requestId: vRequestId,
    attempt: 0,
    platform: body.model?.split("/")[0] ?? "auto",
    model: body.model ?? "auto",
  });

  try {
    const result = await runEmbeddings(body.model, inputs, body.dimensions);
    traceRouteEvent("Proxy", {
      event: "ok",
      requestId: vRequestId,
      attempt: 1,
      platform: result.platform,
      model: result.modelId,
      inputTokens: result.inputTokens,
    });

    // Format OpenAI-compatible response
    return c.json({
      object: "list",
      data: result.vectors.map((emb, idx) => ({
        object: "embedding",
        index: idx,
        embedding: emb,
        // Include provider metadata (FreeLLMAPI parity)
        ...(idx === 0
          ? {
              _routed_via: {
                platform: result.platform,
                model: result.modelId,
                family: result.family,
              },
            }
          : {}),
      })),
      model: result.modelId,
      usage: {
        prompt_tokens: result.inputTokens,
        total_tokens: result.inputTokens,
        ...(result.inputTokens === 0 ? { estimated: true } : {}),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e instanceof EmbeddingsError ? e.status : 503;
    const is429 = e instanceof EmbeddingsError && e.status === 429;
    const retryAfter = is429
      ? e instanceof EmbeddingsError && e.retryAfterMs
        ? Math.ceil((e.retryAfterMs as number) / 1000)
        : undefined
      : undefined;

    traceRouteEvent("Proxy", {
      event: "fail",
      requestId: vRequestId,
      attempt: 1,
      platform: body.model?.split("/")[0] ?? "auto",
      model: body.model ?? "auto",
      error: msg.slice(0, 200),
    });

    await requestLogger.logComplete(
      vRequestId, "embeddings", "embeddings", 0, undefined,
      { model: body.model, input: body.input } as unknown as ChatCompletionRequest, null,
      Date.now() - vStart, status, msg,
    );

    const headers: Record<string, string> = {};
    if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
    return c.json({ error: { type: "server_error", message: msg } }, status as 429 | 503, headers);
  }
});

/** List available embedding models */
embeddingsRouter.get("/embeddings/models", async (c) => {
  const models = await listEmbeddingModels();
  return c.json({
    object: "list",
    data: models.map((m) => ({
      id: m.model_id,
      family: m.family,
      platform: m.platform,
      dimensions: m.dimensions,
      max_input_tokens: m.max_input_tokens,
      priority: m.priority,
      quota_label: m.quota_label,
    })),
  });
});

/** Per-model usage stats (request log based) */
embeddingsRouter.get("/embeddings/usage", async (c) => {
  const logs = getEmbeddingLogs(200);
  const byFamily = new Map<string, { platform: string; requestsToday: number; tokensMonth: number }>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  for (const log of logs) {
    const ts = new Date(log.timestamp);
    const key = log.model;
    if (!byFamily.has(key)) {
      byFamily.set(key, { platform: log.platform, requestsToday: 0, tokensMonth: 0 });
    }
    const entry = byFamily.get(key)!;
    if (ts >= today) entry.requestsToday++;
    if (ts >= monthStart) entry.tokensMonth += log.inputTokens;
  }

  return c.json({
    families: Array.from(byFamily.entries()).map(([model, stats]) => ({
      family: model,
      platform: stats.platform,
      requestsToday: stats.requestsToday,
      tokensMonth: stats.tokensMonth,
    })),
    totalRequestsToday: Array.from(byFamily.values()).reduce((s, f) => s + f.requestsToday, 0),
    totalTokensMonth: Array.from(byFamily.values()).reduce((s, f) => s + f.tokensMonth, 0),
  });
});

export default embeddingsRouter;
