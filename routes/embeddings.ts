/**
 * Embeddings inbound — /v1/embeddings
 * Routes to services/embeddings.ts (createEmbeddings).
 */
import { Hono } from "hono";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { createEmbeddings, listEmbeddingModels } from "../services/embeddings.ts";
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

    const result = await createEmbeddings({ ...body, model: modelId }, apiKey);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Log with minimal request shape for embeddings
    const logBody = { model: body.model, input: body.input } as any;
    await requestLogger.logComplete(vRequestId, "embeddings", "embeddings", 0, undefined, logBody, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

/** List available embedding models */
embeddingsRouter.get("/embeddings/models", async (c) => {
  return c.json(listEmbeddingModels());
});

export default embeddingsRouter;