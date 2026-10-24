/**
 * OpenAI Responses API inbound — POST /v1/responses
 *
 * Converted from FreeLLMAPI `server/src/routes/responses.ts` (1666 lines → port).
 * This is the only entry point newer Codex versions speak ("wire_api=responses"),
 * so the port is required for agent parity.
 *
 * It translates a Responses-shaped request → OpenAI chat format → runs it
 * through the SAME shared fallback dispatch as /v1/chat/completions → translates
 * the result back into the Responses object / SSE event stream.
 *
 * ─ Archival mapping (FreeLLMAPI → OpenLLM-Deno) ──────────────────────────
 *   FreeLLMAPI lib/fallback-loop.ts runFallbackLoop{with per-attempt hooks}
 *     → services/router.ts executeWithFallback()  (the loop is INSIDE the
 *        router; this route sees only the final ProviderResult).
 *   lib/system-prompt.ts resolveAuth/prependSystemPrompt (client profiles #411)
 *     → not ported; /v1 has no caller-facing auth (gateway key is implicit).
 *   lib/compression/pipeline.ts compressRequest
 *     → not ported (compression module missing from the port).
 *   lib/image-normalize.ts normalizeMessageImages
 *     → not ported.
 *   lib/guardrails.ts applyTokenBudget/tokenBudgetMessage
 *     → not ported (request_max_tokens_budget unimplemented on this surface).
 *   lib/task-type.ts resolveTaskType, lib/output-cap.ts routeOutputBudget
 *     → not ported (router takes no task-type/output-budget args here).
 *   lib/routing-decision.ts applyDecisionRouting/routingStrategyHeader
 *     → the router applies the strategy internally (see services/router.ts
 *        resolveStrengthForRequest); no per-route injection needed.
 *   lib/responses-web-search.ts web-search serving loop
 *     → webSearchCallToText() is ported for replay notes; the live search loop
 *        is not (no search-pool service wired for Responses).
 *   lib/error-redaction.ts sanitizeProviderErrorMessage
 *     → ported to services/proxy-helpers.ts (shared).
 *   lib/tool-args.ts repairToolArguments/toolSchemaMap
 *     → ported to services/tool-args.ts (shared).
 *   lib/structured-output.ts enforceJsonContent
 *     → ported to services/structured-output.ts.
 *
 * Deviation (honest): structured-output "fail over on ignore" and streaming
 * commit-point failover can't retry a sibling model here, because OpenLLM's
 * executeWithFallback exhausts its chain BEFORE returning a stream. Non-healable
 * format violations surface as a 422; a mid-stream tool/empty error surfaces as
 * response.failed. This matches chat.ts parity (which also lacks those hooks).
 */
import { Hono } from "hono";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  ToolCall,
  Tool,
  RoutingDecision,
} from "../providers/types.ts";
import { decryptKey } from "../db/mod.ts";
import { listApiKeys, listCatalogModels, getSetting } from "../db/pg.ts";
import { getAdapterForPlatform, executeChat } from "../providers/index.ts";
import type { ProviderResult, ApiKey } from "../providers/types.ts";
import type { FusionConfig } from "../services/fusion.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";
import { smartRouter, executeWithFallback, summarizeExhaustion, estimateRequestTokens } from "../services/router.ts";
import { runFusion } from "../services/fusion.ts";
import { runPreflight, hasEnabledVisionModel, hasEnabledToolsModel } from "../services/proxy-engine.ts";
import {
  traceRouteEvent,
  sanitizeProviderErrorMessage,
  isClientAbortError,
  streamReasoningText,
  completionReasoningText,
} from "../services/proxy-helpers.ts";
import { repairToolArguments, toolSchemaMap, type JsonSchemaish } from "../services/tool-args.ts";
import { enforceJsonContent } from "../services/structured-output.ts";

const responsesRouter = new Hono();

const FUSION_MODEL_ID = "fusion";
const MAX_RETRIES = 20;

function isFusionModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return lower === FUSION_MODEL_ID || lower.startsWith(`${FUSION_MODEL_ID}:`);
}

function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true; // omitted → auto (Codex omits the field for plain auto)
  const lower = modelId.toLowerCase();
  return lower === "auto" || lower.startsWith("auto:");
}

// crypto.randomBytes(18) → 36 hex; Web Crypto gives 32 hex via randomUUID.
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// ──────────────────────────────────────────────────────────────────────────
// Lenient request validation (FreeLLMAPI uses zod with .passthrough(); this port
// has no zod dependency, so we hand-roll the same permissive semantics:
// accept + ignore unknown fields, accept the union of known input-item shapes,
// and 400 with a zod-style `path: msg` summary only for genuinely unusable
// structure). Mirrors `responsesRequestSchema` exactly.
// ──────────────────────────────────────────────────────────────────────────

type InputItem = Record<string, unknown>;
type ResponsesInput = string | InputItem[];

interface ResponsesRequest {
  model?: string;
  instructions?: string | null;
  input: ResponsesInput;
  stream?: boolean;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  tools?: InputItem[];
  fusion?: Partial<FusionConfig>;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; name: string };
  parallel_tool_calls?: boolean | null;
  reason?: string;
  user?: string;
  // Responses-API structured output arrives as `text.format`; mapped to the
  // internal response_format (see RESPONSE_FORMAT constant below).
  text?: { format?: { type: "text" | "json_object" | "json_schema"; name?: string; strict?: boolean | null; schema?: Record<string, unknown> } | null };
  // Sampling params forwarded to ChatCompletionRequest.
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  seed?: number | null;
  stop?: string | string[] | null;
  max_tokens?: number | null;
  [k: string]: unknown;
}

const ACCEPTED_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "computer_call",
  "computer_call_output",
  "reasoning",
  "local_shell_call",
  "additional_tools",
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "image_generation_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "item_reference",
]);

type ValidateResult = { ok: true; data: ResponsesRequest } | { ok: false; errors: string[] };

function validateRequest(raw: unknown): ValidateResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Root: expected a JSON object"] };
  }
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];

  // model optional
  if (body.model !== undefined && typeof body.model !== "string") {
    errors.push("model: expected string");
  }
  // input required: string or array of objects
  if (body.input === undefined) {
    errors.push("input: required");
  } else if (typeof body.input !== "string") {
    if (!Array.isArray(body.input)) {
      errors.push("input: expected string or array");
    } else {
      for (let i = 0; i < body.input.length; i++) {
        const item = body.input[i];
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          errors.push(`input.${i}: expected object`);
          continue;
        }
        const type = (item as { type?: unknown }).type;
        const role = (item as { role?: unknown }).role;
        // A message item must carry role; others must carry one of the known
        // types. Unknown type + no role → reject.
        if (typeof type === "string") {
          if (!ACCEPTED_ITEM_TYPES.has(type)) errors.push(`input.${i}.type: unknown kind '${type}'`);
        } else if (typeof role !== "string") {
          errors.push(`input.${i}: message items require a 'role', other items require a 'type'`);
        }
      }
    }
  }
  // instructions
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") {
    errors.push("instructions: expected string or null");
  }
  // sampling params
  if (body.temperature !== undefined && body.temperature !== null && (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2)) {
    errors.push("temperature: must be 0-2");
  }
  if (body.top_p !== undefined && body.top_p !== null && (typeof body.top_p !== "number" || body.top_p < 0 || body.top_p > 1)) {
    errors.push("top_p: must be 0-1");
  }
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null && (typeof body.max_output_tokens !== "number" || !Number.isInteger(body.max_output_tokens) || body.max_output_tokens <= 0)) {
    errors.push("max_output_tokens: must be a positive integer");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    errors.push("stream: expected boolean");
  }

  if (errors.length) {
    return { ok: false, errors };
  }
  return { ok: true, data: body as unknown as ResponsesRequest };
}

// ─── Content part translation ─────────────────────────────────────────────//

/** Responses content parts → concatenated text (output parts, tool args). */
function partsToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const t = (p as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    })
    .join("");
}

function extractImageUrl(p: { [k: string]: unknown }): string | undefined {
  const raw = p.image_url;
  const url = typeof raw === "string" ? raw : (raw as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

// input_image shares the same `image_url` shape as chat-style image_url blocks.
type ContentBlock = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } };
// A message content is either a flat string (the common case) or a list of
// content blocks (when the turn carries images). ChatMessage.content is typed
// `string` in OpenLLM, but adapters pass message arrays through verbatim, so we
// track an accurate local type and cast at the ChatCompletionRequest boundary.
type ChatContent = string | ContentBlock[];

function partsToChatContent(content: unknown): ChatContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: ContentBlock[] = [];
  for (const p of content) {
    const type = (p as { type?: string }).type;
    const text = (p as { text?: unknown }).text;
    if (
      type === "text" || type === "input_text" || type === "output_text" ||
      type === "summary_text" || (type === undefined && typeof text === "string")
    ) {
      if (typeof text === "string") blocks.push({ type: "text", text });
      continue;
    }
    if (type === "refusal") {
      const refusal = (p as { refusal?: unknown }).refusal;
      if (typeof refusal === "string") blocks.push({ type: "text", text: refusal });
      continue;
    }
    if (type === "input_image" || type === "computer_screenshot" || type === "image_url" || type === "image") {
      const url = extractImageUrl(p as { [k: string]: unknown });
      if (url) {
        const detail = (p as { detail?: unknown }).detail;
        const imgBlock: ContentBlock = {
          type: "image_url",
          image_url: { url, ...(typeof detail === "string" ? { detail } : {}) },
        };
        blocks.push(imgBlock);
      }
      continue;
    }
    // output_text with annotations: `text` handled above; other part kinds
    // (input_audio, etc.) have no chat equivalent — drop.
  }
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => (b as { type: "text"; text: string }).text).join("");
  }
  return blocks;
}

/** Returns true when the input carries an image part referenced only by file_id
 * (no resolvable url). The proxy has no OpenAI Files backend, so such an image
 * can't survive translation — fail 422 instead of answering blind. */
export function responsesInputHasFileIdImage(req: ResponsesRequest): boolean {
  if (typeof req.input !== "string" && Array.isArray(req.input)) {
    return req.input.some((item) => {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return false;
      return content.some((p) => {
        const part = p as { type?: string; [k: string]: unknown };
        if (part.type !== "input_image") return false;
        return extractImageUrl(part) === undefined;
      });
    });
  }
  return false;
}

/** Computer use (computer / computer_use_preview tool + computer_call/output items)
 * has no chat-completions equivalent — fail 422 instead of silently dropping. */
export function responsesInputRequestsComputerUse(req: ResponsesRequest): boolean {
  if ((req.tools ?? []).some((t) => t.type === "computer" || t.type === "computer_use_preview")) return true;
  if (typeof req.input !== "string" && Array.isArray(req.input)) {
    return req.input.some((item) => {
      const type = (item as { type?: string })?.type;
      return type === "computer_call" || type === "computer_call_output";
    });
  }
  return false;
}

/** Format a replayed web_search_call item as a short assistant note so the
 * conversation keeps the context that a search happened (port of
 * lib/responses-web-search.ts webSearchCallToText). Pure and self-contained. */
export function webSearchCallToText(item: Record<string, unknown>): string {
  const action = item?.action as { query?: unknown; sources?: unknown } | undefined;
  const query = typeof action?.query === "string" ? action.query : "";
  if (!query) return "";
  const sources = Array.isArray(action?.sources)
    ? action.sources.map((s: { url?: unknown }) => s?.url).filter((u): u is string => typeof u === "string")
    : [];
  return sources.length > 0
    ? `[Searched the web for: ${query}. Sources: ${sources.slice(0, 10).join(", ")}]`
    : `[Searched the web for: ${query}]`;
}

// ─── Responses input → internal chat messages ──────────────────────────────//

/**
 * Translate a Responses `input` (string | array of ResponseInputItem) into the
 * internal chat message list. Mirrors FreeLLMAPI's toChatMessages exactly:
 *  - instructions → system (hoisted to front)
 *  - developer role → system (Responses-era system)
 *  - web_search_call replayed items → assistant note (context kept)
 *  - consecutive function_call items → single assistant turn with tool_calls
 *  - function_call_output → tool message
 *  - reasoning / computer / local_shell_call → dropped (no chat equivalent)
 *  - image parts (input_image / computer_screenshot / image_url) → image_url blocks
 *  - refusal parts → text (no chat refusal concept)
 *  - empty assistant turns → dropped (strict upstreams 400 on these, #96)
 *  - system/developer mid-conversation → hoisted to front
 */
export function toChatMessages(req: ResponsesRequest): ChatMessage[] {
  // Internal builder uses an accurate content type (string | content blocks)
  // and casts to ChatMessage[] at the end, because OpenLLM's ChatMessage types
  // content as `string` even though adapters pass image-block arrays through.
  interface B {
    role: string;
    content: ChatContent | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }
  const systemMessages: B[] = [];

  if (req.instructions) {
    systemMessages.push({ role: "system", content: req.instructions });
  }

  if (typeof req.input === "string") {
    return [...systemMessages, { role: "user", content: req.input }] as unknown as ChatMessage[];
  }

  const messages: B[] = [];
  let pendingSearchNotes: string[] = [];
  const flushSearchNotes = () => {
    if (pendingSearchNotes.length === 0) return;
    messages.push({ role: "assistant", content: pendingSearchNotes.join("\n") });
    pendingSearchNotes = [];
  };

  const items = req.input ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;

    if (item.type === "web_search_call") {
      const note = webSearchCallToText(item);
      if (note) pendingSearchNotes.push(note);
      continue;
    }

    if (!(item.type === "message" && (item as { role?: string }).role === "assistant")) {
      flushSearchNotes();
    }

    if (item.type === "function_call") {
      // Consecutive standalone function_call items fold into one assistant turn.
      const toolCalls: ToolCall[] = [];
      let j = i;
      while (j < items.length && (items[j] as { type?: string }).type === "function_call") {
        const fc = items[j] as { call_id?: string; name?: string; arguments?: string; id?: string };
        toolCalls.push({
          id: fc.call_id ?? fc.id ?? `call_${newId("").slice(1)}`,
          type: "function",
          function: { name: fc.name ?? "tool", arguments: fc.arguments ?? "" },
        });
        j++;
      }
      messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
      i = j - 1;
      continue;
    }

    if (item.type === "function_call_output") {
      const output = typeof (item as { output?: unknown }).output === "string"
        ? (item.output as string)
        : partsToString((item as { output?: unknown }).output);
      messages.push({
        role: "tool",
        content: output,
        tool_call_id: (item as { call_id?: string }).call_id ?? "",
      });
      continue;
    }

    // computer_call / computer_call_output / reasoning / local_shell_call /
    // additional_tools / otherKnown kinds: no chat-message equivalent.
    if (typeof item.type === "string" && item.type !== "message") {
      continue;
    }

    // message item
    const m = item as {
      role?: string;
      content: unknown;
    };
    const role = m.role === "developer" ? "system" : (m.role ?? "user");
    const content = partsToChatContent(m.content);

    if (role === "system") {
      // Hoist system/developer messages to the start — chat providers reject a
      // system message after a user turn. Codex often emits developer mid-convo.
      systemMessages.push({ role: "system", content });
      continue;
    }

    if (role === "assistant") {
      const searchNotes = pendingSearchNotes;
      pendingSearchNotes = [];
      const toolCalls: ToolCall[] = [];
      let j = i + 1;
      while (j < items.length && (items[j] as { type?: string }).type === "function_call") {
        const fc = items[j] as { call_id?: string; name?: string; arguments?: string; id?: string };
        toolCalls.push({
          id: fc.call_id ?? fc.id ?? `call_${newId("").slice(1)}`,
          type: "function",
          function: { name: fc.name ?? "tool", arguments: fc.arguments ?? "" },
        });
        j++;
      }
      const hasToolCalls = toolCalls.length > 0;
      const contentStr = typeof content === "string" ? content : "";
      if (hasToolCalls) {
        messages.push({
          role: "assistant",
          content: contentStr.length > 0 ? content : null,
          tool_calls: toolCalls,
        });
        i = j - 1;
        continue;
      }
      if (contentStr.length === 0) continue; // drop empty assistant turns
      messages.push({ role: "assistant", content: searchNotes.length > 0 ? mergeNotes(searchNotes, contentStr) : contentStr });
      continue;
    }

    messages.push({ role: role as ChatMessage["role"], content });
  }
  flushSearchNotes();

  return [...systemMessages, ...messages] as unknown as ChatMessage[];
}

function mergeNotes(notes: string[], text: string): string {
  return `${notes.join("\n")}\n\n${text}`;
}

// ─── Tools / tool_choice / sampling ────────────────────────────────────────//

export function toChatTools(tools?: ResponsesRequest["tools"]): Tool[] | undefined {
  if (!tools?.length) return undefined;
  // Forward only function tools — chat providers reject built-in tool types
  // (web_search, local_shell, computer, …).
  const fns = tools.filter(
    (t): t is typeof t & { name: string; function: { parameters?: unknown } } =>
      t.type === "function" && typeof t.name === "string",
  );
  if (!fns.length) return undefined;
  return fns.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description !== undefined && typeof t.description === "string"
        ? { description: t.description }
        : {}),
      parameters: ((t as { function?: { parameters?: unknown } }).function?.parameters ?? {}) as Record<string, unknown>,
    },
  }));
}

export function toChatToolChoice(tc?: ResponsesRequest["tool_choice"]): ChatCompletionRequest["tool_choice"] | undefined {
  if (!tc) return undefined;
  if (typeof tc === "string") return tc as ChatCompletionRequest["tool_choice"];
  if (tc.type === "function") return { type: "function", function: { name: tc.name } };
  return undefined;
}

// ─── Responses object builders ─────────────────────────────────────────────//

/**
 * Build the final non-streaming Responses object. Mirrors FreeLLMAPI's
 * buildResponseObject: a single `message` output item (text + per-call
 * function_call items), output_text shortcut, and a usage block that reports
 * reasoning tokens in output_tokens_details when the provider advertises them.
 */
function buildResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  metadata?: Record<string, string>;
}) {
  const output: unknown[] = [];
  if (opts.text.length > 0) {
    output.push({
      type: "message",
      id: newId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: "function_call",
      id: newId("fc"),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: "completed",
    });
  }

  return {
    id: opts.id,
    object: "response",
    created_at: nowUnix(),
    status: "completed",
    model: opts.model,
    output,
    output_text: opts.text,
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: opts.reasoningTokens ?? 0 },
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}

/**
 * Translate a Fusion result into the Responses object (non-streaming).
 * Chat Fusion uses additive _fusion / x_fusion fields that strict SDKs (Codex)
 * reject while decoding response.completed — preserve the portable routing
 * summary in the standard metadata map instead.
 */
function buildFusionResponseObject(
  id: string,
  fr: ChatCompletionResponse,
  srcMeta: {
    mode: string;
    panelSize?: number;
    judgeUsed?: boolean;
    strategy?: string;
    totalLatencyMs?: number;
    panel?: string;
  },
): Record<string, unknown> {
  const message = fr.choices?.[0]?.message;
  const usage = fr.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
  const text = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (message?.tool_calls ?? []) as ToolCall[];

  const metadata: Record<string, string> = {
    fusion: "true",
    fusion_mode: srcMeta.mode,
    fusion_strategy: srcMeta.strategy ?? "synthesize",
    fusion_panel_size: String(srcMeta.panelSize ?? fr.choices?.length ?? 1),
    fusion_judge_used: String(srcMeta.judgeUsed ?? false),
    fusion_total_latency_ms: String(srcMeta.totalLatencyMs ?? 0),
  };
  // Portable panel summary: which providers/models were tried and how long each took.
  if (srcMeta.panel) metadata.fusion_panel = srcMeta.panel;

  return buildResponseObject({
    id,
    model: FUSION_MODEL_ID,
    text,
    toolCalls,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    metadata,
  }) as unknown as Record<string, unknown>;
}

// ─── Shared streaming token math ───────────────────────────────────────────//

const TEXT_TOKENS_PER_CHAR = 0.25;
const IMAGE_TOKEN_ESTIMATE = 1000;

/**
 * Estimate total request tokens (input + images + output reserve). Feeds the
 * vision/tools/capability gates and logging. Mirrors the source's estimateInput
 * + image cost + routingReserveTokens combination.
 */
function estimateTotalTokens(request: ResponsesRequest, messages: ChatMessage[]): {
  input: number; images: number; total: number; reserve: number;
} {
  const input = estimateRequestTokens({ model: "", messages, tools: toChatTools(request.tools) } as ChatCompletionRequest);
  const images = messages.reduce(
    (n, m) =>
      n +
      (Array.isArray((m as { content?: unknown }).content)
        ? ((m.content) as unknown as Array<{ type?: string }>).filter(
            (b) => b?.type === "image_url" || b?.type === "image",
          ).length
        : 0),
    0,
  );
  const reserve = reserveForRequest(request);
  return { input, images, total: input + images * IMAGE_TOKEN_ESTIMATE + reserve, reserve };
}

/** Output budget reserve (mirrors routingReserveTokens on the chat surface). */
function reserveForRequest(req: ResponsesRequest): number {
  const maxOut = req.max_output_tokens ?? undefined;
  return Math.min(Math.ceil((maxOut ?? 1024) * 0.25), 2000);
}

/** chars → token estimate for completion fallback when the provider omits usage. */
function charsToTokens(len: number): number {
  return Math.ceil(len / (1 / TEXT_TOKENS_PER_CHAR));
}

// ─── Dispatch ──────────────────────────────────────────────────────────────//

/** Load keys from Postgres, falling back to the in-memory file DB. */
async function loadKeys(fallbackDb: { api_keys: Array<Record<string, unknown>> }): Promise<ApiKey[]> {
  try {
    const rows = await listApiKeys();
    if (rows.length) return rows as unknown as ApiKey[];
  } catch (e) {
    console.error("[responses] Postgres listApiKeys failed, using fallback keys:", e);
  }
  return fallbackDb.api_keys.map((k) => ({
    id: String(k.platform),
    db_id: Number(k.id) || 0,
    platform: k.platform as string,
    label: (k.label as string) || (k.platform as string),
    encrypted_key: k.encrypted_key as string,
    iv: k.iv as string,
    auth_tag: k.auth_tag as string,
    status: (k.status as ApiKey["status"]) || "healthy",
    enabled: k.enabled as boolean,
    base_url: (k.base_url as string) || "",
    monthly_request_cap: (k.monthly_request_cap as number) || 0,
    monthly_token_cap: (k.monthly_token_cap as number) || 0,
  }));
}

async function dispatchChat(body: ChatCompletionRequest, sessionId?: string): Promise<ProviderResult> {
  const parts = body.model.split("/");
  if (parts[0] === "auto" || parts[0] === "fusion") {
    // executeWithFallback handles routing + failover + sticky + budget internally.
    const ctx = { request: body, available_keys: [] as ApiKey[], session_id: sessionId };
    return executeWithFallback(body, ctx);
  }
  const platform = parts[0];
  const modelId = parts.length > 1 ? parts.slice(1).join("/") : body.model;
  const candidates = await listApiKeys();
  const candidate = candidates
    .filter((k) => k.enabled && k.status === "healthy" && k.platform === platform)
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""))[0];
  if (!candidate) return { error: `No healthy key for platform ${platform}`, status: 503 };
  const secret = await decryptKey(candidate.encrypted_key!, candidate.iv!, candidate.auth_tag!).catch(() => null);
  if (!secret) return { error: `Failed to decrypt key for ${platform}`, status: 500 };
  const apiKey: ApiKey = {
    id: String(candidate.db_id),
    platform,
    label: candidate.label ?? platform,
    encrypted_key: secret,
    iv: "",
    auth_tag: "",
    status: candidate.status as "healthy",
    enabled: candidate.enabled,
    base_url: candidate.base_url ?? "",
    monthly_request_cap: candidate.monthly_request_cap ?? 0,
    monthly_token_cap: candidate.monthly_token_cap ?? 0,
    db_id: candidate.db_id,
  };
  const adapter = getAdapterForPlatform(platform);
  if (!adapter) return { error: `Platform ${platform} not supported`, status: 503 };
  return executeChat({ ...body, model: modelId } as ChatCompletionRequest, apiKey);
}

// ─── Responses SSE streaming adapter ───────────────────────────────────────//
//
// OpenAI's Events API streams SSE events of the form
//   event: response.output_text.delta
//   data: {"type":"response.output_text.delta",...}
// and `data:` payloads include `type` + `sequence_number`. Codex's streaming
// consumer is strict about this. We translate OpenLLM's chat SSE chunks
// (AsyncIterable<ChatCompletionChunk>) into this event vocabulary.

interface StreamDeps {
  requestId: string;
  responseId: string;
  model: string;
}
interface ToolAccumulator {
  outputIndex: number;
  name: string;
  callId: string;
  args: string;
}

/**
 * State machine that emits the Responses-API SSE vocabulary from an
 * OpenAI-format chat chunk stream. Faithful to FreeLLMAPI's ResponsesSse:
 *   response.created → response.in_progress →
 *   [output_item.added (message) → content_part.added → output_text.delta* →
 *    output_text.done → content_part.done → output_item.done] +
 *   [output_item.added (function_call) → function_call_arguments.delta* →
 *    function_call_arguments.done → output_item.done] +
 *   response.completed
 *
 * Commit point: the response.created/in_progress skeleton is held until the
 * first MEANINGFUL chunk (text or tool-call) so a connect-time error fails
 * over / surfaces as a JSON error instead of a half-sent SSE stream.
 */
class ResponsesSSE {
  private seq = 0;
  private outputIndex = 0; // dense across all output items (text + tool calls)
  private committed = false;
  private msgItemId: string | null = null;
  private textOutputIndex = 0;
  private msgText = "";

  /** Expose accumulated text for the non-streaming path. */
  get messageText(): string {
    return this.msgText;
  }
  private toolAcc = new Map<number, ToolAccumulator>();

  constructor(private deps: StreamDeps) {}

  private frame(event: string, payload: Record<string, unknown>) {
    this.seq++;
    return `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: this.seq, ...payload })}\n\n`;
  }

  commit(model: string) {
    if (this.committed) return;
    const skeleton = {
      type: "response",
      id: this.deps.responseId,
      object: "response" as const,
      created_at: nowUnix(),
      status: "in_progress" as const,
      model,
      output: [],
      output_text: "",
    };
    this.committed = true;
    return [this.frame("response.created", { response: skeleton }), this.frame("response.in_progress", { response: skeleton })];
  }

  openTextItem(text?: string) {
    if (this.msgItemId === null) {
      this.msgItemId = newId("msg");
      this.textOutputIndex = this.outputIndex++;
      const out: string[] = [
        this.frame("response.output_item.added", {
          output_index: this.textOutputIndex,
          item: { id: this.msgItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
        }),
        this.frame("response.content_part.added", {
          item_id: this.msgItemId,
          output_index: this.textOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      ];
      if (text) {
        this.msgText += text;
        out.push(this.frame("response.output_text.delta", {
          item_id: this.msgItemId,
          output_index: this.textOutputIndex,
          content_index: 0,
          delta: text,
        }));
      }
      return out;
    }
    return [] as string[];
  }

  textDelta(text: string) {
    if (!text || this.msgItemId === null) return null;
    this.msgText += text;
    return this.frame("response.output_text.delta", {
      item_id: this.msgItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      delta: text,
    });
  }

  openToolCall(index: number, callId: string, name: string): string[] {
    const item = this.toolAcc.get(index);
    if (item) return []; // already opened (id/name may arrive later; keep first)
    const acc: ToolAccumulator = { outputIndex: this.outputIndex++, name, callId, args: "" };
    this.toolAcc.set(index, acc);
    return [
      this.frame("response.output_item.added", {
        output_index: acc.outputIndex,
        item: { id: callId, type: "function_call", status: "in_progress", call_id: callId, name, arguments: "" },
      }),
    ];
  }

  toolArgsDelta(index: number, args: string): string[] {
    const acc = this.toolAcc.get(index);
    if (!acc || !args) return [];
    acc.args += args;
    return [
      this.frame("response.function_call_arguments.delta", {
        item_id: acc.callId,
        output_index: acc.outputIndex,
        delta: args,
      }),
    ];
  }

  finalizeToolCalls(toolSchemas: Map<string, JsonSchemaish>): { output: unknown[]; text: string; done: string[] } {
    const toolOut: unknown[] = [];
    let done: string[] = [];
    for (const acc of this.toolAcc.values()) {
      const repaired = repairToolArguments(acc.args, toolSchemas.get(acc.name));
      done = [
        ...done,
        this.frame("response.function_call_arguments.done", {
          item_id: acc.callId,
          output_index: acc.outputIndex,
          arguments: repaired,
        }),
        this.frame("response.output_item.done", {
          output_index: acc.outputIndex,
          item: { id: acc.callId, type: "function_call", status: "completed", call_id: acc.callId, name: acc.name, arguments: repaired },
        }),
      ];
      toolOut.push({
        type: "function_call",
        id: newId("fc"),
        call_id: acc.callId,
        name: acc.name,
        arguments: repaired,
        status: "completed",
      });
    }
    return { output: toolOut, text: this.msgText, done };
  }

  finishTextItem(): string[] {
    if (this.msgItemId === null) return [];
    return [
      this.frame("response.output_text.done", {
        item_id: this.msgItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        text: this.msgText,
      }),
      this.frame("response.content_part.done", {
        item_id: this.msgItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.msgText, annotations: [] },
      }),
      this.frame("response.output_item.done", {
        output_index: this.textOutputIndex,
        item: { id: this.msgItemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: this.msgText, annotations: [] }] },
      }),
    ];
  }

  completed(obj: unknown): string {
    return this.frame("response.completed", { response: obj });
  }

  failed(message: string, type = "server_error", code?: string): string {
    return this.frame("response.failed", {
      response: {
        id: this.deps.responseId,
        object: "response",
        status: "failed",
        model: this.deps.model,
        error: { message, type, ...(code ? { code } : {}) },
      },
    });
  }

  get isCommitted(): boolean {
    return this.committed;
  }
}

/**
 * Translate an OpenAI-format chunk stream into Responses-API SSE frames.
 * Returns the full SSE body as a single string (the route streams it as one
 * Response) and a `preCommitError` if a failure occurred before the first
 * meaningful byte (so the route can fall back to a JSON error instead of a
 * broken SSE stream) — mirrors FreeLLMAPI's commit-point semantics.
 */
async function streamResponsesIterator(
  stream: AsyncIterable<ChatCompletionChunk>,
  deps: StreamDeps,
  toolSchemas: Map<string, JsonSchemaish>,
  opts: { abortSignal?: AbortSignal },
): Promise<{ body: string; preCommitError: string | null }> {
  const sse = new ResponsesSSE(deps);
  const out: string[] = [];
  let error: string | null = null;
  const push = (...frames: string[]) => { frames.forEach((f) => f && out.push(f)); };

  try {
    for await (const chunk of stream) {
      if (opts.abortSignal?.aborted) { error = "Client disconnected"; break; }
      const anyChunk = chunk as unknown as Record<string, unknown>;
      // In-band upstream error frame ({"error":...} inside a 200 SSE stream —
      // observed live from Groq). Surfaced as response.failed (post-commit)
      // or preCommitError (pre-commit → route emits JSON).
      if (anyChunk.error && !Array.isArray(anyChunk.error) && !(anyChunk as { choices?: unknown }).choices) {
        error = `in-band provider error: ${sanitizeProviderErrorMessage((anyChunk.error as { message?: unknown })?.message ?? "provider error")}`;
        break;
      }

      const choice0 = (chunk.choices?.[0] ?? {}) as { delta?: { content?: string | null; reasoning_content?: string; tool_calls?: unknown[] }; finish_reason?: string | null };
      if (choice0.finish_reason) break; // stop pumping

      const delta = choice0.delta ?? {};
      const text = delta.content ?? "";
      const reasoning = streamReasoningText(chunk);

      if (text || reasoning) {
        const commitFrames = sse.commit(deps.model);
        if (commitFrames) for (const f of commitFrames) push(f);
      }

      if (text) {
        push(sse.openTextItem().join("")); // ensure item opened (no-op after first)
        push(sse.textDelta(text) ?? "");
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls as Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>) {
          const idx = tc.index ?? 0;
          if (tc.id) {
            push(...sse.openToolCall(idx, tc.id, tc.function?.name ?? "tool"));
          }
          if (tc.function?.arguments) push(...sse.toolArgsDelta(idx, tc.function.arguments));
        }
      }
    }
  } catch (e) {
    if (isClientAbortError(e)) { error = "Client disconnected"; }
    else { error = sanitizeProviderErrorMessage(e instanceof Error ? e.message : String(e)); }
  }

  if (error !== null && !sse.isCommitted) {
    return { body: "", preCommitError: error };
  }

  // Commit if nothing meaningful arrived yet (empty completion edge).
  if (!sse.isCommitted) {
    const cf = sse.commit(deps.model);
    if (cf) for (const f of cf) push(f);
  }

  // Close text item + tool calls.
  for (const f of sse.finishTextItem()) push(f);
  const { output, done } = sse.finalizeToolCalls(toolSchemas);
  for (const f of done) push(f);

  const completedObj = buildResponseObject({
    id: deps.responseId,
    model: deps.model,
    text: sse.messageText,
    toolCalls: output as ToolCall[],
    promptTokens: 0,
    completionTokens: charsToTokens(sse.messageText.length),
    reasoningTokens: undefined,
  });
  push(sse.completed(completedObj));

  return { body: out.join(""), preCommitError: error };
}

// ─── Hono route handlers ───────────────────────────────────────────────────//

async function dispatchFusion(body: ChatCompletionRequest, cfg: Partial<FusionConfig> = {}): Promise<ProviderResult> {
  const ctx = { request: body, available_keys: [] as ApiKey[], session_id: body.user };
  const decision = await smartRouter.route(ctx);
  // Re-inject the routed primary ahead of the chain (fusion wants the best
  // candidate too), mirroring routes/chat.ts.
  decision.fallback_chain = [
    {
      provider: (decision as unknown as { provider: { id: string } }).provider.id,
      model: (decision as unknown as { model: string }).model,
      key_id: (decision as unknown as { key: { id: string } }).key.id,
      priority: 0,
      reason: "fusion-primary",
      score: ((decision as unknown as { metadata?: { score?: number } }).metadata?.score) ?? undefined,
    } as unknown as typeof decision.fallback_chain[number],
    ...decision.fallback_chain,
  ];
  const storedCfg = (await getSetting<Record<string, unknown>>("fusion_config")) ?? {};
  const fr = await runFusion(body, { ...storedCfg, ...cfg } as Partial<FusionConfig>, decision);
  return { response: fr.response as unknown as ChatCompletionResponse, provider_metadata: { _fusion: { ...fr.metadata, panel: fr.panelResponses.map((p) => ({ provider: p.member.provider, model: p.member.model, latency_ms: p.latencyMs, error: p.error ?? null })), } } };
}

responsesRouter.post("/responses", async (c) => {
  const vStart = Date.now();
  const db = { api_keys: [{ platform: "openai", label: "primary" }] }; // routes receive unified gateway key
  const raw = await c.req.json().catch(() => null);
  const parsed = validateRequest(raw);
  if (!parsed.ok) {
    return c.json({ error: { type: "invalid_request_error", message: `Invalid request: ${parsed.errors.join(", ")}` } }, 400);
  }
  const reqData = parsed.data;

  // ── Hard pre-check rejections (mirrored from FreeLLMAPI) ──────────────
  if (responsesInputRequestsComputerUse(reqData)) {
    return c.json({
      error: { type: "invalid_request_error", code: "no_computer_use_model", message:
        "Computer use is not yet supported on /v1/responses (the computer / computer_use_preview tool and computer_call items have no chat-completions equivalent)." },
    }, 422);
  }
  if (responsesInputHasFileIdImage(reqData)) {
    return c.json({
      error: { type: "invalid_request_error", code: "unsupported_image_input", message:
        "This request contains an image part that can't be resolved: input_image needs an image_url (an https URL or base64 data URL); Files API file_id references aren't supported." },
    }, 422);
  }

  const messages = toChatMessages(reqData);
  const tools = toChatTools(reqData.tools);
  const toolSchemas = toolSchemaMap(tools);
  const toolChoice = tools?.length ? toChatToolChoice(reqData.tool_choice) : undefined;
  const responseFormat = (() => {
    if (!tools && reqData.text?.format && reqData.text.format.type !== "text") {
      return reqData.text.format.type === "json_schema"
        ? { type: "json_schema" as const, json_schema: { name: reqData.text!.format!.name, strict: reqData.text!.format!.strict, schema: reqData.text!.format!.schema } }
        : { type: "json_object" as const };
    }
    return undefined;
  })();

  // ── Pre-flight gates (vision / tools) ──────────────────────────────────
  const chatReq: ChatCompletionRequest = {
    model: reqData.model ?? "auto",
    messages,
    max_tokens: reqData.max_output_tokens ?? undefined,
    temperature: reqData.temperature ?? undefined,
    top_p: reqData.top_p ?? undefined,
    stream: reqData.stream ?? false,
    tools,
    tool_choice: toolChoice,
    response_format: responseFormat ?? undefined,
    user: reqData.user,
  };
  const pf = runPreflight(chatReq);
  if (pf.hasImage) {
    const ok = await hasEnabledVisionModel();
    if (!ok) {
      return c.json({ error: { type: "invalid_request_error", code: "no_vision_model", message:
        "This request includes an image, but no vision-capable model is enabled." } }, 422);
    }
  }
  const wantsTools = tools?.length ? true : pf.wantsTools;
  if (wantsTools) {
    const ok = await hasEnabledToolsModel();
    if (!ok) {
      return c.json({ error: { type: "invalid_request_error", code: "no_tools_model", message:
        "This request includes tools, but no tool-capable model is enabled." } }, 422);
    }
  }

  // ── Explicit-model resolution & validation ─────────────────────────────
  const requestedModelLabel = reqData.model ?? "auto";
  let resolvedChatModel = chatReq.model;
  if (!isAutoModel(requestedModelLabel) && !isFusionModel(requestedModelLabel)) {
    // Source pins an exact catalog model; 400 if it isn't enabled. Best-effort:
    // if the catalog DB is unreachable, fall through to dispatch (so local
    // tests without DATABASE_URL aren't harder than they already are).
    const parts = requestedModelLabel.split("/");
    const bareModelId = parts.length > 1 ? parts.slice(1).join("/") : requestedModelLabel;
    try {
      const catalog = await listCatalogModels();
      const match = catalog.find((m) => m.platform === parts[0] && m.modelId === bareModelId)
        ?? catalog.find((m) => m.modelId === bareModelId);
      if (!match) {
        const label = catalog.length ? "is not in the catalog" : "is not in the catalog (local, DB empty)";
        return c.json({ error: { type: "invalid_request_error", code: "model_not_found", message:
          `Model '${requestedModelLabel}' ${label}. Use 'auto' to auto-route, or GET /v1/models for the available list.` } }, 400);
      }
    } catch { /* catalog unavailable — attempt dispatch */ }
  } else if (isFusionModel(requestedModelLabel)) {
    resolvedChatModel = "fusion";
    chatReq.model = "fusion";
  } else {
    resolvedChatModel = "auto";
    chatReq.model = "auto";
  }

  const responseId = newId("resp");
  const sessionId = c.req.header("x-session-id") ?? c.req.header("session-id") ?? c.req.header("x-codex-session-id");
  const stream = !!reqData.stream;

  c.header("X-Request-ID", generateRequestId());
  traceRouteEvent("Responses", {
    event: "start", requestId: responseId, attempt: 0, platform: "auto", model: requestedModelLabel, requestedModel: requestedModelLabel,
  });

  try {
    // ── Fusion path ────────────────────────────────────────────────────
    if (isFusionModel(requestedModelLabel)) {
      const fr = await dispatchFusion(chatReq, reqData.fusion);
      // dispatchFusion already builds provider_metadata._fusion with the panel
      // summary + metadata from services/fusion.ts (mode, strategy, panelSize,
      // judgeUsed, totalLatencyMs, panel).
      const fmeta = (fr.provider_metadata?._fusion ?? {}) as {
        mode?: string;
        panel?: string;
        judge?: string;
        synthesized?: boolean;
        strategy?: string;
        panelSize?: number;
        judgeUsed?: boolean;
        totalLatencyMs?: number;
      };
      const finalResponse = buildFusionResponseObject(responseId, fr.response!, {
        mode: fmeta.mode ?? "synthesize",
        strategy: fmeta.strategy,
        panelSize: fmeta.panelSize,
        judgeUsed: fmeta.judgeUsed,
        totalLatencyMs: fmeta.totalLatencyMs,
        panel: fmeta.panel,
      });
      // Structured output enforcement on fusion (parity with chat surface).
      if (responseFormat && finalResponse.output_text && typeof finalResponse.output_text === "string") {
        if (responseFormat.type === "json_object" || responseFormat.type === "json_schema") {
          const enforced = enforceJsonContent(finalResponse.output_text);
          if (!enforced.ok) {
            return c.json({ error: { type: "invalid_request_error", code: "response_format_failed", message:
              `Fusion did not produce valid JSON despite response_format=${responseFormat.type}. Retry with a larger model or relax response_format.` } }, 422);
          }
          finalResponse.output_text = enforced.content;
          // rebuild the message output_text block
          const outArr = finalResponse.output as Array<{ content?: Array<{ type: string; text: string; annotations?: unknown[] }> }>;
          const first = outArr?.[0];
          if (first) first.content = [{ type: "output_text", text: enforced.content, annotations: [] }];
        }
      }
      await requestLogger.logComplete(responseId, "fusion", "fusion", 0, undefined, chatReq, fr.response ?? null, Date.now() - vStart, 200, undefined, true, (finalResponse.output as unknown[] | undefined)?.length, true, undefined);
      return c.json(finalResponse);
    }

    // ── Auto / explicit dispatch ───────────────────────────────────────
    const result = await dispatchChat(chatReq, sessionId);
    if (result.error) {
      const status = result.status ?? 502;
      traceRouteEvent("Responses", { event: "fail", requestId: responseId, attempt: 0, platform: "auto", model: requestedModelLabel, latencyMs: Date.now() - vStart, error: result.error });
      let body: Record<string, unknown> = { error: { type: status >= 500 ? "server_error" : "invalid_request_error", message: result.error } };
      const exhausted = result.provider_metadata?.exhausted_chain;
      if (exhausted) {
        body = summarizeExhaustion(result) ?? body;
      }
      await requestLogger.logComplete(responseId, requestedModelLabel, requestedModelLabel, 0, undefined, chatReq, result.response ?? null, Date.now() - vStart, status, result.error);
      return c.json(body, status as 400 | 401 | 404 | 429 | 451 | 502 | 503);
    }

    if (stream && result.stream) {
      // Streaming: emit Responses-API SSE with a commit point held until the
      // first meaningful chunk. executeWithFallback already picked the provider;
      // a pre-commit error (before any content) surfaces as a JSON error so the
      // client never sees a half-sent SSE skeleton.
      const deps: StreamDeps = { requestId: responseId, responseId, model: result.response?.model ?? chatReq.model };
      const { body: sseBody, preCommitError } = await streamResponsesIterator(
        result.stream as AsyncIterable<ChatCompletionChunk>,
        deps,
        toolSchemas,
        { abortSignal: c.req.raw?.signal },
      );
      if (preCommitError !== null) {
        traceRouteEvent("Responses", { event: "fail", requestId: responseId, attempt: 0, platform: "auto", model: requestedModelLabel, latencyMs: Date.now() - vStart, error: preCommitError });
        await requestLogger.logComplete(responseId, requestedModelLabel, requestedModelLabel, 0, undefined, chatReq, null, Date.now() - vStart, 502, preCommitError);
        return c.json({ error: { type: "server_error", message: preCommitError } }, 502);
      }
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
    }

    // ── Non-streaming ─────────────────────────────────────────────────
    if (!result.response) throw new Error(`upstream returned no response body for ${chatReq.model}`);
    const choice = result.response.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error(`upstream returned no message for ${chatReq.model}`);

    let text = typeof message.content === "string" ? message.content : "";
    if (!text && message.reasoning_content) {
      text = message.reasoning_content;
    }
    let toolCalls = (message.tool_calls ?? []) as ToolCall[];

    // Repair tool arguments schema-awarely.
    if (toolCalls.length) {
      toolCalls = toolCalls.map((tc) => ({ ...tc, function: { ...tc.function, arguments: repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name)) } }));
    }

    // Structured-output enforcement (non-stream). On failure we can't fail over
    // (executeWithFallback exhausted its chain) — surface 422, matching the
    // source's skipBench intent (a model that ignored the format isn't healthy
    // for this request, but we can't retry another model here).
    if (responseFormat && text && toolCalls.length === 0) {
      const enforced = enforceJsonContent(text);
      if (!enforced.ok) {
        const isTrunc = choice?.finish_reason === "length";
        return c.json({ error: { type: "invalid_request_error", code: "response_format_failed", message:
          isTrunc ? `Truncated JSON (${responseFormat.type}) — raise max_tokens.` : `${result.response.model ?? "model"} ignored the ${responseFormat.type} format.` } }, 422);
      }
      text = enforced.content;
    }

    const empty = !text && toolCalls.length === 0;
    const promptTokens = result.response.usage?.prompt_tokens ?? estimateRequestTokens(chatReq) ?? pf.estimatedInputTokens;
    const reasoningTextLen = completionReasoningText(result.response).length;
    const completionTokens = result.response.usage?.completion_tokens ?? charsToTokens(text.length + reasoningTextLen);
    const reasonTokens = (result.response.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)?.completion_tokens_details?.reasoning_tokens
      ?? Math.ceil(reasoningTextLen * TEXT_TOKENS_PER_CHAR);

    if (empty) {
      return c.json({ error: { type: "server_error", message: `Empty completion from upstream (${result.response.model ?? chatReq.model})` } }, 502);
    }

    const routedVia = (result.response as unknown as Record<string, unknown> | null)?._routed_via as { platform?: string; model?: string; reason?: string } | undefined;
    const reason = routedVia?.reason?.match(/strategy=(\w+)/);
    const response = buildResponseObject({
      id: responseId, model: result.response?.model ?? chatReq.model, text, toolCalls,
      promptTokens, completionTokens, reasoningTokens: reasonTokens,
      metadata: routedVia?.platform ? { routed_via: `${routedVia.platform}/${routedVia.model ?? ""}` } : undefined,
    });

    c.header("X-Routed-Via", routedVia ? `${routedVia.platform}/${routedVia.model ?? "auto"}` : "auto");
    traceRouteEvent("Responses", { event: "ok", requestId: responseId, attempt: 1, platform: routedVia?.platform ?? "auto", model: (routedVia?.model ?? chatReq.model), latencyMs: Date.now() - vStart });
    await requestLogger.logComplete(responseId, routedVia?.platform ?? "auto", routedVia?.model ?? chatReq.model, 0, undefined, chatReq, result.response ?? null, Date.now() - vStart, 200, undefined, false, toolCalls.length, undefined, reason ? reason[1] : undefined);
    return c.json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    traceRouteEvent("Responses", { event: "fail", requestId: responseId, attempt: 0, platform: "auto", model: requestedModelLabel, latencyMs: Date.now() - vStart, error: msg });
    await requestLogger.logComplete(responseId, requestedModelLabel, requestedModelLabel, 0, undefined, chatReq, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "api_error", message: msg } }, 503);
  }
});

export default responsesRouter;
