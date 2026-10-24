/**
 * proxy-helpers.ts — port of FreeLLMAPI routes/proxy.ts helper functions.
 *
 * Extracts the critical request-level helpers (auth token extraction, request
 * tracing, error classification, streaming formatters, request logging) that
 * OpenLLM's split route files reference but did not previously have.
 *
 * Ported from:
 *   routes/proxy.ts (extractApiToken, getRequestGroupId, traceRouteEvent,
 *                    streamChunkText, streamReasoningText, completionReasoningText)
 *   lib/error-classify.ts (isRetryableError, isPaymentRequiredError,
 *                          isModelNotFoundError, isModelAccessForbiddenError,
 *                          isClientAbortError)
 *   lib/request-log.ts (logRequest)
 *
 * NOTE: getStickyModel/setStickyModel are already ported into services/router.ts
 * (SmartRouter). clearReasoningMemory is a no-op (OpenLLM does not retain
 * in-memory reasoning across turns).
 */

// randomUUID from Web Crypto API (available in Deno runtime)

// ── Auth token extraction ───────────────────────────────────────────────────

/** Extract the unified API key from an incoming request.
 * Accepts Bearer (OpenAI), x-api-key (Anthropic), and
 * x-goog-api-key (Gemini) headers. */
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers.get("x-api-key");
  const trimmed = apiKeyHeader?.trim();
  if (trimmed) return trimmed;

  const googleHeader = req.headers.get("x-goog-api-key");
  return googleHeader?.trim() || undefined;
}

// ── Request tracing ────────────────────────────────────────────────────────

/** Extract x-request-id or generate a UUID for request grouping. */
export function getRequestGroupId(req: Request | { headers?: { get?: (k: string) => string | null } }): string {
  const get = req.headers?.get?.bind(req.headers);
  const raw = get ? get("x-request-id") : null;
  const trimmed = (raw as string | null)?.trim();
  return trimmed || globalThis.crypto.randomUUID();
}

/** Short version of request id for log lines (6 hex chars). */
function shortRequestId(requestId: string): string {
  return requestId.replace(/-/g, "").slice(0, 6);
}

type TraceEvent = "start" | "next" | "ok" | "fail";

/** Structured trace logging for proxy routing events. */
export function traceRouteEvent(
  scope: "Proxy" | "Responses",
  opts: {
    event: TraceEvent;
    requestId: string;
    attempt: number;
    platform: string;
    model: string;
    requestedModel?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  },
): void {
  const parts = [
    `[${scope}]`,
    new Date().toISOString().slice(11, 19),
    opts.event,
    shortRequestId(opts.requestId),
    `a${opts.attempt}`,
    opts.platform,
    "-",
    opts.model,
  ];
  if (opts.requestedModel) parts.push(`req=${opts.requestedModel}`);
  if (opts.latencyMs != null) parts.push(`lat=${opts.latencyMs}ms`);
  if (opts.inputTokens != null) parts.push(`in=${opts.inputTokens}`);
  if (opts.outputTokens != null) parts.push(`out=${opts.outputTokens}`);
  if (opts.error) parts.push(`err=${JSON.stringify(opts.error)}`);
  console.log(parts.join(" "));
}

// ── Error classification (ported from lib/error-classify.ts) ────────────────

/** Markers in error text that indicate a retryable condition. */
const RETRYABLE_MARKERS = [
  "timeout", "timed out", "etimedout", "timeout_error",
  "connection reset", "econnreset", "socket hang up",
  "throttl", "rate limit", "429", "too many requests",
  "502", "503", "504", "bad gateway", "gateway timeout",
  "service unavailable", "temporarily unavailable",
  "overloaded", "capacity", "quota exceeded",
  "upstream", "internal server error",
  "is_explored", "is_explored", // custom markers
  "no healthy upstream",
];

/** True when the error should trigger a fallback retry rather than a hard fail. */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err).toLowerCase();
  return RETRYABLE_MARKERS.some(m => msg.includes(m));
}

/** 402 / payment-required signal from the provider. */
export function isPaymentRequiredError(err: unknown): boolean {
  const msg = (err as Record<string, unknown>)?.message
    ? String((err as Record<string, unknown>).message).toLowerCase()
    : String(err).toLowerCase();
  const status = (err as Record<string, unknown>)?.status
    ? Number((err as Record<string, unknown>).status)
    : 0;
  return status === 402 || msg.includes("payment_required") || msg.includes("payment required")
    || msg.includes("billing") || msg.includes("subscription")
    || msg.includes("quota exceeded");
}

/** Model not found / deprecated / EOL. */
export function isModelNotFoundError(err: unknown): boolean {
  const msg = (err as Record<string, unknown>)?.message
    ? String((err as Record<string, unknown>).message).toLowerCase()
    : String(err).toLowerCase();
  const status = (err as Record<string, unknown>)?.status
    ? Number((err as Record<string, unknown>).status)
    : 0;
  return status === 404404 || status === 404
    || status === 404
    || msg.includes("model not found")
    || msg.includes("model_not_found")
    || msg.includes("does not exist")
    || msg.includes("is not supported")
    || msg.includes("deprecated")
    || msg.includes("eol")
    || msg.includes("retired")
    || msg.includes("decommissioned")
    || msg.includes("1160"); // provider-internal code
}

/** Model access forbidden (not a key problem, a model scope problem). */
export function isModelAccessForbiddenError(err: unknown): boolean {
  const msg = (err as Record<string, unknown>)?.message
    ? String((err as Record<string, unknown>).message).toLowerCase()
    : String(err).toLowerCase();
  const status = (err as Record<string, unknown>)?.status
    ? Number((err as Record<string, unknown>).status)
    : 0;
  return status === 403
    || msg.includes("access denied")
    || msg.includes("model not authorized")
    || msg.includes("not permitted to use this model")
    || msg.includes("model not available");
}

/** Abort-like / client-side disconnect. */
export function isClientAbortError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err).toLowerCase();
  return msg.includes("aborted")
    || msg.includes("client closed")
    || msg.includes("socket hang up")
    || (err as Record<string, unknown>)?.name === "ClientClosedRequestError";
}

// ── Streaming formatters ───────────────────────────────────────────────────

/** Extract plain text from a streaming chunk (SSE data line or token string). */
export function streamChunkText(chunk: unknown): string | null {
  if (typeof chunk === "string") {
    if (chunk.startsWith("data:")) {
      const data = chunk.slice(5).trim();
      if (data === "[DONE]" || data === "") return null;
      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (choice?.delta?.content) return choice.delta.content;
        if (choice?.delta?.reasoning_content) return choice.delta.reasoning_content;
        return null;
      } catch {
        return null;
      }
    }
    return chunk;
  }
  if (chunk && typeof chunk === "object") {
    const obj = chunk as Record<string, unknown>;
    if (obj.type === "content_block_delta") {
      const delta = obj.delta as unknown as Record<string, unknown>;
      if (typeof delta.text === "string") return delta.text;
    }
    const choices3 = (obj.choices as Array<Record<string, unknown>> | undefined);
    const delta3 = choices3?.[0]?.delta as Record<string, unknown> | undefined;
    if (delta3 && typeof delta3.content === "string") {
      return delta3.content;
    }
  }
  return null;
}

/** Extract reasoning text from a streaming chunk. */
export function streamReasoningText(chunk: unknown): string | null {
  if (typeof chunk === "string") {
    if (chunk.startsWith("data:")) {
      const data = chunk.slice(5).trim();
      if (data === "[DONE]" || data === "") return null;
      try {
        const parsed = JSON.parse(data);
        return parsed.choices?.[0]?.delta?.reasoning_content ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
  if (chunk && typeof chunk === "object") {
    const obj = chunk as Record<string, unknown>;
    const choices2 = (obj.choices as Array<Record<string, unknown>> | undefined);
    const delta2 = choices2?.[0]?.delta as Record<string, unknown> | undefined;
    if (delta2 && typeof delta2.reasoning_content === "string") {
      return delta2.reasoning_content;
    }
  }
  return null;
}

/** Extract reasoning text from a NON-streaming OpenAI response. */
export function completionReasoningText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const obj = result as Record<string, unknown>;
  try {
    const choices = (obj.choices as Array<Record<string, unknown>> | undefined);
    const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
    if (msg?.reasoning_content) {
      return String(msg.reasoning_content);
    }
    if (msg?.reasoning) {
      return String(msg.reasoning);
    }
  } catch {}
  return "";
}

// ── Request logging (simplified) ─────────────────────────────────────────────

export interface RequestTrace {
  id: string;          // request group id
  platform: string;    // which provider
  model: string;       // which model
  attempt: number;
  event: "start" | "ok" | "fail";
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  status_code?: number;
  error?: string;
  timestamp: number;
}

const RECENT_TRACES: RequestTrace[] = [];
const MAX_RECENT_TRACES = 1000;

export function logRequest(trace: RequestTrace): void {
  RECENT_TRACES.push(trace);
  if (RECENT_TRACES.length > MAX_RECENT_TRACES) {
    RECENT_TRACES.shift();
  }
  // Structured log line matching FreeLLMAPI format
  traceRouteEvent("Proxy", {
    event: trace.event,
    requestId: trace.id,
    attempt: trace.attempt,
    platform: trace.platform,
    model: trace.model,
    latencyMs: trace.latency_ms,
    inputTokens: trace.input_tokens,
    outputTokens: trace.output_tokens,
    error: trace.error,
  });
}

export function getRecentTraces(limit = 100): RequestTrace[] {
  return RECENT_TRACES.slice(-limit).reverse();
}

// ── Clear reasoning memory (no-op for OpenLLM) ──────────────────────────────

/** OpenLLM does not retain in-memory reasoning across turns — this is a no-op
 * kept for API compatibility with FreeLLMAPI imports. */
export function clearReasoningMemory(): void {
  /* no-op */
}

/**
 * Redact credentials / URLs out of a provider error message before it crosses
 * the trust boundary into logs or client responses. Ported from FreeLLMAPI
 * `lib/error-redaction.ts` (51 lines, self-contained).
 */
const MAX_PROVIDER_ERROR_LENGTH = 240;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/([\"']?)\b(api[_-]?key|access[_-]?token|token|secret|authorization)\b\1(\s*[:=]\s*)([\"']?)[^"',\s}\]]+/gi, "$1$2$1$3$4[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/\bgsk_[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/\bfreellmapi-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-key]"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]"],
  [/\b[A-Za-z0-9]{32,}\b/g, "[redacted-token]"],
  [/\bhttps?:\/\/[^\s"'<>)]*/gi, "[redacted-url]"],
];

export function sanitizeProviderErrorMessage(message: unknown): string {
  let sanitized = typeof message === "string" ? message : String(message ?? "");
  sanitized = sanitized.trim();
  if (!sanitized) return "Provider error";
  for (const [pattern, replacement] of REDACTIONS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  sanitized = sanitized.replace(/\\s+/g, " ").trim();
  if (sanitized.length > MAX_PROVIDER_ERROR_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_PROVIDER_ERROR_LENGTH - 3).trimEnd()}...`;
  }
  return sanitized;
}

const MAX_ATTEMPT_ERROR_SUMMARY_LENGTH = 200;
export function summarizeAttemptError(message: unknown): string {
  let summary = sanitizeProviderErrorMessage(message);
  if (summary.length > MAX_ATTEMPT_ERROR_SUMMARY_LENGTH) {
    summary = `${summary.slice(0, MAX_ATTEMPT_ERROR_SUMMARY_LENGTH - 3).trimEnd()}...`;
  }
  return summary;
}
