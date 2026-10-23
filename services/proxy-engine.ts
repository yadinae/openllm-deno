/**
 * proxy-engine.ts — Core proxy engine for /v1/chat/completions.
 *
 * Ports the critical patterns from FreeLLMAPI routes/proxy.ts:
 *   - Message normalization (developer→system, function→tool, empty-content fix)
 *   - Pre-flight validation (vision gate, tools gate, token estimation w/ images)
 *   - Response envelope injection (execution_id, _routed_via, X-Routed-Via header)
 *   - Client disconnect handling (AbortController, clientGone flag)
 *
 * Architecture: OpenLLM uses Hono (not Express). The engine produces a
 * PreflightResult and a response-shaping layer so individual route files can
 * call it and focus on provider dispatch.
 *
 * The fallback loop is handled by executeWithFallback() in router.ts. This
 * module provides the PRE-DISPATCH wiring: normalize → validate → estimate →
 * inject headers.
 */

import type { ChatCompletionRequest } from "../providers/types.ts";
import {
  getRequestGroupId,
  traceRouteEvent,
  type RequestTrace,
  logRequest as logProxyRequest,
} from "./proxy-helpers.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const IMAGE_TOKEN_ESTIMATE = 1000; // per-image cost heuristic (FreeLLMAPI parity)

// ── Message normalization ────────────────────────────────────────────────────

/**
 * Normalize an incoming ChatCompletionRequest messages array into the proxy's
 * internal shape. Handles the three known shape drifts:
 *
 * 1. `developer` role → `system` (OpenAI renamed it; some providers only know "system")
 * 2. `function` role → `tool` (legacy function-calling → modern tool-calling)
 * 3. Empty/null assistant content without tool_calls → coerce to ""
 */
function normalizeMessages(raw: ChatCompletionRequest["messages"]): ProxyNormalizedMessage[] {
  if (!Array.isArray(raw)) return [];

  const pendingToolCallIds: string[] = [];
  let syntheticIdCounter = 0;

  const takeToolCallId = (given: string | undefined): string => {
    if (given && given.length > 0) {
      const idx = pendingToolCallIds.indexOf(given);
      if (idx !== -1) pendingToolCallIds.splice(idx, 1);
      return given;
    }
    return pendingToolCallIds.shift() ?? `call_auto_${++syntheticIdCounter}`;
  };

  const result: ProxyNormalizedMessage[] = [];

  for (const m of raw) {
    const role = (m as any).role;

    // developer → system
    if (role === "developer") {
      result.push({ role: "system", ...(m as object) } as ProxyNormalizedMessage);
      continue;
    }

    // function → tool
    if (role === "function") {
      result.push({
        role: "tool",
        content: (m as any).content ?? "",
        tool_call_id: takeToolCallId((m as any).tool_call_id),
        name: (m as any).name,
      } as ProxyNormalizedMessage);
      continue;
    }

    if (role === "assistant") {
      const hasToolCalls = ((m as any).tool_calls?.length ?? 0) > 0;
      const isEmptyContent =
        (m as any).content == null ||
        ((typeof (m as any).content === "string" && (m as any).content.length === 0) ||
          (Array.isArray((m as any).content) && (m as any).content.length === 0));

      // Keep null content when tool_calls are present (correct OpenAI shape).
      // Coerce empty/null to "" when there are no tool_calls (strict upstreams reject it otherwise).
      const assistantContent = hasToolCalls
        ? ((m as any).content ?? null)
        : (isEmptyContent ? "" : (m as any).content);

      const entry: ProxyNormalizedMessage = {
        role: "assistant",
        content: assistantContent,
        ...(typeof (m as any).name === "string" && (m as any).name
          ? { name: (m as any).name }
          : {}),
      };

      // Forward reasoning_content verbatim (needed by DeepSeek thinking models)
      if (typeof (m as any).reasoning_content === "string" && (m as any).reasoning_content.length > 0) {
        (entry as any).reasoning_content = (m as any).reasoning_content;
      }

      // Forward partial flag for Moonshot-style prefills
      if ((m as any).partial === true) {
        (entry as any).partial = true;
      }

      // Handle tool_calls: normalize function.arguments to string, synthesize ids
      if (hasToolCalls) {
        const toolCalls = ((m as any).tool_calls ?? []) as Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
        entry.tool_calls = toolCalls.map((tc) => {
          const id = tc.id && tc.id.length > 0 ? tc.id : `call_auto_${++syntheticIdCounter}`;
          pendingToolCallIds.push(id);
          return {
            id,
            type: "function" as const,
            function: {
              name: tc.function?.name ?? "",
              arguments: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? ""),
            },
          };
        });
      }

      result.push(entry);
      continue;
    }

    if (role === "tool") {
      result.push({
        role: "tool",
        content: (m as any).content ?? "",
        tool_call_id: takeToolCallId((m as any).tool_call_id),
        ...(typeof (m as any).name === "string" && (m as any).name
          ? { name: (m as any).name }
          : {}),
      } as ProxyNormalizedMessage);
      continue;
    }

    // user / system — passthrough
    result.push({ role, content: (m as any).content, ...(typeof (m as any).name === "string" ? { name: (m as any).name } : {}) } as ProxyNormalizedMessage);
  }

  return result;
}

// ── Token estimation ─────────────────────────────────────────────────────────

/** chars/4 heuristic for token estimation (FreeLLMAPI parity). */
function estimateInputTokens(messages: ProxyNormalizedMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = (m as any).content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) {
      for (const block of c) {
        if (block && typeof block === "object") {
          const txt = (block as any).text ?? (block as any).input ?? "";
          if (typeof txt === "string") chars += txt.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Count inline images across all messages. */
function countImages(messages: ProxyNormalizedMessage[]): number {
  let count = 0;
  for (const m of messages) {
    const c = (m as any).content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (!block || typeof block !== "object") continue;
      const type = (block as any).type;
      if (type === "image_url" || type === "image") count++;
    }
  }
  return count;
}

/** Check if request has image content. */
function hasImageContent(messages: ProxyNormalizedMessage[]): boolean {
  return countImages(messages) > 0;
}

/** Check if request has tools defined. */
function hasTools(messages: ProxyNormalizedMessage[], tools: unknown[]): boolean {
  // Tools defined in the request
  if ((tools?.length ?? 0) > 0) return true;
  // Tool calls in messages (previous turns)
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      if ((m as any).tool_calls.length > 0) return true;
    }
    if (m.role === "tool" && (m as any).tool_call_id) return true;
  }
  return false;
}

// ── Preflight ────────────────────────────────────────────────────────────────

export interface ProxyNormalizedMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning_content?: string;
  partial?: boolean;
}

export interface ProxyPreflightResult {
  messages: ProxyNormalizedMessage[];
  tools: unknown[];
  hasImage: boolean;
  wantsTools: boolean;
  estimatedInputTokens: number;
  imageCount: number;
  estimatedTotalTokens: number;
  requestId: string;
  executionId: string;
  abortController: AbortController;
  clientGoneFlag: { value: boolean };
}

/**
 * Run pre-flight validation on a chat completion request.
 * Returns normalization + estimation results; also sets up client-disconnect
 * detection via AbortController.
 *
 * In Hono, the "res.on('close')" equivalent is handled differently — we use
 * the AbortController pattern. The caller should pass `c.req.signal` or create
 * a fresh one.
 */
export function runPreflight(
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): ProxyPreflightResult {
  const requestId = getRequestGroupId(request as unknown as Request);
  const executionId = requestId; // For proxy parity, use same id

  // Normalize messages
  const normalized = normalizeMessages(request.messages ?? []);
  const tools = (request.tools as unknown[] | undefined) ?? [];

  // Count images for token estimation
  const imageCount = countImages(normalized);
  const hasImage = imageCount > 0;
  const wantsTools = hasTools(normalized, tools);

  // Estimate tokens
  const estimatedInputTokens = estimateInputTokens(normalized);
  const imageTokenCost = imageCount * IMAGE_TOKEN_ESTIMATE;

  // Output reserve (same logic as FreeLLMAPI's routingReserveTokens)
  const requestedMaxTokens = (request.max_tokens as number | undefined) ?? ((request as unknown as Record<string, unknown>).max_completion_tokens as number | undefined) ?? 0;
  const outputReserve = Math.min(requestedMaxTokens > 0 ? requestedMaxTokens : 4096, 8192);
  const estimatedTotalTokens = estimatedInputTokens + imageTokenCost + outputReserve;

  // Client disconnect detection — AbortController owns both signal and abort().
  // If the caller passes a pre-made signal (Hono's c.req.signal), we wrap it
  // so we can still call .abort() from our side. Otherwise create one fresh.
  let abortController: AbortController;
  if (signal) {
    abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort(), { once: true });
  } else {
    abortController = new AbortController();
  }
  const clientGoneFlag = { value: false };

  // Note: In Hono, we cannot hook `res.on('close')`. The caller should check
  // abortController.aborted periodically during streaming.
  // For the proxy-helpers pattern, we export the abort controller for the caller.
  // A real Express `res.on('close')` hook would be set up in the route handler.

  return {
    messages: normalized,
    tools,
    hasImage,
    wantsTools,
    estimatedInputTokens,
    imageCount,
    estimatedTotalTokens,
    requestId,
    executionId,
    abortController,
    clientGoneFlag,
  };
}

// ── Pre-flight gate checks ───────────────────────────────────────────────────

/**
 * Check if any enabled model supports vision. Uses the router's available keys
 * to determine capability.
 *
 * In OpenLLM this delegates to router.ts — returns true when we have any key
 * with a vision-capable model enabled.
 */
export async function hasEnabledVisionModel(): Promise<boolean> {
  try {
    const { listCatalogModels } = await import("../db/pg.ts");
    const models = await listCatalogModels();
    return models.some((m) => (m as any).supports_vision === 1);
  } catch {
    return false;
  }
}

/**
 * Check if any enabled model supports tools/function-calling.
 */
export async function hasEnabledToolsModel(): Promise<boolean> {
  try {
    const { listCatalogModels } = await import("../db/pg.ts");
    const models = await listCatalogModels();
    return models.some((m) => (m as any).supports_tools === 1);
  } catch {
    return false;
  }
}

// ── Response envelope helpers ────────────────────────────────────────────────

/**
 * Inject the `_routed_via` metadata into a response object.
 * Mirrors FreeLLMAPI's routedViaValue() for response consistency.
 */
export function injectRoutedVia(
  response: Record<string, unknown>,
  platform: string,
  model: string,
  metadata: Record<string, unknown> = {},
): void {
  response._routed_via = {
    platform,
    model,
    ...metadata,
  };
}

/**
 * Build the `X-Routed-Via` header value string.
 */
export function buildRoutedViaHeader(platform: string, model: string): string {
  return `${platform}/${model}`;
}

// ── Token estimation improvements ────────────────────────────────────────────

/**
 * Estimate output tokens from a response (for cases where the provider
 * doesn't include usage in the final chunk).
 */
export function estimateOutputTokens(text: string, reasoningText?: string): number {
  let chars = text.length;
  if (reasoningText) chars += reasoningText.length;
  return Math.ceil(chars / 4);
}

/**
 * Extract reasoning text from a non-streaming response.
 */
export function getResponseReasoningText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const obj = response as Record<string, unknown>;
  try {
    const choices = (obj.choices as Array<Record<string, unknown>> | undefined);
    const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
    if (msg?.reasoning_content && typeof msg.reasoning_content === "string") {
      return msg.reasoning_content as string;
    }
    if (msg?.reasoning && typeof msg.reasoning === "string") {
      return msg.reasoning as string;
    }
  } catch {}
  return "";
}

// ── Logging helpers ──────────────────────────────────────────────────────────

/**
 * Log a successful request for analytics tracking.
 */
export function logProxySuccess(
  platform: string,
  model: string,
  keyId: number | undefined,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  requestId: string,
  pinnedModel: string | null = null,
): void {
  logProxyRequest({
    id: requestId,
    platform,
    model,
    attempt: 1,
    event: "ok",
    latency_ms: latencyMs,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    status_code: 200,
    timestamp: Date.now(),
  });
}

/**
 * Log a failed request for analytics tracking.
 */
export function logProxyFailure(
  platform: string,
  model: string,
  keyId: number | undefined,
  inputTokens: number,
  latencyMs: number,
  error: string,
  requestId: string,
  pinnedModel: string | null = null,
): void {
  logProxyRequest({
    id: requestId,
    platform,
    model,
    attempt: 1,
    event: "fail",
    latency_ms: latencyMs,
    input_tokens: inputTokens,
    output_tokens: 0,
    status_code: undefined,
    error,
    timestamp: Date.now(),
  });
}
