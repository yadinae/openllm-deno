/**
 * Rerank inbound — /v1/rerank
 * Proxies to Cohere or custom OpenAI-compatible /rerank endpoints.
 */
import { Hono } from "hono";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { runRerank, RerankError } from "../services/rerank.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const rerankRouter = new Hono();

rerankRouter.post("/rerank", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  let body: { model?: string; query: string; documents: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { type: "invalid_request_error", message: "Invalid JSON" } }, 400);
  }

  if (!body.query || !body.documents?.length) {
    return c.json({ error: { type: "invalid_request_error", message: "query and documents are required" } }, 400);
  }

  try {
    const result = await runRerank(body.model, body.query, body.documents);
    return c.json({
      id: `rerank_${Date.now()}`,
      model: result.modelId,
      results: result.results,
      _provider: result.platform,
    });
  } catch (e: any) {
    if (e instanceof RerankError) {
      const status = e.status === 429 ? 429 : 502;
      return c.json({ error: { type: status === 429 ? "rate_limit_error" : "server_error", message: e.message } }, status);
    }
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "rerank", "rerank", 0, undefined, { model: body.model, query: body.query } as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

export default rerankRouter;