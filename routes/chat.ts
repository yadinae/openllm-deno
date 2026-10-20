/**
 * /v1/chat/completions route - OpenAI-compatible chat completions.
 * Uses ProviderRegistry for unified provider abstraction.
 */

import { Hono } from "hono";
import type { ChatCompletionRequest } from "../providers/types.ts";
import type { DbData, DbEntry } from "../db/mod.ts";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys, getSetting } from "../db/pg.ts";
import { executeChat, getAdapterForPlatform } from "../providers/index.ts";
import type { ProviderResult, ApiKey, RoutingContext } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";
import { smartRouter, executeWithFallback } from "../services/router.ts";
import { runFusion, type FusionConfig } from "../services/fusion.ts";

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
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.model || !Array.isArray(body.messages)) {
    return c.json({ error: "model and messages are required" }, 400);
  }

  // ── Virtual models (FreeLLMAPI parity) ──────────────────────────────────
  // "auto": SmartRouter bandit scoring across every enabled key + fallback
  // chain retry. "fusion": panel fan-out with tool-call voting and optional
  // judge synthesis. Both bypass the platform-prefix routing below.
  if (body.model === "auto" || body.model === "fusion") {
    const vRequestId = generateRequestId();
    const vStart = Date.now();
    try {
      const ctx: RoutingContext = { request: body, available_keys: [] };
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
      await requestLogger.logComplete(
        vRequestId, "auto", "auto", 0, undefined, body, res.response ?? null,
        Date.now() - vStart, statusCode, res.error,
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
    return c.json({ error: "No API keys configured" }, 503);
  }

  let secret: string | null = null;
  if (keyEntry.encrypted_key && keyEntry.iv && keyEntry.auth_tag) {
    secret = await decryptKey(keyEntry.encrypted_key, keyEntry.iv, keyEntry.auth_tag).catch(() => null);
  }
  if (!secret) {
    return c.json({ error: "Failed to decrypt key for " + platform }, 500);
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
  const requestId = generateRequestId();
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
    requestId,
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

  return c.json(result.response);
});
