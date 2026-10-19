/**
 * Analytics endpoints — /api/analytics/*
 * Mirrors FreeLLMAPI routes/analytics.ts (11 endpoints).
 * Uses services/request-log.ts for data.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { query, queryRaw, initDb } from "../db/pg.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const analyticsRouter = new Hono();

// Helper: parse time range
function parseTimeRange(c: Context): { from: string; to: string; granularity: "minute" | "hour" | "day" } {
  const now = new Date();
  const range = c.req.query("range") ?? "24h";
  const granularity = (c.req.query("granularity") ?? "hour") as "minute" | "hour" | "day";

  let from: Date;
  switch (range) {
    case "1h": from = new Date(now.getTime() - 3600_000); break;
    case "24h": from = new Date(now.getTime() - 86400_000); break;
    case "7d": from = new Date(now.getTime() - 7 * 86400_000); break;
    case "30d": from = new Date(now.getTime() - 30 * 86400_000); break;
    default: from = new Date(now.getTime() - 86400_000);
  }

  return { from: from.toISOString(), to: now.toISOString(), granularity };
}

/** GET /api/analytics/search - Search/filter requests */
analyticsRouter.get("/search", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  try {
    await initDb();
    const { from, to } = parseTimeRange(c);
    const platform = c.req.query("platform");
    const model = c.req.query("model");
    const status = c.req.query("status");
    const limit = parseInt(c.req.query("limit") ?? "100");
    const offset = parseInt(c.req.query("offset") ?? "0");

    let sql = `SELECT * FROM requests WHERE timestamp >= $1 AND timestamp <= $2`;
    const params: any[] = [from, to];

    if (platform) { sql += ` AND platform = $${params.length + 1}`; params.push(platform); }
    if (model) { sql += ` AND model = $${params.length + 1}`; params.push(model); }
    if (status) { sql += ` AND status_code = $${params.length + 1}`; params.push(status); }

    sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const rows = await queryRaw(sql, params) as any[];
    return c.json({ data: rows, total: rows.length, limit, offset });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

/** GET /api/analytics/summary - Overall summary */
analyticsRouter.get("/summary", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  try {
    await initDb();
    const { from, to } = parseTimeRange(c);

    const [total, byPlatform, byModel, errorRate, latency] = await Promise.all([
      query`SELECT COUNT(*) as count FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to}`,
      query`SELECT platform, COUNT(*) as count FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to} GROUP BY platform`,
      query`SELECT model, COUNT(*) as count FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to} GROUP BY model ORDER BY count DESC LIMIT 20`,
      query`SELECT COUNT(*) as count FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to} AND status_code >= 400`,
      query`SELECT AVG(latency_ms) as avg_latency, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95, PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) as p99 FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to}`,
    ]);

    return c.json({
      total_requests: total[0]?.count ?? 0,
      by_platform: byPlatform,
      top_models: byModel,
      error_rate: (errorRate[0]?.count ?? 0) / (total[0]?.count ?? 1),
      latency: latency[0] || { avg_latency: 0, p50: 0, p95: 0, p99: 0 },
      range: { from, to },
    });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

/** GET /api/analytics/by-model - Requests grouped by model */
analyticsRouter.get("/by-model", async (c) => {
  const { from, to } = parseTimeRange(c);
  try {
    await initDb();
    const rows = await query`
      SELECT model, COUNT(*) as requests, SUM(total_tokens) as total_tokens, AVG(latency_ms) as avg_latency
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to}
      GROUP BY model
      ORDER BY requests DESC
    `;
    return c.json({ data: rows, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/by-platform - Requests grouped by platform */
analyticsRouter.get("/by-platform", async (c) => {
  const { from, to } = parseTimeRange(c);
  try {
    await initDb();
    const rows = await query`
      SELECT platform, COUNT(*) as requests, SUM(total_tokens) as total_tokens, AVG(latency_ms) as avg_latency
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to}
      GROUP BY platform
      ORDER BY requests DESC
    `;
    return c.json({ data: rows, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/by-client - Requests grouped by client */
analyticsRouter.get("/by-client", async (c) => {
  const { from, to } = parseTimeRange(c);
  try {
    await initDb();
    const rows = await query`
      SELECT client_id, COUNT(*) as requests, SUM(total_tokens) as total_tokens
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to}
      GROUP BY client_id
      ORDER BY requests DESC
      LIMIT 50
    `;
    return c.json({ data: rows, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/by-key - Requests grouped by API key */
analyticsRouter.get("/by-key", async (c) => {
  const { from, to } = parseTimeRange(c);
  try {
    await initDb();
    const rows = await query`
      SELECT key_id, COUNT(*) as requests, SUM(total_tokens) as total_tokens
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to}
      GROUP BY key_id
      ORDER BY requests DESC
      LIMIT 50
    `;
    return c.json({ data: rows, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/timeline - Time-series data */
analyticsRouter.get("/timeline", async (c) => {
  const { from, to, granularity } = parseTimeRange(c);
  const interval = granularity === "minute" ? "1 minute" : granularity === "hour" ? "1 hour" : "1 day";

  try {
    await initDb();
    const rows = await query`
      SELECT
        date_trunc(${granularity === "minute" ? "minute" : granularity === "hour" ? "hour" : "day"}, timestamp::timestamp) as bucket,
        COUNT(*) as requests,
        SUM(total_tokens) as total_tokens,
        AVG(latency_ms) as avg_latency,
        COUNT(*) FILTER (WHERE status_code >= 400) as errors
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to}
      GROUP BY bucket
      ORDER BY bucket
    `;
    return c.json({ data: rows, granularity, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/error-distribution - Error type breakdown */
analyticsRouter.get("/error-distribution", async (c) => {
  const { from, to } = parseTimeRange(c);
  try {
    await initDb();
    const rows = await query`
      SELECT
        CASE
          WHEN status_code = 429 THEN 'rate_limit'
          WHEN status_code >= 500 THEN 'server_error'
          WHEN status_code >= 400 THEN 'client_error'
          ELSE 'other'
        END as error_type,
        status_code,
        COUNT(*) as count
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to} AND status_code >= 400
      GROUP BY error_type, status_code
      ORDER BY count DESC
    `;
    return c.json({ data: rows, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/errors - Recent errors */
analyticsRouter.get("/errors", async (c) => {
  const { from, to } = parseTimeRange(c);
  const limit = parseInt(c.req.query("limit") ?? "50");
  try {
    await initDb();
    const rows = await query`
      SELECT timestamp, platform, model, status_code, error, latency_ms, client_id, key_id
      FROM requests
      WHERE timestamp >= ${from} AND timestamp <= ${to} AND status_code >= 400
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;
    return c.json({ data: rows, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/requests - Paginated request list */
analyticsRouter.get("/requests", async (c) => {
  const { from, to } = parseTimeRange(c);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 500);
  const offset = parseInt(c.req.query("offset") ?? "0");
  try {
    await initDb();
    const [rows, total] = await Promise.all([
      query`SELECT * FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
      query`SELECT COUNT(*) as count FROM requests WHERE timestamp >= ${from} AND timestamp <= ${to}`,
    ]);
    return c.json({ data: rows, total: total[0]?.count ?? 0, limit, offset, range: { from, to } });
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

/** GET /api/analytics/requests/:id - Single request detail */
analyticsRouter.get("/requests/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await initDb();
    const rows = await query`SELECT * FROM requests WHERE request_id = ${id}`;
    if (!rows.length) return c.json({ error: { type: "not_found", message: "Request not found" } }, 404);
    return c.json(rows[0]);
  } catch (e: any) {
    return c.json({ error: { type: "server_error", message: String(e) } }, 503);
  }
});

export default analyticsRouter;