/**
 * Moderation inbound — /v1/moderations
 * Proxies to OpenAI-compatible moderation endpoints (OpenAI, OpenRouter, NVIDIA).
 */
import { Hono } from "hono";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const moderationRouter = new Hono();

interface ModerationModel {
  platform: string;
  modelId: string;
  baseUrl: string;
  keyId: number;
  encryptedKey: string;
  iv: string;
  authTag: string;
}

const MODERATION_MODELS: Record<string, { baseUrl: string; modelId: string }> = {
  openai:     { baseUrl: "https://api.openai.com",     modelId: "omni-moderation-latest" },
  openrouter: { baseUrl: "https://openrouter.ai/api",  modelId: "openai/omni-moderation-latest" },
  nvidia:     { baseUrl: "https://integrate.api.nvidia.com", modelId: "nvidia/llama-3.1-nemoguard-8b-content-safety" },
};

const PLATFORM_ORDER = ["openai", "openrouter", "nvidia"] as const;

function listModerationModels(keys: Awaited<ReturnType<typeof listApiKeys>>): ModerationModel[] {
  const rows: ModerationModel[] = [];
  for (const platform of PLATFORM_ORDER) {
    const ep = MODERATION_MODELS[platform];
    const key = keys.find((k) => k.platform === platform && k.enabled && k.status === "healthy");
    if (key) {
      rows.push({
        platform,
        modelId: ep.modelId,
        baseUrl: ep.baseUrl,
        keyId: key.db_id,
        encryptedKey: key.encrypted_key ?? "",
        iv: key.iv ?? "",
        authTag: key.auth_tag ?? "",
      });
    }
  }
  return rows;
}

function resolveModel(requested: string | undefined, keys: Awaited<ReturnType<typeof listApiKeys>>): string | null {
  if (!requested || requested === "text-moderation-stable" || requested === "text-moderation-latest") {
    const models = listModerationModels(keys);
    return models.length > 0 ? models[0].modelId : null;
  }
  const models = listModerationModels(keys);
  const match = models.find((m) => m.modelId === requested);
  return match ? match.modelId : (models[0]?.modelId ?? null);
}

async function callProvider(row: ModerationModel, apiKey: string, inputs: string[]): Promise<any> {
  const url = `${row.baseUrl}/v1/moderations`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: row.modelId, input: inputs.length === 1 ? inputs[0] : inputs }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`moderation provider ${row.platform} returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as any;
  if (!json.results || !Array.isArray(json.results)) {
    throw new Error("upstream returned malformed moderation response");
  }
  return json;
}

moderationRouter.post("/moderations", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: { model?: string; input: string | string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }

  if (!body.input) return c.json({ error: { type: "invalid_request_error", message: "input is required" } }, 400);
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (inputs.length === 0) return c.json({ error: { type: "invalid_request_error", message: "input must not be empty" } }, 400);

  try {
    const allKeys = await listApiKeys();
    const resolved = resolveModel(body.model, allKeys);
    if (!resolved) {
      return c.json({ error: { type: "server_error", message: "No moderation providers available. Add OpenAI, OpenRouter, or NVIDIA key." } }, 503);
    }

    const models = listModerationModels(allKeys);
    const isDefault = !body.model || body.model === "text-moderation-stable" || body.model === "text-moderation-latest";
    const chain = isDefault ? models : models.filter((m) => m.modelId === resolved);
    if (chain.length === 0) {
      return c.json({ error: { type: "server_error", message: `No enabled providers for model '${resolved}'` } }, 503);
    }

    let lastError: Error | null = null;
    for (const row of chain) {
      let apiKey: string;
      try {
        apiKey = await decryptKey(row.encryptedKey, row.iv, row.authTag);
      } catch {
        continue;
      }
      const started = Date.now();
      try {
        const json = await callProvider(row, apiKey, inputs);
        return c.json({
          id: json.id ?? `modr-${Date.now()}`,
          model: json.model ?? row.modelId,
          results: json.results,
          _provider: row.platform,
        });
      } catch (err: any) {
        const e = err instanceof Error ? err : new Error(String(err?.message ?? err));
        lastError = e;
      }
    }

    const status = lastError?.message?.includes("429") ? 429 : 502;
    return c.json({ error: { type: status === 429 ? "rate_limit_error" : "server_error", message: `All moderation providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : " (no usable keys)"}` } }, status);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

export default moderationRouter;