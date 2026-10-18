/**
 * Prometheus Metrics Endpoint — R-004.
 * Phase C Week 11-12: Prometheus/Grafana metrics export.
 *
 * Exposes /api/observability/prometheus endpoint in Prometheus text format
 * for scraping by Prometheus server and visualization in Grafana.
 */

import { Hono } from "hono";
import { requestLogger } from "../services/request-log.ts";
import { quotaEngine } from "../services/ratelimit.ts";
import { providerRegistry, initializeRegistry } from "../providers/index.ts";

initializeRegistry();

interface PrometheusMetric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram" | "summary";
  values: Array<{ labels: Record<string, string>; value: number }>;
}

const metricsRegistry = new Map<string, PrometheusMetric>();

/** Register or update a metric */
function setMetric(
  name: string,
  help: string,
  type: PrometheusMetric["type"],
  labels: Record<string, string>,
  value: number
) {
  const existing = metricsRegistry.get(name);
  if (existing) {
    // Update existing label set or add new
    const idx = existing.values.findIndex(
      (v) => JSON.stringify(v.labels) === JSON.stringify(labels)
    );
    if (idx >= 0) {
      existing.values[idx].value = value;
    } else {
      existing.values.push({ labels, value });
    }
  } else {
    metricsRegistry.set(name, {
      name,
      help,
      type,
      values: [{ labels, value }],
    });
  }
}

/** Clear all metrics */
function clearMetrics() {
  metricsRegistry.clear();
}

/** Format metrics in Prometheus text format */
function formatPrometheus(): string {
  const lines: string[] = [];
  
  for (const metric of metricsRegistry.values()) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    
    for (const { labels, value } of metric.values) {
      const labelStr = Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
        .join(",");
      const prefix = labelStr ? `{${labelStr}}` : "";
      lines.push(`${metric.name}${prefix} ${value}`);
    }
    lines.push(""); // Empty line between metrics
  }
  
  return lines.join("\n");
}

/** Collect all metrics from internal services */
async function collectMetrics(): Promise<void> {
  clearMetrics();
  
  try {
    // 1. RequestLogger metrics
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const rlMetrics = await requestLogger.getMetrics({ from: hourAgo, to: now });
    
    setMetric("openllm_requests_total", "Total number of requests", "counter", {}, rlMetrics.total_requests);
    setMetric("openllm_requests_success_total", "Total successful requests", "counter", {}, rlMetrics.successful_requests);
    setMetric("openllm_requests_failed_total", "Total failed requests", "counter", {}, rlMetrics.failed_requests);
    setMetric("openllm_requests_rpm", "Requests per minute", "gauge", {}, rlMetrics.rpm);
    setMetric("openllm_tokens_total", "Total tokens processed", "counter", {}, rlMetrics.total_tokens);
    setMetric("openllm_tokens_input_total", "Total input tokens", "counter", {}, rlMetrics.total_input_tokens);
    setMetric("openllm_tokens_output_total", "Total output tokens", "counter", {}, rlMetrics.total_output_tokens);
    setMetric("openllm_tpm", "Tokens per minute", "gauge", {}, rlMetrics.tpm);
    setMetric("openllm_latency_avg_ms", "Average latency in milliseconds", "gauge", {}, Math.round(rlMetrics.avg_latency_ms));
    setMetric("openllm_latency_p50_ms", "P50 latency in milliseconds", "gauge", {}, rlMetrics.p50_latency_ms);
    setMetric("openllm_latency_p95_ms", "P95 latency in milliseconds", "gauge", {}, rlMetrics.p95_latency_ms);
    setMetric("openllm_latency_p99_ms", "P99 latency in milliseconds", "gauge", {}, rlMetrics.p99_latency_ms);
    
    // By platform
    for (const [platform, count] of Object.entries(rlMetrics.requests_by_platform)) {
      setMetric("openllm_requests_by_platform_total", "Requests by platform", "counter", { platform }, count);
    }
    
    // By model
    for (const [model, count] of Object.entries(rlMetrics.requests_by_model)) {
      setMetric("openllm_requests_by_model_total", "Requests by model", "counter", { model }, count);
    }
    
    // Errors by type
    for (const [error, count] of Object.entries(rlMetrics.errors_by_type)) {
      setMetric("openllm_errors_by_type_total", "Errors by type", "counter", { error: error.slice(0, 100) }, count);
    }
    
  } catch (e) {
    console.error("[prometheus] RequestLogger metrics collection failed:", e);
  }
  
  try {
    // 2. Provider registry metrics
    const providers = providerRegistry.getAllIds();
    setMetric("openllm_providers_total", "Total registered providers", "gauge", {}, providers.length);
    
    const byProtocol: Record<string, number> = {};
    for (const id of providers) {
      const entry = providerRegistry.getEntry(id);
      if (entry?.enabled) {
        byProtocol[entry.config.protocol] = (byProtocol[entry.config.protocol] || 0) + 1;
      }
    }
    for (const [protocol, count] of Object.entries(byProtocol)) {
      setMetric("openllm_providers_by_protocol", "Providers by protocol", "gauge", { protocol }, count);
    }
    
    // Provider health
    for (const id of providers) {
      const entry = providerRegistry.getEntry(id);
      if (entry) {
        const health = entry.health_status === "healthy" ? 1 : entry.health_status === "degraded" ? 0.5 : 0;
        setMetric("openllm_provider_health", "Provider health status (1=healthy, 0.5=degraded, 0=down)", "gauge", { provider: id }, health);
      }
    }
    
  } catch (e) {
    console.error("[prometheus] Provider metrics collection failed:", e);
  }
  
  try {
    // 3. Quota engine metrics (if available)
    // Note: QuotaEngine doesn't expose global stats, but we can add placeholder
    setMetric("openllm_quota_engines_active", "Active quota engines", "gauge", {}, 1);
    
  } catch (e) {
    console.error("[prometheus] Quota metrics collection failed:", e);
  }
  
  // 4. System metrics
  const memUsage = Deno.memoryUsage?.() ?? { heapUsed: 0, heapTotal: 0, external: 0, rss: 0 };
  setMetric("openllm_memory_heap_used_bytes", "Heap memory used", "gauge", {}, memUsage.heapUsed ?? 0);
  setMetric("openllm_memory_heap_total_bytes", "Heap memory total", "gauge", {}, memUsage.heapTotal ?? 0);
  setMetric("openllm_memory_rss_bytes", "RSS memory", "gauge", {}, memUsage.rss ?? 0);
  
  // 5. Uptime
  const startTime = (globalThis as any).openllmStartTime ?? Date.now();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  setMetric("openllm_uptime_seconds", "Process uptime in seconds", "gauge", {}, uptimeSeconds || 0);
  
  // 6. WebSocket clients
  const { getClientStats } = await import("./ws-observability.ts");
  const wsStats = getClientStats();
  setMetric("openllm_ws_clients_total", "Connected WebSocket clients", "gauge", {}, wsStats.total);
  for (const [sub, count] of Object.entries(wsStats.bySubscription)) {
    setMetric("openllm_ws_clients_by_subscription", "WebSocket clients by subscription", "gauge", { subscription: sub }, count);
  }
}

/** Prometheus routes */
const promRoutes = new Hono();

// Main Prometheus scrape endpoint
promRoutes.get("/prometheus", async (c) => {
  await collectMetrics();
  const output = formatPrometheus();
  return c.text(output, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});

// JSON format for debugging
promRoutes.get("/prometheus/json", async (c) => {
  await collectMetrics();
  const metrics = Array.from(metricsRegistry.values());
  return c.json({ metrics, timestamp: new Date().toISOString() });
});

// Health check for Prometheus
promRoutes.get("/prometheus/health", (c) => {
  return c.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    metrics_count: metricsRegistry.size,
  });
});

export const prometheusMetrics = promRoutes;