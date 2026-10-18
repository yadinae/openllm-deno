/**
 * /v1/chat/completions route - OpenAI-compatible chat completions.
 * Uses ProviderRegistry for unified provider abstraction.
 */

import { Hono } from "hono";
import type { ChatCompletionRequest } from "../providers/types.ts";
import type { DbData, DbEntry } from "../db/mod.ts";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { executeChat, getAdapterForPlatform } from "../providers/index.ts";
import type { ProviderResult, ApiKey } from "../providers/types.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

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
    return c.json({ error: result.error }, status);
  }

  // Handle streaming response - collect and return final for now
  if (body.stream && result.stream) {
    const chunks: any[] = [];
    try {
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
    } catch (err) {
      console.error("[chat] Stream collection error:", err);
      return c.json({ error: "Stream collection failed" }, 500);
    }

    // Return the last chunk as the final response
    const finalChunk = chunks[chunks.length - 1];
    if (finalChunk) {
      return c.json(finalChunk);
    }
    return c.json({ error: "No chunks received" }, 500);
  }

  return c.json(result.response);
});
