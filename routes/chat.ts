/**
 * /v1/chat/completions route — OpenAI-compatible chat completions.
 * Phase 1: routes to the first enabled provider that supports the requested model.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from "../providers/types.ts";
import type { DbData } from "../db/mod.ts";
import { chat as openaiCompatChat } from "../providers/openai-compat.ts";
import type { ProviderResult } from "../providers/openai-compat.ts";
import { decryptKeyValue, getBaseUrlForPlatform } from "../db/mod.ts";

export const chatRouter = new Hono();

chatRouter.post("/chat/completions", async (c) => {
  const db = c.get("db") as DbData;
  console.log("Chat request received");
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json();
    console.log("Request body parsed:", body.model);
  } catch {
    console.log("JSON parse error");
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.model || !Array.isArray(body.messages)) {
    console.log("Invalid request: missing model or messages");
    return c.json({ error: "model and messages are required" }, 400);
  }

  // Pick a provider: first enabled key matching the platform prefix
  const [platform, _] = body.model.split("/");
  console.log("Platform:", platform);
  const keys = db.api_keys.filter((k) => k.platform === platform && k.enabled);
  console.log("Keys for platform:", keys.length);

  if (keys.length === 0) {
    // Fall back to any enabled key
    const allKeys = db.api_keys.filter((k) => k.enabled);
    console.log("Fallback to any enabled key:", allKeys.length);
    if (allKeys.length === 0) {
      console.log("No keys available");
      return c.json({ error: "No API keys configured" }, 503);
    }
    keys.push(allKeys[0]);
  }

  const key = keys[0];
  console.log("Selected key:", key.platform, key.label, key.id);
  const secret = await decryptKeyValue(key);
  console.log("Decryption result:", secret === null ? "FAILED" : "SUCCESS (length: " + (secret?.length ?? 0) + ")");
  if (!secret) {
    return c.json({ error: `Failed to decrypt key for ${platform}` }, 500);
  }

  const baseUrl = key.base_url || getBaseUrlForPlatform(platform);
  console.log("Base URL:", baseUrl);
  const result: ProviderResult = await openaiCompatChat(secret, baseUrl, body);
  console.log("Provider result:", result.error ? `ERROR: ${result.error}` : `SUCCESS`);
  
  if (result.error) {
    return c.json({ error: result.error }, result.status ?? 500);
  }

  return c.json(result.response);
});