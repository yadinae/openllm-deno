/**
 * Native Deno.cron() job: auto-discover models for all enabled providers.
 *
 * Registered in main.ts via Deno.cron(). Runs every 6 hours.
 * Called directly — no HTTP request context needed.
 */
import { listApiKeys, saveModels } from "../db/pg.ts";
import { decryptKeyValue } from "../db/mod.ts";
import { discoverModels } from "./discovery.ts";

/**
 * Discover models for all enabled providers and persist results.
 * Returns a summary map of platform → { total, error? }.
 */
export async function runDiscoveryCron(): Promise<Record<string, { total: number; error?: string }>> {
  const results: Record<string, { total: number; error?: string }> = {};
  const keys = await listApiKeys();

  for (const key of keys) {
    if (!key.enabled) continue;
    try {
      const decKey = key.encrypted_key
        ? (await decryptKeyValue(key as never)) ?? undefined
        : undefined;
      const models = await discoverModels({ api_keys: [] } as never, key.platform, decKey);
      await saveModels(key.platform, models);
      results[key.platform] = { total: models.length };
    } catch (e) {
      results[key.platform] = {
        total: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return results;
}
