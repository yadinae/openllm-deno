/**
 * Quirks execution layer — applies catalog quirks at request time.
 * Reads quirks from `models` table + `quirks` + `quirk_targets`.
 * Returns quirks in response metadata or blocks/alters requests based on severity.
 */

import { query, initDb } from "../db/pg.ts";

export interface Quirk {
  slug: string;
  title: string;
  body: string;
  severity: "blocker" | "warning" | "info";
}

export interface QuirkTarget {
  platform?: string | null;
  modelGlob?: string | null;
}

export interface QuirkDefinition extends Quirk {
  targets: QuirkTarget[];
}

const SEVERITY_ORDER: Record<Quirk["severity"], number> = { blocker: 0, warning: 1, info: 2 };

/** Resolve all quirks applicable to a specific (platform, modelId) at request time. */
export async function resolveRequestQuirks(
  platform: string,
  modelId: string,
): Promise<Quirk[]> {
  await initDb();

  // Query quirks that match this platform+model via glob patterns
  const rows = await query`
    SELECT DISTINCT q.slug, q.title, q.body, q.severity
    FROM models m
    JOIN quirk_targets t
      ON (t.platform IS NULL OR t.platform = m.platform)
     AND (t.model_glob IS NULL OR m.model_id GLOB t.model_glob)
    JOIN quirks q ON q.id = t.quirk_id
    WHERE m.platform = ${platform} AND m.model_id = ${modelId}
  `;

  const quirks: Quirk[] = rows.map((r: any) => ({
    slug: r.slug,
    title: r.title,
    body: r.body,
    severity: r.severity,
  }));

  quirks.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.slug.localeCompare(b.slug));
  return quirks;
}

/** Check if a model has any blocker quirks that should reject the request. */
export function hasBlockerQuirk(quirks: Quirk[]): Quirk | null {
  return quirks.find(q => q.severity === "blocker") ?? null;
}

/** Format quirks for response metadata (warnings/info). */
export function formatQuirksForResponse(quirks: Quirk[]): Array<{ slug: string; title: string; body: string; severity: string }> {
  return quirks.map(q => ({
    slug: q.slug,
    title: q.title,
    body: q.body,
    severity: q.severity,
  }));
}

/** List all quirk definitions (for dashboard / catalog view). */
export async function listQuirkDefinitions(): Promise<QuirkDefinition[]> {
  await initDb();

  const quirks = await query`SELECT id, slug, title, body, severity FROM quirks ORDER BY slug` as Array<{ id: number } & Quirk>;

  const result: QuirkDefinition[] = [];
  for (const q of quirks) {
    const targets = await query`SELECT platform, model_glob FROM quirk_targets WHERE quirk_id = ${q.id}` as Array<{ platform: string | null; model_glob: string | null }>;
    result.push({
      slug: q.slug,
      title: q.title,
      body: q.body,
      severity: q.severity,
      targets: targets.map((t: any) => ({ platform: t.platform, modelGlob: t.model_glob })),
    });
  }
  return result;
}