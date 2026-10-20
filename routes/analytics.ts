/**
 * Analytics endpoints - /api/analytics/*
 *
 * Shapes match the SPA (openllm-web/client), which mirrors FreeLLMAPI
 * server/src/routes/analytics.ts:
 *   /by-model /by-platform /by-client /by-key /timeline /errors  -> BARE ARRAYS
 *   /summary /error-distribution /requests /search               -> objects
 * The frontend calls .filter()/.length straight on the array endpoints, so a
 * {data: [...]} envelope crashes the page ("i.filter is not a function").
 *
 * Data source: the requests table written by services/request-log.ts.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { queryRaw, initDb } from "../db/pg.ts";

const analyticsRouter = new Hono();

/** Parse ?range= into an ISO 'from' bound (requests.timestamp is ISO-8601 TEXT). */
function sinceFrom(range: string | undefined): string {
  const now = Date.now();
  switch (range) {
    case "1h": return new Date(now - 3600_000).toISOString();
    case "24h": return new Date(now - 86400_000).toISOString();
    case "7d": return new Date(now - 7 * 86400_000).toISOString();
    case "30d": return new Date(now - 30 * 86400_000).toISOString();
    case "90d": return new Date(now - 90 * 86400_000).toISOString();
    case "all": return "0000-01-01T00:00:00.000Z";
    default: return new Date(now - 7 * 86400_000).toISOString();
  }
}

/** A served request counted as success: 2xx/3xx. status_code 0 = in-flight row. */
const OK = "(status_code >= 200 AND status_code < 400)";
const DECIDED = "(status_code >= 400 OR status_code BETWEEN 200 AND 399)";

function err503(c: Context, e: unknown) {
  return c.json({ error: { type: "server_error", message: e instanceof Error ? e.message : String(e) } }, 503);
}

/** GET /api/analytics/summary - object */
analyticsRouter.get("/summary", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const rows = await queryRaw(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END)::int AS ok_count,
              SUM(CASE WHEN ${DECIDED} AND NOT ${OK} THEN 1 ELSE 0 END)::int AS err_count,
              COALESCE(SUM(input_tokens),0)::bigint AS in_tok,
              COALESCE(SUM(output_tokens),0)::bigint AS out_tok,
              COALESCE(AVG(NULLIF(latency_ms,0)),0)::int AS avg_latency,
              SUM(CASE WHEN request_type = 'embedding' THEN 1 ELSE 0 END)::int AS emb_count,
              SUM(CASE WHEN requested_model IS NOT NULL THEN 1 ELSE 0 END)::int AS pinned,
              SUM(CASE WHEN requested_model IS NOT NULL
                        AND (requested_model = model OR requested_model = platform || '/' || model)
                       THEN 1 ELSE 0 END)::int AS pin_honored
         FROM requests WHERE timestamp >= $1`,
      [since],
    ) as any[];
    const lifetime = await queryRaw(`SELECT COUNT(*)::int AS c, MIN(timestamp) AS first_at FROM requests`, []) as any[];
    const r = rows[0] ?? {};
    const decided = (r.ok_count ?? 0) + (r.err_count ?? 0);
    return c.json({
      totalRequests: r.total ?? 0,
      successRate: decided > 0 ? Math.round(((r.ok_count ?? 0) / decided) * 1000) / 10 : 0,
      totalInputTokens: Number(r.in_tok ?? 0),
      totalOutputTokens: Number(r.out_tok ?? 0),
      avgLatencyMs: r.avg_latency ?? 0,
      // Time-to-first-token is not instrumented yet: null, not 0, so the UI
      // shows a placeholder instead of claiming an instant first token.
      avgTtfbMs: null,
      requestTypeCounts: { chat: (r.total ?? 0) - (r.emb_count ?? 0), embedding: r.emb_count ?? 0 },
      // No pricing table in this schema yet - report 0 rather than invent a number.
      estimatedCostSavings: 0,
      pinnedRequests: r.pinned ?? 0,
      pinHonoredRequests: r.pin_honored ?? 0,
      firstRequestAt: lifetime[0]?.first_at ?? null,
      lifetimeTotalRequests: lifetime[0]?.c ?? 0,
    });
  } catch (e) {
    return err503(c, e);
  }
});

/** GET /api/analytics/by-model - BARE ARRAY */
analyticsRouter.get("/by-model", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const rows = await queryRaw(
      `SELECT r.platform, r.model AS model_id,
              COALESCE(m.display_name, r.model) AS display_name,
              COUNT(*)::int AS requests,
              SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END) * 100.0
                / NULLIF(SUM(CASE WHEN ${DECIDED} THEN 1 ELSE 0 END),0) AS success_rate,
              COALESCE(AVG(NULLIF(r.latency_ms,0)),0)::int AS avg_latency_ms,
              COALESCE(SUM(r.input_tokens),0)::bigint AS in_tok,
              COALESCE(SUM(r.output_tokens),0)::bigint AS out_tok
         FROM requests r
         LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model
        WHERE r.timestamp >= $1
        GROUP BY r.platform, r.model, m.display_name
        ORDER BY requests DESC
        LIMIT 200`,
      [since],
    ) as any[];
    return c.json(rows.map((r: any) => ({
      platform: r.platform,
      providerId: r.platform,
      modelId: r.model_id,
      displayName: r.display_name ?? r.model_id,
      requests: r.requests,
      successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
      avgLatencyMs: r.avg_latency_ms ?? 0,
      totalInputTokens: Number(r.in_tok ?? 0),
      totalOutputTokens: Number(r.out_tok ?? 0),
      pinnedRequests: 0,
      estimatedCost: 0,
    })));
  } catch (e) {
    return c.json([]); // empty array keeps the SPA filter safe on DB error
  }
});

/** GET /api/analytics/by-platform - BARE ARRAY */
analyticsRouter.get("/by-platform", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const rows = await queryRaw(
      `SELECT platform,
              COUNT(*)::int AS requests,
              SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END) * 100.0
                / NULLIF(SUM(CASE WHEN ${DECIDED} THEN 1 ELSE 0 END),0) AS success_rate,
              COALESCE(AVG(NULLIF(latency_ms,0)),0)::int AS avg_latency_ms,
              SUM(CASE WHEN ${DECIDED} AND NOT ${OK} THEN 1 ELSE 0 END)::int AS error_count,
              COALESCE(SUM(input_tokens),0)::bigint AS in_tok,
              COALESCE(SUM(output_tokens),0)::bigint AS out_tok
         FROM requests WHERE timestamp >= $1
        GROUP BY platform ORDER BY requests DESC`,
      [since],
    ) as any[];
    return c.json(rows.map((r: any) => ({
      platform: r.platform,
      providerId: r.platform,
      requests: r.requests,
      successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
      avgLatencyMs: r.avg_latency_ms ?? 0,
      avgTtfbMs: null,
      errorCount: r.error_count ?? 0,
            avgTokensPerSecond: null,
      totalInputTokens: Number(r.in_tok ?? 0),
      totalOutputTokens: Number(r.out_tok ?? 0),
    })));
  } catch (e) {
    return c.json([]); // empty array keeps the SPA filter safe on DB error
  }
});

/**
 * GET /api/analytics/by-client - BARE ARRAY.
 * Read straight by the /agents page: `byClient.filter(...)`. An envelope here is
 * what threw "i.filter is not a function" and blanked the page.
 */
analyticsRouter.get("/by-client", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const rows = await queryRaw(
      `SELECT COALESCE(client_agent,'unknown') AS client_agent,
              COUNT(*)::int AS requests,
              SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END) * 100.0
                / NULLIF(SUM(CASE WHEN ${DECIDED} THEN 1 ELSE 0 END),0) AS success_rate,
              COALESCE(AVG(NULLIF(latency_ms,0)),0)::int AS avg_latency_ms,
              COALESCE(SUM(input_tokens),0)::bigint AS in_tok,
              COALESCE(SUM(output_tokens),0)::bigint AS out_tok,
              MAX(timestamp) AS last_seen_at
         FROM requests WHERE timestamp >= $1
        GROUP BY COALESCE(client_agent,'unknown') ORDER BY requests DESC`,
      [since],
    ) as any[];
    return c.json(rows.map((r: any) => ({
      clientAgent: r.client_agent,
      requests: r.requests,
      successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
      avgLatencyMs: r.avg_latency_ms ?? 0,
      totalInputTokens: Number(r.in_tok ?? 0),
      totalOutputTokens: Number(r.out_tok ?? 0),
      lastSeenAt: r.last_seen_at ?? null,
    })));
  } catch (e) {
    return c.json([]); // empty array keeps the SPA filter safe on DB error
  }
});

/** GET /api/analytics/by-key - BARE ARRAY */
analyticsRouter.get("/by-key", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const rows = await queryRaw(
      `SELECT r.key_id, k.label, k.platform,
              COUNT(*)::int AS requests,
              SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END) * 100.0
                / NULLIF(SUM(CASE WHEN ${DECIDED} THEN 1 ELSE 0 END),0) AS success_rate,
              COALESCE(AVG(NULLIF(r.latency_ms,0)),0)::int AS avg_latency_ms,
              COALESCE(SUM(r.input_tokens),0)::bigint AS in_tok,
              COALESCE(SUM(r.output_tokens),0)::bigint AS out_tok
         FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
        WHERE r.timestamp >= $1
        GROUP BY r.key_id, k.label, k.platform ORDER BY requests DESC LIMIT 100`,
      [since],
    ) as any[];
    return c.json(rows.map((r: any) => ({
      keyId: r.key_id ?? 0,
      label: r.label ?? null,
      platform: r.platform ?? null,
      requests: r.requests,
      successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
      avgLatencyMs: r.avg_latency_ms ?? 0,
      totalInputTokens: Number(r.in_tok ?? 0),
      totalOutputTokens: Number(r.out_tok ?? 0),
    })));
  } catch (e) {
    return c.json([]); // empty array keeps the SPA filter safe on DB error
  }
});

/** GET /api/analytics/timeline - BARE ARRAY of buckets */
analyticsRouter.get("/timeline", async (c: Context) => {
  try {
    await initDb();
    const range = c.req.query("range") ?? "7d";
    const since = sinceFrom(range);
    const interval = c.req.query("interval") ?? (range === "24h" ? "hour" : "day");
    const trunc = interval === "hour" ? "hour" : "day";
    // Viewer's UTC offset in minutes so bucket edges follow their wall clock.
    const raw = Number(c.req.query("tzOffset"));
    const tz = Number.isInteger(raw) && raw >= -720 && raw <= 840 ? raw : 0;
    const rows = await queryRaw(
      `SELECT to_char(date_trunc($2, timestamp::timestamptz + ($3::int * interval '1 minute')),
                      'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
              COUNT(*)::int AS requests,
              SUM(CASE WHEN ${OK} THEN 1 ELSE 0 END)::int AS success_count,
              SUM(CASE WHEN ${DECIDED} AND NOT ${OK} THEN 1 ELSE 0 END)::int AS failure_count,
              COALESCE(SUM(input_tokens),0)::bigint AS in_tok,
              COALESCE(SUM(output_tokens),0)::bigint AS out_tok
         FROM requests WHERE timestamp >= $1
        GROUP BY bucket ORDER BY bucket ASC`,
      [since, trunc, tz],
    ) as any[];
    return c.json(rows.map((r: any) => ({
      timestamp: r.bucket,
      requests: r.requests,
      successCount: r.success_count,
      failureCount: r.failure_count,
      inputTokens: Number(r.in_tok ?? 0),
      outputTokens: Number(r.out_tok ?? 0),
    })));
  } catch (e) {
    return c.json([]); // empty array keeps the SPA filter safe on DB error
  }
});

/** GET /api/analytics/errors - BARE ARRAY */
analyticsRouter.get("/errors", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const rows = await queryRaw(
      `SELECT id, platform, model AS model_id, error, latency_ms, timestamp AS created_at
         FROM requests
        WHERE timestamp >= $1 AND ${DECIDED} AND NOT ${OK}
        ORDER BY timestamp DESC LIMIT 50`,
      [since],
    ) as any[];
    return c.json(rows.map((r: any) => ({
      id: r.id,
      platform: r.platform,
      providerId: r.platform,
      modelId: r.model_id,
      error: r.error ?? "Upstream error",
      latencyMs: r.latency_ms ?? 0,
      createdAt: r.created_at,
    })));
  } catch (e) {
    return c.json([]); // empty array keeps the SPA filter safe on DB error
  }
});

const ERR_CAT = `CASE
    WHEN status_code = 429 OR lower(error) LIKE '%429%' OR lower(error) LIKE '%rate limit%' OR lower(error) LIKE '%quota%' THEN 'Rate Limited (429)'
    WHEN status_code = 401 OR lower(error) LIKE '%unauthorized%' OR lower(error) LIKE '%invalid api key%' THEN 'Auth Error (401)'
    WHEN status_code = 403 OR lower(error) LIKE '%forbidden%' THEN 'Forbidden (403)'
    WHEN status_code = 404 OR lower(error) LIKE '%not found%' THEN 'Not Found (404)'
    WHEN lower(error) LIKE '%timeout%' OR lower(error) LIKE '%timed out%' OR lower(error) LIKE '%econnrefused%' THEN 'Timeout/Connection'
    WHEN status_code >= 500 THEN 'Server Error (5xx)'
    ELSE 'Other' END`;

/** GET /api/analytics/error-distribution - object {byCategory, byPlatform, detailed} */
analyticsRouter.get("/error-distribution", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const w = `timestamp >= $1 AND ${DECIDED} AND NOT ${OK}`;
    const [byCategory, byPlatform, detailed] = await Promise.all([
      queryRaw(`SELECT ${ERR_CAT} AS category, COUNT(*)::int AS count FROM requests WHERE ${w} GROUP BY category ORDER BY count DESC`, [since]) as Promise<any[]>,
      queryRaw(`SELECT platform, COUNT(*)::int AS count FROM requests WHERE ${w} GROUP BY platform ORDER BY count DESC`, [since]) as Promise<any[]>,
      queryRaw(`SELECT platform, model AS model_id, ${ERR_CAT} AS error_category, COUNT(*)::int AS count FROM requests WHERE ${w} GROUP BY platform, model, error_category ORDER BY count DESC LIMIT 50`, [since]) as Promise<any[]>,
    ]);
    return c.json({
      byCategory: byCategory.map((r: any) => ({ category: r.category, count: r.count })),
      byPlatform: byPlatform.map((r: any) => ({ platform: r.platform, providerId: r.platform, count: r.count })),
      detailed: detailed.map((r: any) => ({ platform: r.platform, model_id: r.model_id, error_category: r.error_category, count: r.count })),
    });
  } catch (e) {
    return err503(c, e);
  }
});

/** GET /api/analytics/requests - object {total, rows} */
analyticsRouter.get("/requests", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 500);
    const offset = parseInt(c.req.query("offset") ?? "0") || 0;
    const status = c.req.query("status");
    const platform = c.req.query("platform");
    let w = `r.timestamp >= $1`;
    const params: any[] = [since];
    if (status === "success") w += ` AND ${OK}`;
    else if (status === "error") w += ` AND ${DECIDED} AND NOT ${OK}`;
    if (platform && /^[A-Za-z0-9_-]{1,64}$/.test(platform)) {
      params.push(platform);
      w += ` AND r.platform = $${params.length}`;
    }
    const whereCount = w;
    const countParams = [...params];
    params.push(limit, offset);
    const rows = await queryRaw(
      `SELECT r.id, r.platform, r.model AS model_id, r.requested_model, r.request_type,
              CASE WHEN ${OK} THEN 'success' ELSE 'error' END AS status,
              r.input_tokens, r.output_tokens, r.latency_ms, r.error,
              r.client_ip, r.client_user_agent, r.client_agent,
              r.timestamp AS created_at, k.label AS key_label
         FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
        WHERE ${w}
        ORDER BY r.timestamp DESC, r.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ) as any[];
    const total = await queryRaw(`SELECT COUNT(*)::int AS c FROM requests r WHERE ${whereCount}`, countParams) as any[];
    return c.json({
      total: total[0]?.c ?? 0,
      rows: rows.map((r: any) => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        requestedModel: r.requested_model ?? null,
        requestType: r.request_type ?? "chat",
        status: r.status,
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        latencyMs: r.latency_ms ?? 0,
        error: r.error ?? null,
        clientIp: r.client_ip ?? null,
        clientUserAgent: r.client_user_agent ?? null,
        clientAgent: r.client_agent ?? null,
        createdAt: r.created_at,
        keyLabel: r.key_label ?? null,
        // request_attempts table not migrated yet; 0 so the ladder cell stays empty.
        attemptCount: 0,
      })),
    });
  } catch (e) {
    return err503(c, e);
  }
});

/** GET /api/analytics/requests/:id - object (row + attempts ladder) */
analyticsRouter.get("/requests/:id", async (c: Context) => {
  try {
    await initDb();
    const id = c.req.param("id");
    const rows = await queryRaw(
      `SELECT id, platform, model AS model_id, requested_model, request_type,
              CASE WHEN ${OK} THEN 'success' ELSE 'error' END AS status,
              input_tokens, output_tokens, latency_ms, error,
              client_ip, client_user_agent, client_agent, timestamp AS created_at
         FROM requests WHERE request_id = $1 OR id::text = $1 LIMIT 1`,
      [id],
    ) as any[];
    if (!rows.length) return c.json({ error: { type: "not_found", message: "Request not found" } }, 404);
    const r = rows[0];
    return c.json({
      id: r.id, platform: r.platform, modelId: r.model_id,
      requestedModel: r.requested_model ?? null, requestType: r.request_type ?? "chat",
      status: r.status, inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0,
      latencyMs: r.latency_ms ?? 0, ttfbMs: null, error: r.error ?? null,
      clientIp: r.client_ip ?? null, clientUserAgent: r.client_user_agent ?? null,
      clientAgent: r.client_agent ?? null, createdAt: r.created_at,
      attempts: [],
    });
  } catch (e) {
    return err503(c, e);
  }
});

const EMPTY_SEARCH = { total: 0, today: 0, successRate: 0, avgLatencyMs: 0, byEngine: [], series: [] };

/** GET /api/analytics/search - object (search_requests) */
analyticsRouter.get("/search", async (c: Context) => {
  try {
    await initDb();
    const since = sinceFrom(c.req.query("range"));
    const [totals, byEngine, series, today] = await Promise.all([
      queryRaw(`SELECT COUNT(*)::int AS attempts,
                       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)::int AS ok,
                       COALESCE(AVG(latency_ms),0)::int AS avg_latency
                  FROM search_requests WHERE created_at >= $1`, [since]) as Promise<any[]>,
      queryRaw(`SELECT engine_id, COUNT(*)::int AS n FROM search_requests
                 WHERE created_at >= $1 AND status = 'ok'
                 GROUP BY engine_id ORDER BY n DESC, engine_id`, [since]) as Promise<any[]>,
      queryRaw(`SELECT left(created_at,10) AS day, engine_id, COUNT(*)::int AS n FROM search_requests
                 WHERE created_at >= $1 AND status = 'ok'
                 GROUP BY day, engine_id ORDER BY day, engine_id`, [since]) as Promise<any[]>,
      queryRaw(`SELECT COUNT(*)::int AS n FROM search_requests
                 WHERE status = 'ok' AND left(created_at,10) = to_char(now(),'YYYY-MM-DD')`, []) as Promise<any[]>,
    ]);
    const t = totals[0] ?? {};
    return c.json({
      total: t.ok ?? 0,
      today: today[0]?.n ?? 0,
      successRate: (t.attempts ?? 0) > 0 ? Math.round(((t.ok ?? 0) / t.attempts) * 1000) / 10 : 0,
      avgLatencyMs: t.avg_latency ?? 0,
      byEngine: byEngine.map((r: any) => ({ engineId: r.engine_id, displayName: r.engine_id, count: r.n })),
      series: series.map((r: any) => ({ date: r.day, engineId: r.engine_id, count: r.n })),
    });
  } catch {
    // Search analytics is decorative; an unreadable table must not 5xx the page.
    return c.json(EMPTY_SEARCH);
  }
});

export default analyticsRouter;
