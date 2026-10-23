/**
 * /v1/chat/completions route - OpenAI-compatible chat completions.
 * Uses ProviderRegistry for unified provider abstraction.
 */

import { Hono } from "hono";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.ts";
import type { DbData, DbEntry } from "../db/mod.ts";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys, getSetting } from "../db/pg.ts";
import { executeChat, getAdapterForPlatform } from "../providers/index.ts";
import type { ProviderResult, ApiKey, RoutingContext } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";
import { smartRouter, executeWithFallback } from "../services/router.ts";
import { runFusion, type FusionConfig } from "../services/fusion.ts";
import {
  runPreflight,
  hasEnabledVisionModel,
  hasEnabledToolsModel,
  injectRoutedVia,
  buildRoutedViaHeader,
  logProxySuccess,
  logProxyFailure,
} from "../services/proxy-engine.ts";
import {
  traceRouteEvent,
  isRetryableError,
  isModelNotFoundError,
  isPaymentRequiredError,
  isClientAbortError,
} from "../services/proxy-helpers.ts";

// Serialize an adapter stream (raw SSE bytes OR parsed chunk iterator) to the
// client as SSE. Shared by the virtual-model branch and the prefix branch.
function sseFromStream(stream: unknown): Response {
  const encoder = new TextEncoder();
  const source = stream as any;
  const body_stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (typeof source?.getReader === "function") {
          const reader = source.getReader() as ReadableStreamDefaultReader<Uint8Array>;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } else {
          const it = source[Symbol.asyncIterator]();
          for (;;) {
            const { done, value } = await it.next();
            if (done) break;
            if (value) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      } catch (err) {
        console.error("[chat] Stream error:", err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { type: "server_error", message: String(err) } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      controller.close();
    },
  });
  return new Response(body_stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Whole-response → single SSE chunk stream, for paths that fan out internally.
function sseFromResponse(resp: Record<string, unknown> | null, model: string): Response {
  const chunk = {
    ...(resp ?? { choices: [] }),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: (resp?.model as string) ?? model,
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } },
  );
}


export const chatRouter = new Hono<{ Variables: { db: DbData } }>();

/** Load keys from Postgres, falling back to the in-memory file DB. */
async function loadKeys(fallback: DbData): Promise<DbEntry[]> {
  try {
    const rows = await listApiKeys();
    if (rows.length) return rows;
  } catch (e) {
    console.error("[chat] Postgres listApiKeys failed, using in-memory keys:", e);
  }
  return fallback.api_keys.map((k, i) => ({
    id: String(k.platform),
    db_id: Number.isFinite(k.id) ? k.id : (i + 1),
    platform: k.platform,
    label: k.label,
    encrypted_key: k.encrypted_key,
    iv: k.iv,
    auth_tag: k.auth_tag,
    status: k.status,
    enabled: k.enabled,
    base_url: k.base_url,
  }));
}

chatRouter.post("/chat/completions", async (c) => {
  const db = c.get("db");
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return c.json({ error: { type: "invalid_request_error", message: "messages are required" } }, 400);
  }

  // An omitted `model` means "let the router choose" — the playground SPA sends
  // no model field at all when the model picker is on "auto"
  // (`g !== 'auto' && (f.model = g)` in the built bundle), and FreeLLMAPI
  // treated a missing model as auto-routing. Rejecting it here made the
  // playground's default state fail with "model and messages are required"
  // before the `auto` branch below could ever run.
  if (!body.model) {
    body.model = "auto";
  }

  // ── Proxy pre-flight (FreeLLMAPI parity) ──────────────────────────────────
  // Normalize messages, count images, estimate tokens, check vision/tools gates.
  // Run before routing so we can short-circuit with clear errors.
  const preflight = runPreflight(body);
  const requestId = preflight.requestId;
  const executionId = preflight.executionId;
  const abortController = preflight.abortController;
  const clientGoneFlag = preflight.clientGoneFlag;

  // Attach requestId to response headers for client-side correlation
  c.header("X-Request-ID", requestId);

  // Vision gate: reject early if images but no vision model
  if (preflight.hasImage) {
    const visionOk = await hasEnabledVisionModel();
    if (!visionOk) {
      traceRouteEvent("Proxy", {
        event: "fail",
        requestId,
        attempt: 0,
        platform: "auto",
        model: "auto",
        error: "no_vision_model",
      });
      return c.json({
        error: {
          message: "This request includes an image, but no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain.",
          type: "invalid_request_error",
          code: "no_vision_model",
        },
        execution_id: executionId,
      }, 422);
    }
  }

  // Tools gate: reject early if tools but no tool-capable model
  if (preflight.wantsTools) {
    const toolsOk = await hasEnabledToolsModel();
    if (!toolsOk) {
      traceRouteEvent("Proxy", {
        event: "fail",
        requestId,
        attempt: 0,
        platform: "auto",
        model: "auto",
        error: "no_tools_model",
      });
      return c.json({
        error: {
          message: "This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model (e.g. GPT-OSS 120B, Gemini 3.5 Flash, GLM-4.7) in the Fallback Chain.",
          type: "invalid_request_error",
          code: "no_tools_model",
        },
        execution_id: executionId,
      }, 422);
    }
  }

  // Pre-flight trace
  traceRouteEvent("Proxy", {
    event: "start",
    requestId,
    attempt: 0,
    platform: "auto",
    model: body.model,
    requestedModel: body.model,
  });

  // ── Virtual models (FreeLLMAPI parity) ──────────────────────────────────
  // "auto": SmartRouter bandit scoring across every enabled key + fallback
  // chain retry. "fusion": panel fan-out with tool-call voting and optional
  // judge synthesis. Both bypass the platform-prefix routing below.
  if (body.model === "auto" || body.model === "fusion") {
    const keys = await loadKeys(db);
    const vRequestId = generateRequestId();
    const vStart = Date.now();
    traceRouteEvent("Proxy", {
      event: "start",
      requestId: vRequestId,
      attempt: 0,
      platform: "auto",
      model: body.model,
      requestedModel: body.model,
    });
    try {
      const ctx: RoutingContext = { request: body, available_keys: keys as any, session_id: c.req.header("x-session-id") ?? undefined };
      if (body.model === "fusion") {
        const decision = await smartRouter.route(ctx);
        const storedCfg = ((await getSetting<Record<string, unknown>>("fusion_config")) ?? {}) as Partial<FusionConfig>;
        const inlineCfg = ((body as unknown as Record<string, unknown>).fusion as Partial<FusionConfig>) ?? {};
        // fallback_chain intentionally excludes the routed primary (single-shot
        // retry semantics), but a fusion panel wants the best candidate too —
        // re-inject it ahead of the chain before panel selection.
        decision.fallback_chain = [
          {
            provider: decision.provider.id,
            model: decision.model,
            key_id: decision.key.id,
            priority: 0,
            reason: "fusion-primary",
            score: (decision.metadata as Record<string, unknown> | undefined)?.score as number | undefined,
          } as unknown as typeof decision.fallback_chain[number],
          ...decision.fallback_chain,
        ];
        const fr = await runFusion({ ...body, stream: false } as typeof body, { ...storedCfg, ...inlineCfg }, decision);
        await requestLogger.logComplete(
          vRequestId, "fusion", "fusion", 0, undefined, body, fr.response,
          Date.now() - vStart, 200, undefined, true,
          fr.metadata.panelSize, fr.metadata.judgeUsed, fr.metadata.strategy,
        );
        if (body.stream) {
          return sseFromResponse(fr.response as unknown as Record<string, unknown>, body.model);
        }
        return c.json({
          ...fr.response,
          _fusion: {
            ...fr.metadata,
            panel: fr.panelResponses.map((p) => ({
              platform: p.member.provider,
              model: p.member.model,
              latency_ms: p.latencyMs,
              error: p.error ?? null,
            })),
          },
        });
      }
      const res = await executeWithFallback(body, ctx);
      const statusCode = res.error ? (res.status ?? 502) : 200;
      // Extract strategy label from _routed_via.reason for the request audit
      // trail. The router embeds `strategy=<preset>` in every routing reason,
      // so `strategy` in the requests table records what the decision model
      // (or configured default) chose for this request.
      const routedVia = (res.response as unknown as Record<string, unknown> | null)?._routed_via as { platform?: string; model?: string; reason?: string } | undefined;
      const strategyMatch = routedVia?.reason?.match(/strategy=(\w+)/);
      const routedStrategy = strategyMatch ? strategyMatch[1] : undefined;
      const routedModel = routedVia ? `${routedVia.platform}/${routedVia.model}` : "auto";
      traceRouteEvent("Proxy", {
        event: res.error ? "fail" : "ok",
        requestId: vRequestId,
        attempt: 1,
        platform: routedVia?.platform ?? "auto",
        model: routedVia?.model ?? "auto",
        requestedModel: body.model,
        latencyMs: Date.now() - vStart,
        inputTokens: body.messages?.reduce((n: number, m: any) => n + (m.content?.length ?? 0) / 4, 0),
        outputTokens: res.response?.usage?.completion_tokens,
        error: res.error,
      });
      await requestLogger.logComplete(
        vRequestId, "auto", "auto", 0, undefined, body, res.response ?? null,
        Date.now() - vStart, statusCode, res.error, false, undefined, undefined, routedStrategy,
      );
      if (res.error) {
        // Standard error shape: { error: { message, type } }. The SPA reads
        // err.error?.message; a bare string made every failure read as
        // "unknown error" because the message was unreachable.
        const detail = res.error;
        return c.json({
          error: {
            type: statusCode >= 500 ? "server_error" : "invalid_request_error",
            message: detail,
            ...(res.provider_metadata?.exhausted_chain
              ? { exhausted_chain: true, attempts: res.provider_metadata.attempts }
              : {}),
          },
        }, statusCode as 400 | 500 | 502 | 503);
      }
      if (body.stream && (res as { stream?: unknown }).stream) {
        return sseFromStream((res as { stream: unknown }).stream);
      }
      if (body.stream) {
        return sseFromResponse((res.response ?? null) as Record<string, unknown> | null, body.model);
      }
      return c.json(res.response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await requestLogger.logComplete(
        vRequestId, body.model, body.model, 0, undefined, body, null,
        Date.now() - vStart, 503, msg,
      );
      return c.json({
        error: {
          type: "server_error",
          message: `${body.model} routing failed: ${msg}`,
        },
      }, 503);
    }
  }

  const allKeys = await loadKeys(db);
  const modelParts = body.model.split("/");
  const platform = modelParts[0];
  const modelId = modelParts.length > 1 ? modelParts.slice(1).join("/") : body.model;
  const enabled = allKeys.filter((k) => k.enabled);
  const candidates = enabled.filter((k) => k.platform === platform);
  const keyEntry = candidates[0] ?? enabled[0];

  if (!keyEntry) {
    return c.json({ error: { type: "configuration_error", message: "No API keys configured" } }, 503);
  }

  let secret: string | null = null;
  if (keyEntry.encrypted_key && keyEntry.iv && keyEntry.auth_tag) {
    secret = await decryptKey(keyEntry.encrypted_key, keyEntry.iv, keyEntry.auth_tag).catch(() => null);
  }
  if (!secret) {
    return c.json({ error: { type: "configuration_error", message: `Failed to decrypt key for ${platform}` } }, 500);
  }

  // Build ApiKey object for the provider adapter
  const apiKey: ApiKey = {
    id: keyEntry.id,
    db_id: keyEntry.db_id,
    platform: keyEntry.platform,
    label: keyEntry.label ?? keyEntry.platform,
    encrypted_key: secret, // Already decrypted
    iv: "",
    auth_tag: "",
    status: keyEntry.status as "healthy" | "error" | "rate_limited" | "invalid",
    enabled: keyEntry.enabled,
    base_url: keyEntry.base_url ?? "",
    monthly_request_cap: 0,
    monthly_token_cap: 0,
  };

  // Create a new request with the model ID stripped of platform prefix
  const providerRequest: ChatCompletionRequest = {
    ...body,
    model: modelId,
  };

  // Generate request ID for logging
  const explicitRequestId = generateRequestId();
  const startTime = Date.now();
  const fused = false; // TODO: track fusion usage
  const panelSize = undefined;
  const judgeUsed = false;
  const strategy = undefined;

  // Estimate input tokens for logging
  let inputTokens = 0;
  for (const msg of body.messages) {
    inputTokens += (msg.content?.length ?? 0) / 4;
  }
  inputTokens = Math.ceil(inputTokens);

  // Use the new unified executeChat function
  const result: ProviderResult = await executeChat(providerRequest, apiKey);

  const latencyMs = Date.now() - startTime;
  const statusCode = result.error ? (result.status ?? 500) : 200;
  const outputTokens = result.response?.usage?.completion_tokens ?? 0;

  // Log request/response
  await requestLogger.logComplete(
    explicitRequestId,
    platform,
    modelId,
    keyEntry.db_id,
    undefined, // client_id - TODO: extract from auth
    body,
    result.response ?? null,
    latencyMs,
    statusCode,
    result.error,
    fused,
    panelSize,
    judgeUsed,
    strategy
  );

  if (result.error) {
    const status = (result.status ?? 500) as 400 | 500 | 502 | 503;
    return c.json({
      error: {
        type: status >= 500 ? "server_error" : "invalid_request_error",
        message: result.error,
      },
    }, status);
  }

  // Real SSE pass-through when the client asked for a stream.
  if (body.stream && result.stream) {
    const encoder = new TextEncoder();
    const modelTag = result.response?.model ?? body.model;
    const created = Math.floor(Date.now() / 1000);
    const source = result.stream as unknown as ReadableStream<Uint8Array> & {
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    };
    const body_stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const reader = typeof (source as any).getReader === "function"
            ? (source as ReadableStream<Uint8Array>).getReader()
            : null;
          const emit = (payload: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          };
          if (reader) {
            // Adapter hands back a raw upstream byte stream (already SSE frames).
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) controller.enqueue(value);
            }
          } else {
            // Adapter hands back a parsed chunk async-iterator.
            const it = (source as any)[Symbol.asyncIterator]
              ? (source as any)[Symbol.asyncIterator]()
              : (source as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            for (;;) {
              const { done, value } = await it.next();
              if (done) break;
              if (value) emit(value);
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        } catch (err) {
          console.error("[chat] Stream error:", err);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      },
    });
    return new Response(body_stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (body.stream && !result.stream) {
    // Upstream answered non-streamed; synthesize one SSE frame so clients
    // never see an empty 200 when they asked for a stream.
    const frame = result.response ?? { choices: [] };
    return c.body(
      `data: ${JSON.stringify({ ...frame, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: result.response?.model ?? body.model })}\n\ndata: [DONE]\n\n`,
      200,
      { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    );
  }

  if (!result.response) {
    // A provider result can carry neither error nor response (e.g. an upstream
    // 4xx with an empty error body, or an adapter that only set `stream`).
    // Returning c.json(undefined) here used to answer 200 with a 0-byte body.
    const msg = `upstream returned no response body for ${body.model}`;
    await requestLogger.logComplete(requestId, platform ?? "unknown", body.model, 0, undefined, body, null, Date.now() - startTime, 502, msg).catch(() => {});
    return c.json({ error: { type: "upstream_error", message: msg } }, 502);
  }

  return c.json(result.response);
});

/** POST /v1/completions — legacy text completion endpoint.
 * Converts prompt/suffix → messages and routes through SmartRouter.
 */
chatRouter.post("/completions", async (c) => {
  const db = c.get("db");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  // Legacy completions use prompt (string or array) instead of messages
  const model = (body.model as string) ?? "auto";
  const prompt = body.prompt;
  const maxTokens = body.max_tokens != null && Number(body.max_tokens) > 0
    ? Number(body.max_tokens) : 128;
  const stream = body.stream === true;
  const stop = body.stop;
  const temperature = Number(body.temperature ?? 1);
  const topP = Number(body.top_p ?? 1);

  let promptText: string;
  if (typeof prompt === "string") promptText = prompt;
  else if (Array.isArray(prompt) && prompt.length > 0) {
    promptText = typeof prompt[0] === "string" ? prompt[0] : prompt[0]?.text ?? "";
  } else if (prompt && typeof prompt === "object" && "text" in prompt) {
    promptText = (prompt as { text: unknown }).text as string;
  } else {
    promptText = "";
  }

  // Convert completion format to chat format
  const chatBody: ChatCompletionRequest = {
    model,
    messages: [{ role: "user", content: promptText }],
    max_tokens: maxTokens,
    stream,
    temperature,
    top_p: topP,
    ...(stop ? { stop: Array.isArray(stop) ? stop : [stop] } : {}),
  };

  const requestId = generateRequestId();
  const startTime = Date.now();

  try {
    const keys = await loadKeys(db);
    const enabledKeys = keys.filter((k) => k.enabled);

    // Use auto-routing for legacy completions (router will pick the best chat model)
    const ctx: RoutingContext = {
      request: chatBody,
      available_keys: enabledKeys as any,
      session_id: c.req.header("x-session-id") ?? undefined,
    };

    const res = await executeWithFallback(chatBody, ctx);
    const latencyMs = Date.now() - startTime;
    const statusCode = res.error ? (res.status ?? 502) : 200;

    traceRouteEvent("Proxy", {
      event: res.error ? "fail" : "ok",
      requestId,
      attempt: 1,
      platform: res.response ? (res.response as any)?.model ? "auto" : "auto" : "auto",
      model: model,
      latencyMs,
      error: res.error,
    });

    if (res.error) {
      const status = (res.status ?? 500) as 400 | 500 | 502 | 503;
      return c.json({
        error: {
          type: status >= 500 ? "server_error" : "invalid_request_error",
          message: String(res.error).slice(0, 500),
        },
        id: requestId,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
      }, status);
    }

    if (stream && res.stream) {
      // Pass through streaming
      return sseFromStream(res.stream);
    }

    if (stream) {
      return sseFromResponse(
        (res.response ?? null) as Record<string, unknown> | null,
        model,
      );
    }

    // Non-streaming: convert chat completion back to text completion format
    const chatResponse = res.response as unknown as Record<string, unknown> | null;
    const choices = (chatResponse?.choices as Array<Record<string, unknown>> | undefined) ?? [];

    if (choices.length === 0) {
      return c.json({
        id: requestId,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ text: "", index: 0 }],
      });
    }

    const convertedChoices = choices.map((choice, idx) => {
      const msg = choice.message as Record<string, unknown> | undefined;
      const text = typeof msg?.content === "string"
        ? msg.content
        : Array.isArray(msg?.content)
          ? (msg.content as Array<{ text?: string }>).map(p => p.text ?? "").join("")
          : "";
      return { text, index: idx, ...(choice.finish_reason ? { finish_reason: choice.finish_reason } : {}) };
    });

    await requestLogger.logComplete(
      requestId, "completions", model, 0, undefined, body as unknown as ChatCompletionRequest, chatResponse as unknown as (ChatCompletionResponse | null),
      latencyMs, statusCode, res.error, false, undefined, undefined, undefined,
    );

    return c.json({
      id: requestId,
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model: chatResponse?.model ?? model,
      choices: convertedChoices,
      usage: chatResponse?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    traceRouteEvent("Proxy", {
      event: "fail",
      requestId,
      attempt: 1,
      platform: "auto",
      model: model,
      latencyMs: Date.now() - startTime,
      error: msg,
    });
    return c.json({
      error: { type: "server_error", message: `${model} routing failed: ${msg}` },
      id: requestId,
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
    }, 503);
  }
});
