/**
 * Gemini model mapping — Gemini family → catalog model pins.
 *
 * Ported from FreeLLMAPI services/gemini-map.ts (2.7KB).
 *
 * Models like gemini-2.5-flash, gemini-1.5-pro get mapped to the operator's
 * selected free pool model via family aliases. Stored in Postgres settings.
 */
import { getSetting, saveSetting, query } from "../db/pg.ts";

const SETTING_KEY = "gemini_model_map";

export const GEMINI_FAMILIES = ["default", "pro", "flash", "flashLite"] as const;
export type GeminiFamily = (typeof GEMINI_FAMILIES)[number];
export type GeminiModelMap = Record<GeminiFamily, string>;

const DEFAULT_MAP: GeminiModelMap = {
  default: "auto",
  pro: "auto",
  flash: "auto",
  flashLite: "auto",
};

let _cachedMap: GeminiModelMap | null = null;
let _cacheTs = 0;

export async function getGeminiModelMap(): Promise<GeminiModelMap> {
  if (_cachedMap && Date.now() - _cacheTs < 60_000) return _cachedMap;
  const raw = await getSetting<string>(SETTING_KEY);
  _cacheTs = Date.now();
  if (!raw) { _cachedMap = { ...DEFAULT_MAP }; return _cachedMap; }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    _cachedMap = {
      default: (parsed.default as string) || "auto",
      pro: (parsed.pro as string) || "auto",
      flash: (parsed.flash as string) || "auto",
      flashLite: (parsed.flashLite as string) || "auto",
    };
    return _cachedMap;
  } catch {
    _cachedMap = { ...DEFAULT_MAP };
    return _cachedMap;
  }
}

export async function setGeminiModelMap(input: unknown): Promise<GeminiModelMap> {
  const patch = input as Record<string, unknown>;
  const current = await getGeminiModelMap();
  const next: GeminiModelMap = {
    default: (patch.default as string) ?? current.default,
    pro: (patch.pro as string) ?? current.pro,
    flash: (patch.flash as string) ?? current.flash,
    flashLite: (patch.flashLite as string) ?? current.flashLite,
  };
  await saveSetting(SETTING_KEY, JSON.stringify(next));
  _cachedMap = next;
  return next;
}

/**
 * Classify a Gemini-family request into one of the four families.
 * Returns null when the model name is not Gemini at all.
 */
export function classifyGeminiFamily(model?: string): GeminiFamily | null {
  const normalized = (model ?? "").trim().toLowerCase().replace(/^models\//, "");
  if (!normalized || normalized === "auto") return "default";
  if (!normalized.startsWith("gemini")) return null;
  if (/flash[-_]?lite/.test(normalized)) return "flashLite";
  if (normalized.includes("flash")) return "flash";
  if (normalized.includes("pro")) return "pro";
  return "default";
}

/**
 * Resolve a Gemini-family request to the operator's selected catalog id.
 * Returning "auto" leaves routing unpinned; concrete non-Gemini catalog ids
 * still pass through unchanged for native clients.
 */
export async function resolveGeminiModel(model?: string): Promise<string> {
  const raw = (model ?? "").trim().replace(/^models\//, "");
  const family = classifyGeminiFamily(raw);
  if (family) {
    const map = await getGeminiModelMap();
    const target = map[family];
    if (!target || target === "auto") return "auto";
    // Check if the pinned model exists and is enabled
    const rows = await query`
      SELECT 1 FROM catalog_models WHERE model_id = ${target} AND enabled = 1 LIMIT 1
    `;
    return rows.length > 0 ? target : "auto";
  }
  return raw || "auto";
}
