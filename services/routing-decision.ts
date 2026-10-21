/**
 * Routing Decision Service — External LLM selects routing strategy per request.
 *
 * When routing strategy is 'decision', this module calls a decision model to
 * pick the best preset (balanced | smartest | fastest | reliable) based on
 * the request content. Results are cached for 30 minutes.
 *
 * Uses existing free model (e.g., mimo-v2.6-flash-free) to minimize cost.
 */

import { getSetting, saveSetting } from "../db/pg.ts";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderResult, ApiKey } from "../providers/types.ts";
import { providerRegistry, getAdapterForPlatform } from "../providers/index.ts";
// NOTE: decryptSecret lives in router.ts, but importing it creates a circular
// dependency (router → routing-decision → router). Inline the same AES-GCM
// decrypt path here to keep the module boundary acyclic.
async function decryptSecret(k: {
  encrypted_key?: string | null;
  iv?: string | null;
  auth_tag?: string | null;
}): Promise<string> {
  if (!k.encrypted_key) return "";
  if (!k.iv || !k.auth_tag) return k.encrypted_key; // already-plaintext rows pass through
  try {
    const { decryptKey } = await import("../db/mod.ts");
    return (await decryptKey(k.encrypted_key, k.iv, k.auth_tag)) || "";
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings keys
// ─────────────────────────────────────────────────────────────────────────────

export const SETTING_DECISION_MODEL = "routing_decision_model";        // e.g. "mimo-v2.6-flash-free"
export const SETTING_DECISION_PROVIDER = "routing_decision_provider";  // e.g. "opencode"
export const SETTING_DECISION_CACHE_TTL_MS = "routing_decision_cache_ttl_ms"; // default 30 min
export const SETTING_DECISION_ENABLED = "routing_decision_enabled";    // boolean, default false

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PresetStrategy = "balanced" | "smartest" | "fastest" | "reliable";

export interface DecisionCacheEntry {
  strategy: PresetStrategy;
  reasoning: string;
  cachedAt: number;
}

export interface DecisionContext {
  // Request characteristics
  messageCount: number;
  lastUserMessage: string;
  hasTools: boolean;
  hasVision: boolean;
  hasReasoning: boolean;
  estimatedTokens: number;
  // System state
  availablePresets: PresetStrategy[];
  currentStrategy: PresetStrategy;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache (TTL-based)
// ─────────────────────────────────────────────────────────────────────────────

const DECISION_CACHE = new Map<string, DecisionCacheEntry>();

/** Generate cache key from request characteristics */
function getCacheKey(ctx: DecisionContext): string {
  // Key factors: presence of tools, vision, reasoning, message length bucket, last message hash
  const toolFlag = ctx.hasTools ? "T" : "";
  const visionFlag = ctx.hasVision ? "V" : "";
  const reasoningFlag = ctx.hasReasoning ? "R" : "";
  const lengthBucket = Math.min(10, Math.floor(ctx.estimatedTokens / 1000));
  const lastMsgHash = hashString(ctx.lastUserMessage.slice(0, 200));
  return `${toolFlag}${visionFlag}${reasoningFlag}-${lengthBucket}-${lastMsgHash}`;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** Check if cached decision is still valid */
function getCachedDecision(key: string, ttlMs: number): DecisionCacheEntry | null {
  const entry = DECISION_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ttlMs) {
    DECISION_CACHE.delete(key);
    return null;
  }
  return entry;
}

/** Store decision in cache */
function setCachedDecision(key: string, strategy: PresetStrategy, reasoning: string): void {
  DECISION_CACHE.set(key, { strategy, reasoning, cachedAt: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision Model Configuration
// ─────────────────────────────────────────────────────────────────────────────

async function getDecisionModelConfig(): Promise<{
  provider: string;
  model: string;
  enabled: boolean;
  cacheTtlMs: number;
} | null> {
  const [provider, model, enabled, cacheTtlMs] = await Promise.all([
    getSetting<string>(SETTING_DECISION_PROVIDER),
    getSetting<string>(SETTING_DECISION_MODEL),
    getSetting<boolean>(SETTING_DECISION_ENABLED),
    getSetting<number>(SETTING_DECISION_CACHE_TTL_MS),
  ]);

  if (!provider || !model || !enabled) return null;

  return {
    provider,
    model,
    enabled: true,
    cacheTtlMs: cacheTtlMs ?? 30 * 60 * 1000, // 30 minutes default
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Decision Prompt
// ─────────────────────────────────────────────────────────────────────────────

const PRESET_DESCRIPTIONS: Record<PresetStrategy, string> = {
  balanced: "平衡模式：可靠性 50%、速度 25%、智力 25% — 适合大多数通用对话任务",
  smartest: "最智能模式：可靠性 35%、速度 10%、智力 55% — 适合复杂推理、代码生成、深度分析",
  fastest: "最快模式：可靠性 35%、速度 55%、智力 10% — 适合简单问答、高频交互、延迟敏感场景",
  reliable: "最稳健模式：可靠性 70%、速度 15%、智力 15% — 适合生产关键任务、低容错场景",
};

function buildDecisionPrompt(ctx: DecisionContext): string {
  const presetList = ctx.availablePresets.map((p) => `- ${p}: ${PRESET_DESCRIPTIONS[p]}`).join("\n");

  return `你是一个路由策略选择器。根据用户请求特征，从以下 4 个预设策略中选择最合适的一个。

可用策略：
${presetList}

当前默认策略：${ctx.currentStrategy}

请求特征：
- 消息轮数：${ctx.messageCount}
- 最后用户消息：${ctx.lastUserMessage.slice(0, 300)}
- 包含工具调用：${ctx.hasTools ? "是" : "否"}
- 包含图片/视觉：${ctx.hasVision ? "是" : "否"}
- 要求推理过程：${ctx.hasReasoning ? "是" : "否"}
- 预估 token 数：~${ctx.estimatedTokens}

选择原则：
- 代码/复杂推理/多步任务 → smartest
- 简单问答/闲聊/高频 → fastest
- 生产关键/低容错/长上下文 → reliable
- 不确定/通用对话 → balanced

只输出 JSON，格式：
{"strategy": "smartest|fastest|balanced|reliable", "reasoning": "简短理由（≤50字）"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Decision Model
// ─────────────────────────────────────────────────────────────────────────────

async function callDecisionModel(
  providerId: string,
  modelId: string,
  prompt: string,
): Promise<{ strategy: PresetStrategy; reasoning: string } | null> {
  try {
    // Get the provider adapter
    const adapter = providerRegistry.get(providerId);
    if (!adapter) {
      console.warn(`[routing-decision] Provider ${providerId} not found in registry`);
      return null;
    }

    // Get a healthy key for this provider
    // For decision model, we use the provider's configured free model key
    // We'll fetch keys from DB and use the first healthy one
    const { query, initDb } = await import("../db/pg.ts");
    await initDb();
    const keys = await query`
      SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url,
             monthly_request_cap, monthly_token_cap
      FROM api_keys
      WHERE platform = ${providerId} AND enabled = true AND status = 'healthy'
      LIMIT 1
    `;

    if (!keys.length) {
      console.warn(`[routing-decision] No healthy keys for provider ${providerId}`);
      return null;
    }

    const keyRow = keys[0];
    const decrypted = await decryptSecret(keyRow);
    if (!decrypted) {
      console.warn(`[routing-decision] Failed to decrypt key for ${providerId}`);
      return null;
    }

    const apiKey: ApiKey = {
      id: String(keyRow.id),
      db_id: Number(keyRow.id),
      platform: keyRow.platform,
      label: keyRow.label,
      encrypted_key: decrypted,
      iv: "",
      auth_tag: "",
      status: keyRow.status,
      enabled: keyRow.enabled,
      base_url: keyRow.base_url,
      monthly_request_cap: keyRow.monthly_request_cap ?? 0,
      monthly_token_cap: keyRow.monthly_token_cap ?? 0,
    };

    // Build request
    const request: ChatCompletionRequest = {
      model: modelId,
      messages: [
        { role: "system", content: "You are a routing strategy selector. Output only JSON, no markdown, no commentary." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 100,
      // NOTE: We intentionally do NOT set response_format: json_object — some
      // providers (groq) fail their strict JSON mode. The prompt forces JSON
      // output and parseDecisionContent() extracts the JSON via regex fallback.
    };

    // Call the model
    const result: ProviderResult = await adapter.chat(request, apiKey, {
      timeout_ms: 10_000, // 10 second timeout for decision call
    });

    if (result.error || !result.response) {
      console.warn(`[routing-decision] Decision model ${providerId}/${modelId} error: ${result.error} status=${result.status}`);
      return null;
    }

    const content = result.response.choices[0]?.message?.content?.trim()
      || (result.response.choices[0]?.message as { reasoning_content?: string } | undefined)?.reasoning_content?.trim()
      || "";
    if (!content) {
      console.warn("[routing-decision] Empty response from decision model");
      return null;
    }

    // Parse JSON response
    let parsed: { strategy?: string; reasoning?: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try to extract JSON from markdown code block
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          console.warn("[routing-decision] Failed to parse decision JSON:", content);
          return null;
        }
      } else {
        console.warn("[routing-decision] No JSON in response:", content);
        return null;
      }
    }

    // Validate strategy
    const strategy = parsed.strategy as PresetStrategy | undefined;
    if (!strategy || !["balanced", "smartest", "fastest", "reliable"].includes(strategy)) {
      console.warn(`[routing-decision] Invalid strategy: ${strategy}`);
      return null;
    }

    return {
      strategy,
      reasoning: parsed.reasoning ?? "Decision model selection",
    };
  } catch (e) {
    console.error("[routing-decision] Decision model call failed:", e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract Request Context
// ─────────────────────────────────────────────────────────────────────────────

function extractDecisionContext(request: ChatCompletionRequest): DecisionContext {
  const messages = request.messages ?? [];
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const hasTools = !!(request.tools && request.tools.length > 0);
  const hasVision = messages.some((m) =>
    typeof m.content === "string" ? false : (m.content as any[]).some((c: any) => c.type === "image_url")
  );
  const hasReasoning = request.reasoning_effort !== undefined;
  const estimatedTokens = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) / 3; // rough char->token

  return {
    messageCount: messages.length,
    lastUserMessage: lastUserMsg,
    hasTools,
    hasVision,
    hasReasoning,
    estimatedTokens: Math.max(1, Math.round(estimatedTokens)),
    availablePresets: ["balanced", "smartest", "fastest", "reliable"],
    currentStrategy: "balanced", // will be overridden by router
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the routing strategy for a request.
 * If strategy is 'decision', calls the decision model to select a preset.
 * Otherwise returns the configured strategy directly.
 */
export async function getRoutingStrategyForRequest(
  request: ChatCompletionRequest,
  currentStrategy: string,
): Promise<{ strategy: PresetStrategy; source: "config" | "decision" | "fallback"; reasoning?: string }> {
  // If not 'decision' strategy, return as-is
  if (currentStrategy !== "decision") {
    const validPresets: PresetStrategy[] = ["balanced", "smartest", "fastest", "reliable"];
    if (validPresets.includes(currentStrategy as PresetStrategy)) {
      return { strategy: currentStrategy as PresetStrategy, source: "config" };
    }
    // Invalid strategy, fall back to balanced
    return { strategy: "balanced", source: "fallback", reasoning: `Invalid strategy '${currentStrategy}', using balanced` };
  }

  // Get decision model config
  const config = await getDecisionModelConfig();
  if (!config) {
    console.warn("[routing-decision] Decision model not configured, falling back to balanced");
    return { strategy: "balanced", source: "fallback", reasoning: "Decision model not configured" };
  }

  // Extract context from request
  const ctx = extractDecisionContext(request);
  ctx.currentStrategy = "balanced"; // default for prompt

  // Check cache
  const cacheKey = getCacheKey(ctx);
  const cached = getCachedDecision(cacheKey, config.cacheTtlMs);
  if (cached) {
    return { strategy: cached.strategy, source: "decision", reasoning: cached.reasoning + " (cached)" };
  }

  // Build prompt and call decision model
  const prompt = buildDecisionPrompt(ctx);
  const decision = await callDecisionModel(config.provider, config.model, prompt);

  if (decision) {
    setCachedDecision(cacheKey, decision.strategy, decision.reasoning);
    return { strategy: decision.strategy, source: "decision", reasoning: decision.reasoning };
  }

  // Fallback on any error
  console.warn("[routing-decision] Decision model failed, using balanced");
  return { strategy: "balanced", source: "fallback", reasoning: "Decision model call failed" };
}

/**
 * Clear the decision cache (useful for testing or config changes)
 */
export function clearDecisionCache(): void {
  DECISION_CACHE.clear();
}

/**
 * Get cache stats for debugging
 */
export function getDecisionCacheStats(): { size: number; entries: Array<{ key: string; strategy: PresetStrategy; ageMs: number }> } {
  const now = Date.now();
  return {
    size: DECISION_CACHE.size,
    entries: [...DECISION_CACHE.entries()].map(([key, entry]) => ({
      key,
      strategy: entry.strategy,
      ageMs: now - entry.cachedAt,
    })),
  };
}

/**
 * Initialize default decision settings if not present.
 * Default: disabled, using groq/openai/gpt-oss-20b (free tier, JSON-friendly, no client restriction).
 */
export async function initDecisionSettings(): Promise<void> {
  const existing = await getSetting<boolean>(SETTING_DECISION_ENABLED);
  if (existing === null) {
    // Default to disabled, using groq openai/gpt-oss-20b (free, works via API)
    await Promise.all([
      saveSetting(SETTING_DECISION_ENABLED, false),
      saveSetting(SETTING_DECISION_PROVIDER, "groq"),
      saveSetting(SETTING_DECISION_MODEL, "openai/gpt-oss-20b"),
      saveSetting(SETTING_DECISION_CACHE_TTL_MS, 30 * 60 * 1000),
    ]);
    console.log("[routing-decision] Initialized default settings (disabled, groq/openai/gpt-oss-20b)");
  }
}