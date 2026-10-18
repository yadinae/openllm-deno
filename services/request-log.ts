/**
 * RequestLogger — Request/Response logging for analytics and observability.
 * Phase A Week 5: Core logging engine.
 * P-CORE-005: 请求日志必须落库并驱动 /api/analytics 真实数据，不再返回空值
 */

import { query, initDb } from "../db/pg.ts";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.ts";
import { broadcastLog, broadcastMetrics } from "../routes/ws-observability.ts";

/** Request log entry */
export interface RequestLogEntry {
  id: number;
  request_id: string;
  timestamp: string;
  platform: string;
  model: string;
  key_id: number;
  client_id?: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  latency_ms: number;
  status_code: number;
  error?: string;
  fused: boolean;
  panel_size?: number;
  judge_used?: boolean;
  strategy?: string;
}

/** Aggregated metrics for analytics */
export interface AnalyticsMetrics {
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  avg_latency_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  requests_by_platform: Record<string, number>;
  requests_by_model: Record<string, number>;
  errors_by_type: Record<string, number>;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  rpm: number;
  tpm: number;
}

/** Time range for queries */
export interface TimeRange {
  from: Date;
  to: Date;
}

/** RequestLogger — Handles all request/response logging and metrics aggregation */
export class RequestLogger {
  private batchBuffer: RequestLogData[] = [];
  private flushInterval: number;
  private batchSize: number;
  private flushTimer?: number;
  private metricsTimer?: number;

  constructor(options: { flushIntervalMs?: number; batchSize?: number } = {}) {
    this.flushInterval = options.flushIntervalMs ?? 5000; // 5 seconds
    this.batchSize = options.batchSize ?? 100;
  }

  /** Start automatic batch flushing */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval) as unknown as number;
    
    // Broadcast metrics every 10 seconds
    if (this.metricsTimer) return;
    this.metricsTimer = setInterval(async () => {
      try {
        const now = new Date();
        const minuteAgo = new Date(now.getTime() - 60 * 1000);
        const metrics = await this.getMetrics({ from: minuteAgo, to: now });
        broadcastMetrics(metrics);
      } catch {}
    }, 10000) as unknown as number;
  }

  /** Stop automatic batch flushing */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
    this.flush(); // Final flush
  }

  /** Log a request (called before provider call) */
  async logRequest(
    requestId: string,
    platform: string,
    model: string,
    keyId: number,
    clientId: string | undefined,
    inputTokens: number,
    fused: boolean = false,
    panelSize?: number
  ): Promise<void> {
    const entry: RequestLogData = {
      request_id: requestId,
      timestamp: new Date().toISOString(),
      platform,
      model,
      key_id: keyId,
      client_id: clientId,
      input_tokens: inputTokens,
      output_tokens: 0,
      total_tokens: inputTokens,
      latency_ms: 0,
      status_code: 0,
      error: undefined,
      fused,
      panel_size: panelSize,
      judge_used: false,
      strategy: undefined,
      phase: "request",
    };
    this.batchBuffer.push(entry);
    if (this.batchBuffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  /** Log response (called after provider call) */
  async logResponse(
    requestId: string,
    platform: string,
    model: string,
    keyId: number,
    clientId: string | undefined,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    statusCode: number,
    error?: string,
    fused: boolean = false,
    panelSize?: number,
    judgeUsed?: boolean,
    strategy?: string
  ): Promise<void> {
    const entry: RequestLogData = {
      request_id: requestId,
      timestamp: new Date().toISOString(),
      platform,
      model,
      key_id: keyId,
      client_id: clientId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      latency_ms: latencyMs,
      status_code: statusCode,
      error,
      fused,
      panel_size: panelSize,
      judge_used: judgeUsed,
      strategy,
      phase: "response",
    };
    this.batchBuffer.push(entry);
    if (this.batchBuffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  /** Log a complete request-response cycle (convenience method) */
  async logComplete(
    requestId: string,
    platform: string,
    model: string,
    keyId: number,
    clientId: string | undefined,
    request: ChatCompletionRequest,
    response: ChatCompletionResponse | null,
    latencyMs: number,
    statusCode: number,
    error?: string,
    fused: boolean = false,
    panelSize?: number,
    judgeUsed?: boolean,
    strategy?: string
  ): Promise<void> {
    const inputTokens = response?.usage?.prompt_tokens ?? this.estimateTokens(request);
    const outputTokens = response?.usage?.completion_tokens ?? 0;

    await this.logResponse(
      requestId,
      platform,
      model,
      keyId,
      clientId,
      inputTokens,
      outputTokens,
      latencyMs,
      statusCode,
      error,
      fused,
      panelSize,
      judgeUsed,
      strategy
    );
  }

  /** Estimate tokens from request (fallback when response lacks usage) */
  private estimateTokens(request: ChatCompletionRequest): number {
    let total = 0;
    for (const msg of request.messages) {
      total += (msg.content?.length ?? 0) / 4; // Rough estimate: 4 chars per token
    }
    return Math.ceil(total);
  }

  /** Flush batch buffer to database */
  async flush(): Promise<void> {
    if (this.batchBuffer.length === 0) return;

    const batch = this.batchBuffer.splice(0, this.batchSize);
    try {
      await initDb();
      for (const entry of batch) {
        await query`
          INSERT INTO requests (
            request_id, timestamp, platform, model, key_id, client_id,
            input_tokens, output_tokens, total_tokens, latency_ms,
            status_code, error, fused, panel_size, judge_used, strategy
          ) VALUES (
            ${entry.request_id}, ${entry.timestamp}, ${entry.platform}, ${entry.model},
            ${entry.key_id}, ${entry.client_id ?? null}, ${entry.input_tokens},
            ${entry.output_tokens}, ${entry.total_tokens}, ${entry.latency_ms},
            ${entry.status_code}, ${entry.error ?? null}, ${entry.fused},
            ${entry.panel_size ?? null}, ${entry.judge_used ?? false},
            ${entry.strategy ?? null}
          )
          ON CONFLICT (request_id) DO UPDATE SET
            output_tokens = EXCLUDED.output_tokens,
            total_tokens = EXCLUDED.total_tokens,
            latency_ms = EXCLUDED.latency_ms,
            status_code = EXCLUDED.status_code,
            error = EXCLUDED.error,
            fused = EXCLUDED.fused,
            panel_size = EXCLUDED.panel_size,
            judge_used = EXCLUDED.judge_used,
            strategy = EXCLUDED.strategy
        `;
      }
      
      // Broadcast completed log entries to WebSocket clients
      for (const entry of batch) {
        if (entry.phase === "response" && entry.status_code > 0) {
          broadcastLog({
            id: 0,
            request_id: entry.request_id,
            timestamp: entry.timestamp,
            platform: entry.platform,
            model: entry.model,
            key_id: entry.key_id,
            client_id: entry.client_id,
            input_tokens: entry.input_tokens,
            output_tokens: entry.output_tokens,
            total_tokens: entry.total_tokens,
            latency_ms: entry.latency_ms,
            status_code: entry.status_code,
            error: entry.error,
            fused: entry.fused,
            panel_size: entry.panel_size,
            judge_used: entry.judge_used,
            strategy: entry.strategy,
          });
        }
      }
    } catch (e) {
      console.error("[request-log] Flush failed:", e);
      // Re-add to buffer for retry (with limit to prevent memory leak)
      this.batchBuffer.unshift(...batch.slice(-this.batchSize));
    }
  }

  /** Get aggregated metrics for a time range */
  async getMetrics(range: TimeRange): Promise<AnalyticsMetrics> {
    try {
      await initDb();
      
      const [basic, byPlatform, byModel, byError, latencies] = await Promise.all([
        // Basic aggregates
        query`
          SELECT 
            COUNT(*) as total_requests,
            COUNT(*) FILTER (WHERE status_code < 400) as successful_requests,
            COUNT(*) FILTER (WHERE status_code >= 400) as failed_requests,
            AVG(latency_ms) as avg_latency_ms,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(total_tokens) as total_tokens,
            COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute') as rpm,
            SUM(total_tokens) FILTER (WHERE timestamp >= NOW() - INTERVAL '1 minute') as tpm
          FROM requests
          WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
        `,
        // By platform
        query`
          SELECT platform, COUNT(*) as count
          FROM requests
          WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
          GROUP BY platform
        `,
        // By model
        query`
          SELECT model, COUNT(*) as count
          FROM requests
          WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
          GROUP BY model
        `,
        // By error type
        query`
          SELECT error, COUNT(*) as count
          FROM requests
          WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
            AND error IS NOT NULL
          GROUP BY error
        `,
        // Latency percentiles
        query`
          SELECT latency_ms
          FROM requests
          WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
            AND status_code < 400
          ORDER BY latency_ms
        `,
      ]);

      const b = basic[0] || {};
      const lat = latencies.map((r: any) => Number(r.latency_ms)).filter((n: number) => !isNaN(n));

      return {
        total_requests: Number(b.total_requests ?? 0),
        successful_requests: Number(b.successful_requests ?? 0),
        failed_requests: Number(b.failed_requests ?? 0),
        avg_latency_ms: Number(b.avg_latency_ms ?? 0),
        total_input_tokens: Number(b.total_input_tokens ?? 0),
        total_output_tokens: Number(b.total_output_tokens ?? 0),
        total_tokens: Number(b.total_tokens ?? 0),
        requests_by_platform: Object.fromEntries(byPlatform.map((r: any) => [r.platform, Number(r.count)])),
        requests_by_model: Object.fromEntries(byModel.map((r: any) => [r.model, Number(r.count)])),
        errors_by_type: Object.fromEntries(byError.map((r: any) => [r.error, Number(r.count)])),
        p50_latency_ms: percentile(lat, 50),
        p95_latency_ms: percentile(lat, 95),
        p99_latency_ms: percentile(lat, 99),
        rpm: Number(b.rpm ?? 0),
        tpm: Number(b.tpm ?? 0),
      };
    } catch (e) {
      console.error("[request-log] getMetrics failed:", e);
      return emptyMetrics();
    }
  }

  /** Get time-series data for charts */
  async getTimeSeries(range: TimeRange, bucket: "minute" | "hour" | "day" = "minute"): Promise<Array<{
    bucket: string;
    requests: number;
    tokens: number;
    latency_ms: number;
    errors: number;
  }>> {
    try {
      await initDb();
      const interval = bucket === "minute" ? "1 minute" : bucket === "hour" ? "1 hour" : "1 day";
      
      const rows = await query`
        SELECT 
          date_trunc(${bucket}, timestamp) as bucket,
          COUNT(*) as requests,
          SUM(total_tokens) as tokens,
          AVG(latency_ms) as latency_ms,
          COUNT(*) FILTER (WHERE status_code >= 400) as errors
        FROM requests
        WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
        GROUP BY date_trunc(${bucket}, timestamp)
        ORDER BY bucket
      `;

      return rows.map((r: any) => ({
        bucket: r.bucket,
        requests: Number(r.requests ?? 0),
        tokens: Number(r.tokens ?? 0),
        latency_ms: Number(r.latency_ms ?? 0),
        errors: Number(r.errors ?? 0),
      }));
    } catch (e) {
      console.error("[request-log] getTimeSeries failed:", e);
      return [];
    }
  }

  /** Get top models by usage */
  async getTopModels(range: TimeRange, limit: number = 10): Promise<Array<{
    model: string;
    requests: number;
    tokens: number;
    avg_latency_ms: number;
  }>> {
    try {
      await initDb();
      const rows = await query`
        SELECT 
          model,
          COUNT(*) as requests,
          SUM(total_tokens) as tokens,
          AVG(latency_ms) as avg_latency_ms
        FROM requests
        WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
        GROUP BY model
        ORDER BY requests DESC
        LIMIT ${limit}
      `;
      return rows.map((r: any) => ({
        model: r.model,
        requests: Number(r.requests ?? 0),
        tokens: Number(r.tokens ?? 0),
        avg_latency_ms: Number(r.avg_latency_ms ?? 0),
      }));
    } catch (e) {
      console.error("[request-log] getTopModels failed:", e);
      return [];
    }
  }

  /** Get recent errors */
  async getRecentErrors(range: TimeRange, limit: number = 50): Promise<RequestLogEntry[]> {
    try {
      await initDb();
      const rows = await query`
        SELECT *
        FROM requests
        WHERE timestamp >= ${range.from.toISOString()} AND timestamp <= ${range.to.toISOString()}
          AND error IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
      return rows.map((r: any) => ({
        id: r.id,
        request_id: r.request_id,
        timestamp: r.timestamp,
        platform: r.platform,
        model: r.model,
        key_id: Number(r.key_id),
        client_id: r.client_id,
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
        total_tokens: Number(r.total_tokens ?? 0),
        latency_ms: Number(r.latency_ms ?? 0),
        status_code: Number(r.status_code ?? 0),
        error: r.error,
        fused: r.fused,
        panel_size: r.panel_size,
        judge_used: r.judge_used,
        strategy: r.strategy,
      }));
    } catch (e) {
      console.error("[request-log] getRecentErrors failed:", e);
      return [];
    }
  }
}

/** Internal log data structure */
interface RequestLogData {
  request_id: string;
  timestamp: string;
  platform: string;
  model: string;
  key_id: number;
  client_id?: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  latency_ms: number;
  status_code: number;
  error?: string;
  fused: boolean;
  panel_size?: number;
  judge_used?: boolean;
  strategy?: string;
  phase: "request" | "response";
}

/** Calculate percentile from sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Empty metrics fallback */
function emptyMetrics(): AnalyticsMetrics {
  return {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    avg_latency_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    requests_by_platform: {},
    requests_by_model: {},
    errors_by_type: {},
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    p99_latency_ms: 0,
    rpm: 0,
    tpm: 0,
  };
}

/** Global instance */
export const requestLogger = new RequestLogger();

/** Generate unique request ID */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}