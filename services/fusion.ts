/**
 * Fusion Service — Multi-model fusion with Panel voting + Judge synthesis.
 * Phase A Week 4: Core fusion engine.
 * P-CORE-003: Fusion 多模型融合必须实现 Panel 投票 + Judge 合成 + tool_choice 三档处理
 */

import { getAdapterForPlatform, executeChat } from "../providers/index.ts";
import { listApiKeys } from "../db/pg.ts";
import type { ChatCompletionRequest, ChatCompletionResponse, ApiKey, ProviderResult, FallbackEntry, RoutingDecision } from "../providers/types.ts";

/** Fusion configuration */
export interface FusionConfig {
  /** Fusion mode: 'auto' | 'synthesize' | 'best_of' */
  mode: "auto" | "synthesize" | "best_of";
  /** Panel size (default 4) */
  k: number;
  /** Judge model ID for synthesis */
  judge: string;
  /** Strategy: 'synthesize' (Judge rewrites) | 'best_of' (pick longest) */
  strategy: "synthesize" | "best_of";
  /** Panel selection strategy: 'diversity' | 'speed' | 'quality' */
  panelSelection: "diversity" | "speed" | "quality";
  /** Timeout for panel responses (ms) */
  panelTimeoutMs?: number;
  /** Whether to enable short-circuit on first success (for speed mode) */
  shortCircuit?: boolean;
}

/** Panel member - a provider/model/key combination from fallback chain */
export interface PanelMember {
  provider: string;
  model: string;
  key: ApiKey;
  score: number;
  fallbackEntry: FallbackEntry;
}

/** Panel response with metadata */
export interface PanelResponse {
  member: PanelMember;
  response?: ChatCompletionResponse;
  error?: string;
  latencyMs: number;
  toolCalls?: any[];
}

/** Fusion result */
export interface FusionResult {
  response: ChatCompletionResponse;
  panelResponses: PanelResponse[];
  metadata: {
    mode: string;
    panelSize: number;
    judgeUsed: boolean;
    strategy: string;
    totalLatencyMs: number;
  };
}

/** Default fusion configuration */
export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  mode: "auto",
  k: 4,
  judge: "openrouter/anthropic/claude-3.5-sonnet",
  strategy: "synthesize",
  panelSelection: "diversity",
  panelTimeoutMs: 30000,
  shortCircuit: false,
};

/** Key cache for panel member resolution */
const keyCache = new Map<string, ApiKey>();

/** Get API key by ID (from database or cache) */
async function getKeyById(keyId: string): Promise<ApiKey | null> {
  if (keyCache.has(keyId)) {
    return keyCache.get(keyId)!;
  }
  try {
    const keys = await listApiKeys();
    const key = keys.find(k => String(k.db_id ?? k.id) === keyId || k.platform === keyId);
    if (key) {
      const apiKey: ApiKey = {
        id: key.id,
        db_id: key.db_id,
        platform: key.platform,
        label: key.label ?? key.platform,
        encrypted_key: key.encrypted_key ?? "",
        iv: key.iv ?? "",
        auth_tag: key.auth_tag ?? "",
        status: key.status as "healthy" | "error" | "rate_limited" | "invalid",
        enabled: key.enabled,
        base_url: key.base_url ?? "",
        monthly_request_cap: 0,
        monthly_token_cap: 0,
      };
      keyCache.set(keyId, apiKey);
      return apiKey;
    }
  } catch (e) {
    console.error("[fusion] Failed to fetch key:", e);
  }
  return null;
}

/**
 * Select panel members from fallback chain based on strategy.
 * Returns up to k members with diversity across providers and model families.
 */
export function selectPanel(
  fallbackChain: FallbackEntry[],
  k: number = 4,
  strategy: "diversity" | "speed" | "quality" = "diversity"
): PanelMember[] {
  if (fallbackChain.length === 0) return [];

  const candidates = fallbackChain.map((entry, idx) => ({
    ...entry,
    originalIndex: idx,
  }));

  switch (strategy) {
    case "diversity":
      return selectDiversePanel(candidates, k);
    case "speed":
      return selectSpeedPanel(candidates, k);
    case "quality":
      return selectQualityPanel(candidates, k);
    default:
      return selectDiversePanel(candidates, k);
  }
}

/**
 * Diversity selection: maximize provider + model family spread.
 * First pass: pick one per provider.
 * Second pass: fill remaining with different model families.
 */
function selectDiversePanel(
  candidates: Array<FallbackEntry & { originalIndex: number }>,
  k: number
): PanelMember[] {
  const selected: PanelMember[] = [];
  const usedProviders = new Set<string>();
  const usedFamilies = new Set<string>();

  // First pass: one per provider (highest scored)
  for (const c of candidates) {
    if (selected.length >= k) break;
    if (!usedProviders.has(c.provider)) {
      selected.push(toPanelMember(c));
      usedProviders.add(c.provider);
      usedFamilies.add(extractModelFamily(c.model));
    }
  }

  // Second pass: fill with different families
  for (const c of candidates) {
    if (selected.length >= k) break;
    const family = extractModelFamily(c.model);
    if (!usedFamilies.has(family)) {
      selected.push(toPanelMember(c));
      usedFamilies.add(family);
    }
  }

  // Third pass: fill remaining by score order
  for (const c of candidates) {
    if (selected.length >= k) break;
    if (!selected.some(s => s.provider === c.provider && s.model === c.model)) {
      selected.push(toPanelMember(c));
    }
  }

  return selected.slice(0, k);
}

/**
 * Speed selection: pick top-k by score (assumes fallback chain is pre-sorted by speed).
 */
function selectSpeedPanel(
  candidates: Array<FallbackEntry & { originalIndex: number }>,
  k: number
): PanelMember[] {
  return candidates.slice(0, k).map(toPanelMember);
}

/**
 * Quality selection: pick top-k by score (assumes fallback chain is pre-sorted by quality).
 */
function selectQualityPanel(
  candidates: Array<FallbackEntry & { originalIndex: number }>,
  k: number
): PanelMember[] {
  return candidates.slice(0, k).map(toPanelMember);
}

/** Convert fallback entry to panel member (key will be resolved at call time) */
function toPanelMember(entry: FallbackEntry & { originalIndex: number }): PanelMember {
  return {
    provider: entry.provider,
    model: entry.model,
    key: { 
      id: entry.key_id, 
      platform: entry.provider, 
      label: "", 
      encrypted_key: "", 
      iv: "", 
      auth_tag: "", 
      status: "healthy", 
      enabled: true, 
      base_url: "",
      monthly_request_cap: 0,
      monthly_token_cap: 0,
    } as ApiKey, // Placeholder - will be resolved in fanOutPanel
    score: entry.metadata?.score as number ?? 0,
    fallbackEntry: entry,
  };
}

/** Extract model family from model ID (e.g., "gpt-4" from "openai/gpt-4-turbo") */
function extractModelFamily(model: string): string {
  const parts = model.split("/");
  const modelName = parts[parts.length - 1];
  // Common family prefixes
  const prefixes = [
    "gpt-", "claude-", "gemini-", "llama-", "mistral-", "mixtral-",
    "command-", "jamba-", "qwen-", "yi-", "deepseek-", "phi-",
    "nemotron-", "granite-", "solar-", "zephyr-", "openchat-"
  ];
  for (const p of prefixes) {
    if (modelName.startsWith(p)) {
      const rest = modelName.slice(p.length);
      const versionMatch = rest.match(/^(\d+(\.\d+)?)/);
      if (versionMatch) {
        return p + versionMatch[1];
      }
      return p.slice(0, -1); // e.g., "gpt"
    }
  }
  // Fallback: first word before dash/underscore
  return modelName.split(/[-_]/)[0];
}

/**
 * Fan-out requests to panel members with timeout and optional short-circuit.
 * Resolves API keys for each panel member before calling.
 */
async function fanOutPanel(
  panel: PanelMember[],
  request: ChatCompletionRequest,
  config: FusionConfig,
  clientProfile?: any
): Promise<PanelResponse[]> {
  const timeoutMs = config.panelTimeoutMs ?? 30000;

  // Resolve keys for panel members
  const resolvedPanel: PanelMember[] = [];
  for (const member of panel) {
    const key = await getKeyById(member.fallbackEntry.key_id);
    if (key) {
      resolvedPanel.push({ ...member, key });
    } else {
      console.warn("[fusion] Could not resolve key for", member.provider, member.model);
    }
  }

  if (resolvedPanel.length === 0) {
    return panel.map(m => ({ member: m, error: "No valid keys", latencyMs: 0 }));
  }

  // Create promise for each panel member
  const promises = resolvedPanel.map(async (member): Promise<PanelResponse> => {
    const memberStart = Date.now();
    try {
      const adapter = getAdapterForPlatform(member.provider);
      if (!adapter) {
        return {
          member,
          error: `Provider ${member.provider} not registered`,
          latencyMs: Date.now() - memberStart,
        };
      }

      // Create request for this specific model
      const modelRequest: ChatCompletionRequest = {
        ...request,
        model: member.model,
      };

      // Execute with timeout
      const resultPromise = executeChat(modelRequest, member.key);
      const timeoutPromise = new Promise<ProviderResult>((_, reject) =>
        setTimeout(() => reject(new Error("Panel timeout")), timeoutMs)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (result.error) {
        return {
          member,
          error: result.error,
          latencyMs: Date.now() - memberStart,
        };
      }

      return {
        member,
        response: result.response,
        latencyMs: Date.now() - memberStart,
        toolCalls: result.response?.choices?.[0]?.message?.tool_calls,
      };
    } catch (e) {
      return {
        member,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - memberStart,
      };
    }
  });

  // Wait for all or short-circuit
  if (config.shortCircuit && config.panelSelection === "speed") {
    // For speed mode, return first successful response
    for (const p of promises) {
      const result = await p;
      if (!result.error && result.response) {
        return [result];
      }
    }
    return await Promise.all(promises);
  }

  return Promise.all(promises);
}

/**
 * Panel voting for tool calls.
 * If majority vote for tool call, pick the most common tool call.
 * If majority vote for prose, return best prose response.
 */
function panelVoteToolCalls(
  responses: PanelResponse[],
  toolChoice: "auto" | "required" | "none" | undefined
): PanelResponse | null {
  if (toolChoice === "none") return null;

  const withTools = responses.filter(r => r.toolCalls && r.toolCalls.length > 0);
  const withoutTools = responses.filter(r => !r.toolCalls && r.response?.choices?.[0]?.message?.content);

  if (toolChoice === "required") {
    // Must use tool - pick from those with tools
    if (withTools.length > 0) {
      return withTools[0];
    }
    return null;
  }

  // Auto mode: majority vote
  if (withTools.length > withoutTools.length) {
    return pickMajorityToolCall(withTools);
  }

  return bestProseResponse(withoutTools);
}

/** Pick the most common tool call from panel */
function pickMajorityToolCall(responses: PanelResponse[]): PanelResponse | null {
  const toolCallMap = new Map<string, PanelResponse[]>();

  for (const r of responses) {
    if (r.toolCalls) {
      const sig = r.toolCalls.map(t => t.function?.name).sort().join(",");
      const arr = toolCallMap.get(sig) || [];
      arr.push(r);
      toolCallMap.set(sig, arr);
    }
  }

  let maxCount = 0;
  let winner: PanelResponse | null = null;
  for (const [, arr] of toolCallMap) {
    if (arr.length > maxCount) {
      maxCount = arr.length;
      winner = arr[0];
    }
  }

  return winner;
}

/** Pick best prose response (longest, most complete) */
function bestProseResponse(responses: PanelResponse[]): PanelResponse | null {
  if (responses.length === 0) return null;

  return responses
    .filter(r => r.response?.choices?.[0]?.message?.content)
    .sort((a, b) => {
      const lenA = a.response?.choices?.[0]?.message?.content?.length ?? 0;
      const lenB = b.response?.choices?.[0]?.message?.content?.length ?? 0;
      if (lenB !== lenA) return lenB - lenA;
      return a.latencyMs - b.latencyMs;
    })[0] || null;
}

/**
 * Judge synthesis: send all panel responses to judge model for final synthesis.
 */
async function judgeSynthesize(
  panelResponses: PanelResponse[],
  judgeModel: string,
  originalRequest: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const validResponses = panelResponses.filter(r => r.response && !r.error);
  if (validResponses.length === 0) {
    throw new Error("No valid panel responses for judge synthesis");
  }

  if (validResponses.length === 1) {
    return validResponses[0].response!;
  }

  // Build synthesis prompt
  const responsesText = validResponses
    .map((r, i) => `=== Response ${i + 1} (${r.member.provider}/${r.member.model}) ===\n${r.response?.choices?.[0]?.message?.content ?? ""}`)
    .join("\n\n");

  const synthesisPrompt = `You are a judge tasked with synthesizing the best possible answer from multiple AI responses to the same question.

Original question: ${originalRequest.messages.map(m => `${m.role}: ${m.content}`).join("\n")}

Multiple AI responses:
${responsesText}

Instructions:
1. Combine the best parts from each response
2. Remove contradictions and hallucinations
3. Produce a single, coherent, high-quality answer
4. If responses contain code, prefer the most complete and correct version
5. Maintain the original language and tone

Synthesized answer:`;

  const judgeRequest: ChatCompletionRequest = {
    model: judgeModel,
    messages: [
      { role: "system", content: "You are an expert synthesizer. Combine multiple AI responses into the best single answer." },
      { role: "user", content: synthesisPrompt },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  };

  // Find judge key
  const judgeParts = judgeModel.split("/");
  const judgePlatform = judgeParts[0];
  const judgeModelId = judgeParts.slice(1).join("/");
  
  const judgeKey = await getKeyById(judgePlatform);
  if (!judgeKey) {
    console.warn("[fusion] No judge key available, falling back to best prose");
    return bestProseResponse(validResponses)!.response!;
  }

  const result = await executeChat(judgeRequest, judgeKey);
  
  if (result.error) {
    console.warn("[fusion] Judge synthesis failed, falling back to best prose:", result.error);
    return bestProseResponse(validResponses)!.response!;
  }

  const synthesized = result.response!;
  synthesized.choices[0].message.content = 
    (synthesized.choices[0].message.content ?? "") + "\n\n---\n*Synthesized from " + validResponses.length + " models via " + judgeModel + "*";
  
  return synthesized;
}

/**
 * Best-of strategy: return the longest/most complete response.
 */
function bestOf(panelResponses: PanelResponse[]): ChatCompletionResponse {
  const valid = panelResponses.filter(r => r.response && !r.error);
  if (valid.length === 0) {
    throw new Error("No valid responses for best-of");
  }
  return bestProseResponse(valid)!.response!;
}

/**
 * Main fusion entry point.
 * Runs panel voting + judge synthesis based on config.
 */
export async function runFusion(
  request: ChatCompletionRequest,
  config: Partial<FusionConfig>,
  routingDecision: RoutingDecision,
  clientProfile?: any
): Promise<FusionResult> {
  const startTime = Date.now();
  const finalConfig = { ...DEFAULT_FUSION_CONFIG, ...config };

  // 1. Select panel from fallback chain (uses fallback_chain from routing decision)
  const panel = selectPanel(
    routingDecision.fallback_chain,
    finalConfig.k,
    finalConfig.panelSelection
  );

  if (panel.length === 0) {
    throw new Error("No panel members available for fusion");
  }

  // 2. Fan-out to panel
  const panelResponses = await fanOutPanel(panel, request, finalConfig, clientProfile);

  // 3. Check for tool calls - panel voting
  const toolChoice = request.tool_choice as "auto" | "required" | "none" | undefined;
  const toolVoteResult = panelVoteToolCalls(panelResponses, toolChoice);

  let finalResponse: ChatCompletionResponse;

  if (toolVoteResult && toolVoteResult.toolCalls) {
    finalResponse = toolVoteResult.response!;
  } else if (toolVoteResult && toolVoteResult.response) {
    finalResponse = toolVoteResult.response;
  } else {
    switch (finalConfig.strategy) {
      case "synthesize":
        finalResponse = await judgeSynthesize(panelResponses, finalConfig.judge, request);
        break;
      case "best_of":
        finalResponse = bestOf(panelResponses);
        break;
      default:
        finalResponse = bestOf(panelResponses);
    }
  }

  const totalLatency = Date.now() - startTime;

  return {
    response: finalResponse,
    panelResponses,
    metadata: {
      mode: finalConfig.mode,
      panelSize: panel.length,
      judgeUsed: finalConfig.strategy === "synthesize",
      strategy: finalConfig.strategy,
      totalLatencyMs: totalLatency,
    },
  };
}

/**
 * Quick fusion for simple cases - just run panel and pick best.
 */
export async function quickFusion(
  request: ChatCompletionRequest,
  fallbackChain: FallbackEntry[],
  k: number = 3
): Promise<ChatCompletionResponse> {
  const panel = selectPanel(fallbackChain, k, "diversity");
  const responses = await fanOutPanel(panel, request, { ...DEFAULT_FUSION_CONFIG, k, shortCircuit: true }, undefined);
  return bestProseResponse(responses)?.response ?? responses[0].response!;
}