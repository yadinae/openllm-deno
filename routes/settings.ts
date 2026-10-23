/**
 * Settings endpoints — operator configuration for model maps and other settings.
 * Ported from FreeLLMAPI routes/settings.ts
 */
import { Hono } from "hono";
import { getSetting, saveSetting } from "../db/pg.ts";
import { getClaudeModelMap, setClaudeModelMap } from "../services/anthropic-map.ts";
import { getGeminiModelMap, setGeminiModelMap } from "../services/gemini-map.ts";

const settingsRouter = new Hono();

/**
 * GET /settings/anthropic-map
 * Returns the current Anthropic model family mapping.
 */
settingsRouter.get("/anthropic-map", async (c) => {
  const map = await getClaudeModelMap();
  return c.json({ map });
});

/**
 * PUT /settings/anthropic-map
 * Updates the Anthropic model family mapping.
 * Body: { default?: string, opus?: string, sonnet?: string, haiku?: string }
 * Values can be "auto", a catalog model_id, or a tier selector "tier:pro|mid|normal".
 */
settingsRouter.put("/anthropic-map", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }
  try {
    const map = await setClaudeModelMap(body);
    return c.json({ map });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: { type: "invalid_request_error", message: `Invalid anthropic model map: ${msg}` } }, 400);
  }
});

/**
 * GET /settings/gemini-map
 * Returns the current Gemini model family mapping.
 */
settingsRouter.get("/gemini-map", async (c) => {
  const map = await getGeminiModelMap();
  return c.json({ map });
});

/**
 * PUT /settings/gemini-map
 * Updates the Gemini model family mapping.
 * Body: { default?: string, pro?: string, flash?: string, flashLite?: string }
 */
settingsRouter.put("/gemini-map", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }
  try {
    const map = await setGeminiModelMap(body);
    return c.json({ map });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: { type: "invalid_request_error", message: `Invalid gemini model map: ${msg}` } }, 400);
  }
});

/**
 * GET /settings/default-embedding-family
 * Returns the default embedding family.
 */
settingsRouter.get("/default-embedding-family", async (c) => {
  const family = await getSetting<string>("embeddings_default_family");
  return c.json({ family: family ?? "openai/text-embedding-3-small" });
});

/**
 * PUT /settings/default-embedding-family
 * Sets the default embedding family.
 */
settingsRouter.put("/default-embedding-family", async (c) => {
  let body: { family?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }
  if (!body.family) {
    return c.json({ error: { type: "invalid_request_error", message: "family is required" } }, 400);
  }
  await saveSetting("embeddings_default_family", body.family);
  return c.json({ success: true, family: body.family });
});

export default settingsRouter;
