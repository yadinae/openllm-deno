/**
 * Client/agent classifier — ports FreeLLMAPI `server/src/lib/client-classifier.ts`.
 *
 * The `/agents` page ("智能体") groups request log rows by this coarse enum, so the
 * value must stay stable across client versions: signal order is
 * dedicated-header → UA regex → wire-format fallback, never a version string.
 */

export const CLIENT_AGENTS = [
  "claude-code",
  "codex",
  "cline",
  "roo",
  "continue",
  "aider",
  "opencode",
  "goose",
  "qwen-code",
  "kilo-code",
  "crush",
  "deepseek-harness",
  "mimo-code",
  "atomcode",
  "openclaw",
  "hermes-agent",
  "pi",
  "reasonix",
  "cursor",
  "gemini-cli",
  "zed",
  "jetbrains",
  "ollama-client",
  "openai-sdk",
  "anthropic-sdk",
  "unknown",
] as const;

export type ClientAgent = (typeof CLIENT_AGENTS)[number];

/** Raw request signals, already read off the transport. Pure = unit-testable. */
export interface ClientSignals {
  /** Request path without query string (used only for wire-format fallbacks). */
  path?: string;
  userAgent?: string;
  /** `x-claude-code-session-id` — only Claude Code sets it. */
  claudeCodeSessionId?: string;
  /** `x-session-id` — Claude Code session affinity on /v1/messages. */
  sessionId?: string;
}

/**
 * Best-effort classification from stable protocol/header signals first, then UA.
 * Returns a coarse enum so analytics survives client version churn.
 */
export function classifyClientAgent(signals: ClientSignals): ClientAgent {
  const path = (signals.path ?? "").split("?")[0].toLowerCase();
  const tokenizedPath = path.replace(/^\/v1\/t\/[^/]+/, "");
  const ua = (signals.userAgent ?? "").toLowerCase();

  // Strongest signal first: the dedicated session header only Claude Code sets.
  if (signals.claudeCodeSessionId) return "claude-code";

  // UA signals must beat wire-format fallbacks: Qwen Code speaks the Gemini wire
  // on /v1beta, and a plain openai SDK can call /v1/responses — neither should
  // be counted as the surface's flagship client. Claude Code's real UA is
  // `claude-cli/x.y.z (external, cli)`.
  if (/claude[- ]?code|\bclaude-cli\b/.test(ua)) return "claude-code";
  if (/\bcodex\b/.test(ua)) return "codex";
  if (/qwen[- ]?code|\bqwen-cli\b/.test(ua)) return "qwen-code";
  if (/gemini[- /]cli/.test(ua)) return "gemini-cli";
  if (/kilo[- ]?code|\bkilocode\b/.test(ua)) return "kilo-code";
  if (/\bcrush(?:\/|\s|$)/.test(ua)) return "crush";
  // `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`
  if (/deepseek[- ]?harness|\bdsh\//.test(ua)) return "deepseek-harness";
  // MiMo Code is an OpenCode derivative and can carry either name, so it has to
  // be tested before the plain `opencode` rule below.
  if (/mimo[- ]?code|\bmimo\//.test(ua)) return "mimo-code";
  if (/\batomcode\b/.test(ua)) return "atomcode";
  if (/\bopenclaw\b/.test(ua)) return "openclaw";
  if (/hermes[- ]?agent|\bhermes-cli\b/.test(ua)) return "hermes-agent";
  if (/\bpi-coding-agent\b|^pi\/\d/.test(ua)) return "pi";
  if (/^reasonix\//.test(ua)) return "reasonix";
  if (/opencode/.test(ua)) return "opencode";
  if (/\bcline\b/.test(ua)) return "cline";
  if (/\broo[- /]/.test(ua) || /roo ?code/.test(ua)) return "roo";
  if (/continue(?:\.dev)?/.test(ua)) return "continue";
  if (/\baider\b/.test(ua)) return "aider";
  if (/\bgoose\b/.test(ua)) return "goose";
  if (/\bcursor\b/.test(ua)) return "cursor";
  if (/\bzed\b/.test(ua)) return "zed";
  if (/jetbrains|intellij|pycharm|webstorm/.test(ua)) return "jetbrains";
  if (/\bollama\b/.test(ua)) return "ollama-client";
  if (/anthropic|claude-sdk/.test(ua)) return "anthropic-sdk";
  if (/openai|langchain|litellm/.test(ua)) return "openai-sdk";

  // Wire-format fallbacks for clients with no recognizable UA.
  if (path.startsWith("/v1/responses") || tokenizedPath.startsWith("/responses")) return "codex";
  if (path.startsWith("/v1beta/")) return "gemini-cli";
  if (path.startsWith("/v1/messages")) {
    return signals.sessionId ? "claude-code" : "anthropic-sdk";
  }
  if (
    tokenizedPath.startsWith("/api/chat") ||
    tokenizedPath.startsWith("/api/generate") ||
    tokenizedPath.startsWith("/api/tags")
  ) {
    return "ollama-client";
  }
  return "unknown";
}
