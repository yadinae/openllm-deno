/**
 * Shared hook for every provider adapter to record upstream quota observations
 * (rate-limit headers, retry-after, error-body hints) into provider-quota.ts.
 *
 * This is the P1 port of FreeLLMAPI's per-adapter `recordQuotaObservationsFromResponse`
 * wiring. Without it the quota table stays empty, `getKeyQuotaHeadroom()` always
 * returns 1 (unknown), and the router's `combinedHeadroom` is a no-op.
 *
 * Usage in every adapter.chat(), right after `const latency_ms = Date.now() - startTime;`:
 *
 *   import { recordUpstreamQuota } from "./quota-observation.ts";
 *   ...
 *   recordUpstreamQuota(key, platform, modelId, res.status, res.headers, {
 *     endpoint: "/chat/completions",
 *     origin: "proxy",
 *   });
 *
 * Fire-and-forget: a DB hiccup must never turn a successful upstream call into
 * a 5xx, so the call is detached and errors are swallowed.
 */

import type { ApiKey } from "./types.ts";
import { recordQuotaObservationsFromResponse } from "../services/provider-quota.ts";

export interface RecordUpstreamQuotaOptions {
  endpoint?: string | null;
  origin?: "health" | "proxy" | "responses" | "manual" | "probe";
  modelId?: string | null;
}

/**
 * `fetch` exposes headers as a Headers object; convert to a plain record for the
 * parser (which reads `response.headers[name]`). Lower-case keys only.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

export function recordUpstreamQuota(
  key: ApiKey,
  platform: string,
  modelId: string | undefined | null,
  status: number,
  headers: Headers | Record<string, string>,
  options: RecordUpstreamQuotaOptions = {}
): void {
  const h = headers instanceof Headers ? headersToRecord(headers) : headers;
  // Detached: quota observation is best-effort analytics, never a request blocker.
  recordQuotaObservationsFromResponse(
    { status, headers: h },
    {
      platform,
      keyId: key.db_id,
      providerAccountId: key.label ?? null,
      modelId: modelId ?? null,
      endpoint: options.endpoint ?? null,
    }
  ).catch(() => { /* swallow */ });
}