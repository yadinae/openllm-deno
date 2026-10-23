/**
 * Anthropic model mapping — Claude family → catalog model pins.
 *
 * Ported from FreeLLMAPI services/anthropic-map.ts (9.8KB).
 *
 * Claude Code sends familiar model names (claude-sonnet-4-5, claude-haiku-4-5)
 * to /v1/messages. Since this proxy serves a free model pool, we map each
 * Claude family to either "auto" (let the router pick) or a specific catalog
 * model the operator pins. Tier selectors (tier:pro|mid|normal) route to all
 * models in that intelligence tier instead of pinning one.
 *
 * Adapted for OpenLLM: uses Postgres getSetting/saveSetting instead of SQLite.
 */
import { getSetting, saveSetting, query } from "../db/pg.ts";

const SETTING_KEY = "anthropic_model_map";

export const CLAUDE_FAMILIES = ["default", "opus", "sonnet", "haiku"] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];
// Each value is either the sentinel "auto", a catalog model_id, or a tier
// selector "tier:pro|mid|normal" (see resolveTierModel below).
export type AnthropicModelMap = Record<ClaudeFamily, string>;

const DEFAULT_MAP: AnthropicModelMap = { default: "auto", opus: "auto", sonnet: "auto", haiku: "auto" };

// Lazy cache — loaded once per request via getClaudeModelMap()
let _cachedMap: AnthropicModelMap | null = null;
let _cacheTs = 0;

export async function getClaudeModelMap(): Promise<AnthropicModelMap> {
  // Re-validate cache every 60s to avoid stale reads
  if (_cachedMap && Date.now() - _cacheTs < 60_000) return _cachedMap;
  const raw = await getSetting<string>(SETTING_KEY);
  _cacheTs = Date.now();
  if (!raw) { _cachedMap = { ...DEFAULT_MAP }; return _cachedMap; }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    _cachedMap = {
      default: (typeof p.default === "string" && p.default ? p.default : undefined) ?? "auto",
      opus: (typeof p.opus === "string" && p.opus ? p.opus : undefined) ?? "auto",
      sonnet: (typeof p.sonnet === "string" && p.sonnet ? p.sonnet : undefined) ?? "auto",
      haiku: (typeof p.haiku === "string" && p.haiku ? p.haiku : undefined) ?? "auto",
    };
    return _cachedMap;
  } catch {
    _cachedMap = { ...DEFAULT_MAP };
    return _cachedMap;
  }
}

export async function setClaudeModelMap(input: unknown): Promise<AnthropicModelMap> {
  const patch = input as Record<string, unknown>;
  const current = await getClaudeModelMap();
  const next: AnthropicModelMap = {
    default: (typeof patch.default === "string" && patch.default ? patch.default : undefined) ?? current.default,
    opus: (typeof patch.opus === "string" && patch.opus ? patch.opus : undefined) ?? current.opus,
    sonnet: (typeof patch.sonnet === "string" && patch.sonnet ? patch.sonnet : undefined) ?? current.sonnet,
    haiku: (typeof patch.haiku === "string" && patch.haiku ? patch.haiku : undefined) ?? current.haiku,
  };
  await saveSetting(SETTING_KEY, JSON.stringify(next));
  _cachedMap = next;
  return next;
}

// Tier selectors reuse the intelligence tiers (size_label) as the
// capability axis: pro → Frontier, mid → Large, normal → Medium+Small.
export const TIER_SELECTORS = ["tier:pro", "tier:mid", "tier:normal"] as const;
export type TierSelector = (typeof TIER_SELECTORS)[number];

const TIER_SIZE_LABELS: Record<TierSelector, string[]> = {
  "tier:pro": ["Frontier"],
  "tier:mid": ["Large"],
  "tier:normal": ["Medium", "Small"],
};

export function parseTierSelector(value: string): TierSelector | null {
  const v = value.trim().toLowerCase();
  return (TIER_SELECTORS as readonly string[]).includes(v) ? (v as TierSelector) : null;
}

/**
 * Classify a requested model into a Claude family, or null when it's not a
 * Claude alias at all (a concrete catalog id meant to pin directly).
 */
export function classifyClaudeFamily(model?: string): ClaudeFamily | null {
  const m = (model ?? "").trim().toLowerCase();
  if (!m || m === "auto" || m === "default" || m === "freellmapi-auto") return "default";
  // Claude Code's planning alias is opus-ish by name but must hit the catch-all,
  // so match it before the substring family checks below.
  if (m === "opusplan" || m === "opusplan-4") return "default";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  // Any other claude-ish alias → the catch-all.
  if (m.startsWith("claude")) return "default";
  return null;
}

export interface ResolvedAnthropicModel {
  preferredModelDbId?: number;
  modelId?: string;
  pinned: boolean;
  tierDbIds?: number[];
}

/**
 * Resolve a `/v1/messages` request to the operator's selected catalog id.
 * Returns undefined preferredModelDbId to mean "auto-route" (the default).
 */
export async function resolveAnthropicModel(model?: string): Promise<ResolvedAnthropicModel> {
  // A model_id can exist on several platforms at once. We pick deterministically
  // by chain priority first (ascending), then insertion order.
  const lookupEnabled = async (modelId: string): Promise<{ id: number; model_id: string } | undefined> => {
    const rows = await query`
      SELECT m.id, m.model_id
      FROM catalog_models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ${modelId} AND m.enabled = 1
      ORDER BY COALESCE(fc.priority, 0) ASC, m.id ASC
      LIMIT 1
    ` as Array<{ id: number; model_id: string }>;
    return rows[0];
  };

  const family = classifyClaudeFamily(model);
  if (family) {
    const map = await getClaudeModelMap();
    const target = map[family];
    const tier = target ? parseTierSelector(target) : null;
    if (tier) {
      const labels = TIER_SIZE_LABELS[tier];
      try {
        const rows = await query`
          SELECT m.id
          FROM catalog_models m
          LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
          WHERE m.enabled = 1 AND m.size_label IN (${labels})
          ORDER BY COALESCE(fc.priority, 0) ASC, m.id ASC
        ` as Array<{ id: number }>;
        const tierDbIds = rows.map((r) => r.id);
        return tierDbIds.length ? { pinned: false, tierDbIds } : { pinned: false };
      } catch {
        return { pinned: false };
      }
    }
    if (!target || target === "auto") return { pinned: false };
    const row = await lookupEnabled(target);
    return row ? { preferredModelDbId: row.id, modelId: row.model_id, pinned: true } : { pinned: false };
  }

  // Not a Claude alias: treat as a concrete catalog model id and pin it if
  // it exists and is enabled; otherwise auto-route.
  const row = await lookupEnabled((model ?? "").trim());
  return row ? { preferredModelDbId: row.id, modelId: row.model_id, pinned: true } : { pinned: false };
}

// Canonical Claude family aliases for model discovery.
export const CLAUDE_FAMILY_ALIASES: { id: string; family: ClaudeFamily; label: string }[] = [
  { id: "claude-opus-4-5", family: "opus", label: "Opus" },
  { id: "claude-sonnet-4-5", family: "sonnet", label: "Sonnet" },
  { id: "claude-haiku-4-5", family: "haiku", label: "Haiku" },
];

export async function claudeFamilyDiscoveryEntries(): Promise<{ id: string; displayName: string }[]> {
  const map = await getClaudeModelMap();
  return CLAUDE_FAMILY_ALIASES.map(({ id, family, label }) => {
    const target = map[family];
    return {
      id,
      displayName: !target || target === "auto"
        ? `${label} slot (auto-routed to a free model)`
        : `${label} slot (routed to ${target})`,
    };
  });
}
