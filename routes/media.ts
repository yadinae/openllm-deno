/**
 * Media generation inbound — /v1/images/generations, /v1/audio/speech
 * Routes to services/media.ts (generateMedia).
 */
import { Hono } from "hono";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { generateMedia, listMediaModels, getSupportedModalities } from "../services/media.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const mediaRouter = new Hono();

mediaRouter.post("/images/generations", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: { model: string; prompt: string; n?: number; size?: string; quality?: string; style?: string; response_format?: "url" | "b64_json"; user?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }

  if (!body.model || !body.prompt) {
    return c.json({ error: { type: "invalid_request_error", message: "model and prompt are required" } }, 400);
  }

  try {
    const parts = body.model.split("/");
    const platform = parts[0];
    const modelId = parts.length > 1 ? parts.slice(1).join("/") : body.model;

    const allKeys = await listApiKeys();
    const key = allKeys.find((k) => k.enabled && k.status === "healthy" && k.platform === platform);
    if (!key) {
      return c.json({ error: { type: "server_error", message: `No healthy key for platform ${platform}` } }, 503);
    }

    const secret = await decryptKey(key.encrypted_key!, key.iv!, key.auth_tag!).catch(() => null);
    if (!secret) {
      return c.json({ error: { type: "server_error", message: "Failed to decrypt key" } }, 500);
    }

    const apiKey = {
      id: String(key.db_id),
      platform,
      label: key.label ?? platform,
      encrypted_key: secret,
      iv: "",
      auth_tag: "",
      status: key.status as "healthy",
      enabled: key.enabled,
      base_url: key.base_url,
      monthly_request_cap: key.monthly_request_cap ?? 0,
      monthly_token_cap: key.monthly_token_cap ?? 0,
      db_id: key.db_id,
    };

    const result = await generateMedia({ ...body, model: modelId } as any, apiKey);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "images", "images", 0, undefined, body as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

mediaRouter.post("/audio/speech", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: { model: string; input: string; voice?: string; speed?: number; response_format?: string; user?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }

  if (!body.model || !body.input) {
    return c.json({ error: { type: "invalid_request_error", message: "model and input are required" } }, 400);
  }

  try {
    const parts = body.model.split("/");
    const platform = parts[0];
    const modelId = parts.length > 1 ? parts.slice(1).join("/") : body.model;

    const allKeys = await listApiKeys();
    const key = allKeys.find((k) => k.enabled && k.status === "healthy" && k.platform === platform);
    if (!key) {
      return c.json({ error: { type: "server_error", message: `No healthy key for platform ${platform}` } }, 503);
    }

    const secret = await decryptKey(key.encrypted_key!, key.iv!, key.auth_tag!).catch(() => null);
    if (!secret) {
      return c.json({ error: { type: "server_error", message: "Failed to decrypt key" } }, 500);
    }

    const apiKey = {
      id: String(key.db_id),
      platform,
      label: key.label ?? platform,
      encrypted_key: secret,
      iv: "",
      auth_tag: "",
      status: key.status as "healthy",
      enabled: key.enabled,
      base_url: key.base_url,
      monthly_request_cap: key.monthly_request_cap ?? 0,
      monthly_token_cap: key.monthly_token_cap ?? 0,
      db_id: key.db_id,
    };

    const result = await generateMedia({ ...body, model: modelId, prompt: body.input } as any, apiKey);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "audio", "audio", 0, undefined, body as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

/** List available media models */
mediaRouter.get("/models", async (c) => {
  return c.json(listMediaModels());
});

mediaRouter.get("/modalities", async (c) => {
  return c.json(getSupportedModalities());
});

export default mediaRouter;