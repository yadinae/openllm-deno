/**
 * /v1/models route — returns catalog models (applied catalog + discovered models).
 */

import type { Context } from "hono";
import type { DbData } from "../db/mod.ts";
import { getModels as getDiscoveredModels } from "../db/pg.ts";
import { claudeFamilyDiscoveryEntries } from "../services/anthropic-map.ts";

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window: number;
  capabilities: string[];
  supports_reasoning: boolean;
  free: boolean;
}

export async function getModels(c: Context) {
  const db = c.get("db") as DbData;
  const settings = db.settings;

  let catalog: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(settings["catalog_applied_json"] ?? "{}") as { models?: unknown };
    catalog = Array.isArray(parsed.models) ? parsed.models as Array<Record<string, unknown>> : [];
  } catch {
    catalog = [];
  }

  const seen = new Set<string>();
  const data: OpenAIModel[] = [];

  for (const m of catalog) {
    if (m.enabled === false) continue;
    const platform = String(m.platform ?? "");
    const modelId = String(m.modelId ?? m.model_id ?? m.id ?? "");
    if (!platform || !modelId) continue;
    const key = `${platform}/${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    data.push({
      id: key,
      object: "model",
      created: 0,
      owned_by: platform,
      context_window: (m.contextWindow as number) ?? (m.context_window as number) ?? 128000,
      capabilities: ["text"],
      supports_reasoning: (m.supports_reasoning as boolean) ?? false,
      free: (m.isFree as boolean) ?? (m.is_free as boolean) ?? false,
    });
  }

  try {
    for (const m of await getDiscoveredModels()) {
      if (!m.enabled) continue;
      const key = `${m.platform}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      data.push({
        id: key,
        object: "model",
        created: 0,
        owned_by: m.platform,
        context_window: m.contextWindow ?? 128000,
        capabilities: ["text"],
        supports_reasoning: false,
        free: m.isFree ?? false,
      });
    }
  } catch {
    // Postgres unavailable — catalog-only list is still valid
  }

  // Add Claude family discovery entries (for Anthropic clients)
  for (const entry of claudeFamilyDiscoveryEntries()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    data.push({
      id: entry.id,
      object: "model",
      created: 0,
      owned_by: "anthropic-map",
      context_window: 200000,
      capabilities: ["text"],
      supports_reasoning: false,
      free: true,
    });
  }

  if (data.length === 0) {
    data.push(
      {
        id: "agnes/agnes-2.5-flash", object: "model", created: 0, owned_by: "agnes",
        context_window: 128000, capabilities: ["text"], supports_reasoning: false, free: true,
      },
      {
        id: "google/gemini-2.5-flash", object: "model", created: 0, owned_by: "google",
        context_window: 1048576, capabilities: ["text"], supports_reasoning: true, free: true,
      },
    );
  }

  return c.json({ object: "list", data });
}
