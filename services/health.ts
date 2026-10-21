/**
 * health.ts — key validation probe for cooldown early-recovery.
 *
 * Ported from FreeLLMAPI services/health.js `probeKeyValidity()`.
 * Stripped to the minimum needed by cooldown-probe: a single function that
 * tests whether an API key is still valid by calling the provider's
 * validation endpoint (usually /models or a minimal chat completion).
 *
 * Returns 'valid' | 'invalid' | 'error' (transport error = inconclusive).
 */

import { initDb, query } from "../db/pg.ts";
import { decryptKey } from "../db/mod.ts";
import { providerRegistry, getAdapterForPlatform } from "../providers/index.ts";

/**
 * Probe a key's validity.
 * Used by cooldown-probe to decide whether to clear a heuristic cooldown early.
 *
 * @returns 'valid' (key works) | 'invalid' (401/403) | 'error' (transport failure)
 */
export async function probeKeyValidity(keyId: number): Promise<"valid" | "invalid" | "error"> {
  try {
    await initDb();
    const rows = await query`
      SELECT id, platform, label, encrypted_key, iv, auth_tag, base_url
      FROM api_keys
      WHERE id = ${keyId} AND enabled = 1
    `;
    if (rows.length === 0) return "error";

    const k = rows[0] as any;
    const adapter = getAdapterForPlatform(k.platform);
    if (!adapter) return "error";

    // Decrypt the key
    const decrypted = await decryptKey(k.encrypted_key, k.iv, k.auth_tag);
    if (!decrypted) return "error";

    // Build minimal validation request (provider-specific)
    // For OpenAI-compatible: GET /models is the standard validation
    // For Anthropic: there's no /models, use a minimal chat completion
    // For others: try /models first, fall back to minimal chat

    let isValid = false;

    try {
      // Try the provider's native validation method if available
      if (typeof (adapter as any).validateKey === "function") {
        const result = await (adapter as any).validateKey(decrypted, {
          platform: k.platform,
          keyId: Number(k.id),
          endpoint: "models",
          origin: "probe",
        });
        isValid = typeof result === "boolean" ? result : result?.valid ?? false;
      } else {
        // Fallback: try to call adapter.models() which hits /models
        await adapter.models();
        isValid = true;
      }
    } catch (err: any) {
      // If the adapter doesn't have validateKey and models() throws,
      // the error tells us if it's auth (401/403) or transport
      if (err?.status === 401 || err?.status === 403) {
        return "invalid";
      }
      // Transport error (DNS, timeout, TLS) — inconclusive
      return "error";
    }

    return isValid ? "valid" : "invalid";
  } catch (e) {
    console.error("[health] probeKeyValidity error:", e);
    return "error";
  }
}