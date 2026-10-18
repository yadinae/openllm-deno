/**
 * /v1/models route — returns catalog models (Phase 1: static list from settings).
 */

import type { HonoRequest } from "hono";
import type { Context, Next } from "hono";
import type { DbData } from "../db/mod.ts";

export async function getModels(c: Context) {
  const db = c.get("db") as DbData;
  const settings = db.settings;

  // Build model list from the catalog applied in settings
  let models: unknown[] = [];
  try {
    const catalog = JSON.parse(settings["catalog_applied_json"] ?? "{}");
    models = (catalog.models as unknown[] ?? []).filter((m: Record<string, unknown>) => m.enabled !== false);
  } catch {
    // Fall back to a minimal list if catalog parse fails
    models = [];
  }

  // If catalog is empty, provide a sensible default based on loaded keys
  if (models.length === 0) {
    models = [
      {
        platform: "agnes",
        model_id: "agnes-2.5-flash",
        display_name: "Agnes 2.5 Flash",
        enabled: true,
        context_window: 128000,
        supports_reasoning: false,
        intelligence_rank: 80,
        speed_rank: 2,
      },
      {
        platform: "google",
        model_id: "gemini-2.5-flash",
        display_name: "Gemini 2.5 Flash",
        enabled: true,
        context_window: 1048576,
        supports_reasoning: true,
        intelligence_rank: 85,
        speed_rank: 3,
      },
    ];
  }

  const data = models.map((m: Record<string, unknown>) => ({
    id: `${m.platform}/${m.modelId}` as string,
    object: "model" as const,
    created: 0,
    owned_by: m.platform as string,
    context_window: (m.contextWindow as number) ?? 128000,
    capabilities: ["text"] as string[],
    supports_reasoning: (m.supports_reasoning as boolean) ?? false,
  }));

  return c.json({ object: "list", data });
}
