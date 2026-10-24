/**
 * Provider Credential Service — budget-aware key reservation for the
 * embeddings/media routers (#1158 parity).
 *
 * Ported from FreeLLMAPI services/provider-credential.js (57 lines).
 *
 * Differences from the original:
 *  - Postgres async queries (query tagged template) instead of SQLite sync prepare.
 *  - Web Crypto API: `decryptKey` is async (no Node crypto module on Deno Deploy).
 *  - `reserveMonthlyBudget` is async in OpenLLM (was sync in FreeLLMAPI).
 *  - `api_keys.platform` is UNIQUE in OpenLLM, so per-platform lookup returns at
 *    most one row; custom endpoints must arrive with a bound key_id (otherwise
 *    there's nothing to reserve — handled by the guard below).
 *  - No `group_label` column; OpenLLM stores group labels in a separate table.
 */
import { query, initDb } from "../db/pg.ts";
import { decryptKey } from "../db/mod.ts";
import { reserveMonthlyBudget } from "./key-budget.ts";

export interface ReservedProviderCredential {
  id: number;            // api_keys.db_id (integer PK)
  key: string;           // decrypted secret (plaintext)
  baseUrl: string | null;
  release: () => void;   // call after the request settles to free the budget reservation
}

interface KeyRow {
  id: number;            // INTEGER PRIMARY KEY in Postgres
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
}

/**
 * Select and reserve a credential for the independent embeddings/media routers.
 *
 * Bound custom models stay on their own key; ordinary providers may use any
 * healthy key with room in its budget. Callers release the reservation after
 * logging the result.
 *
 * - `row.platform === "custom"` with no `key_id` → returns null immediately
 *   (a custom endpoint must bind to a specific key row; there's nothing to
 *   randomly pick).
 * - `key_id` set → look up that exact row.
 * - otherwise → pick any healthy/unknown key for `platform` (ORDER BY RANDOM()
 *   so pool members rotate across requests).
 *
 * `budgetBlocked` is true when at least one candidate key was rejected by the
 * monthly-token cap (distinct from a plain "no usable key found").
 */
export async function reserveProviderCredential(
  row: { platform: string; key_id?: number | null },
  estimatedTokens: number,
  skip: (keyId: number) => boolean = () => false,
): Promise<{ credential: ReservedProviderCredential | null; budgetBlocked: boolean }> {
  // Custom endpoints with no bound key have nothing to reserve a credential for.
  if (row.platform === "custom" && row.key_id == null) {
    return { credential: null, budgetBlocked: false };
  }

  const bound = row.key_id != null;

  try {
    await initDb();
  } catch {
    return { credential: null, budgetBlocked: false };
  }

  let rows: KeyRow[];
  try {
    if (bound) {
      rows = await query`
        SELECT id, encrypted_key, iv, auth_tag, base_url
        FROM api_keys
        WHERE id = ${row.key_id as number}
          AND enabled = 1 AND status IN ('healthy', 'unknown')
      ` as unknown as KeyRow[];
    } else {
      rows = await query`
        SELECT id, encrypted_key, iv, auth_tag, base_url
        FROM api_keys
        WHERE platform = ${row.platform}
          AND enabled = 1 AND status IN ('healthy', 'unknown')
        ORDER BY RANDOM()
      ` as unknown as KeyRow[];
    }
  } catch {
    return { credential: null, budgetBlocked: false };
  }

  let budgetBlocked = false;
  for (const keyRow of rows) {
    if (skip(keyRow.id)) continue;
    // Decrypt the key's secret via Web Crypto (async on Deno Deploy).
    let secret: string;
    try {
      secret = await decryptKey(
        keyRow.encrypted_key,
        keyRow.iv,
        keyRow.auth_tag,
      );
    } catch {
      continue; // ciphertext unreadable / wrong encryption key — try next key
    }
    const reservation = await reserveMonthlyBudget(keyRow.id, estimatedTokens);
    if (!reservation.allowed) {
      budgetBlocked = true;
      continue;
    }
    return {
      credential: {
        id: keyRow.id,
        key: secret,
        baseUrl: keyRow.base_url?.trim().replace(/\/+$/, "") ?? null,
        release: reservation.release ?? (() => {}),
      },
      budgetBlocked,
    };
  }
  return { credential: null, budgetBlocked };
}
