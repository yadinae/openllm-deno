/**
 * key-budget.ts — per-key monthly budget caps (#1158 parity).
 *
 * Optional request/token caps per api_keys row, enforced against the CURRENT
 * UTC month's successful usage. A key at its cap returns `quota_exceeded` (429)
 * with a Retry-After of "seconds until the next month" — the GateLLM-style
 * rejection so an agent knows when the window resets instead of hammering a
 * 429.
 *
 * Successful usage is retained in `key_monthly_usage` independently of analytics
 * retention. Active requests reserve their estimated tokens until completion,
 * even if a stream outlives the short rate-limit lease timeout. Caps are opt-in
 * (0 = unlimited) and reset on UTC month boundaries.
 *
 * Ported from FreeLLMAPI services/key-budget.js (102 lines).
 */

import { query, queryRaw, initDb } from "../db/pg.ts";

function utcNextMonthStartMs(now = Date.now()): number {
  const d = new Date(now);
  const month = d.getUTCMonth() + 1;
  return Date.UTC(d.getUTCFullYear() + Math.floor(month / 12), month % 12, 1);
}

function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** Seconds from `now` until the next UTC month boundary. */
export function secondsUntilNextMonth(now = Date.now()): number {
  return Math.max(1, Math.floor((utcNextMonthStartMs(now) - now) / 1000));
}

/** ISO timestamp of the next UTC month boundary (for headers / diagnostics). */
export function nextMonthResetAt(now = Date.now()): string {
  return new Date(utcNextMonthStartMs(now)).toISOString();
}

export interface MonthlyBudgetCaps {
  requestCap: number;
  tokenCap: number;
}

export async function getMonthlyBudgetCaps(keyId: number): Promise<MonthlyBudgetCaps> {
  try {
    await initDb();
    const rows = await query`
      SELECT monthly_request_cap, monthly_token_cap FROM api_keys WHERE id = ${keyId}
    `;
    const r = rows[0] as any;
    if (!r) return { requestCap: 0, tokenCap: 0 };
    return {
      requestCap: Number(r.monthly_request_cap ?? 0),
      tokenCap: Number(r.monthly_token_cap ?? 0),
    };
  } catch {
    return { requestCap: 0, tokenCap: 0 };
  }
}

export async function setMonthlyBudgetCaps(
  keyId: number,
  patch: { requestCap?: number; tokenCap?: number }
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.requestCap !== undefined) {
    sets.push("monthly_request_cap = $1");
    values.push(patch.requestCap);
  }
  if (patch.tokenCap !== undefined) {
    sets.push("monthly_token_cap = $2");
    values.push(patch.tokenCap);
  }
  if (sets.length === 0) return false;
  values.push(keyId);
  await queryRaw(
    `UPDATE api_keys SET ${sets.join(", ")} WHERE id = $${values.length}`,
    values
  );
  return true;
}

export interface MonthlyUsage {
  requests: number;
  tokens: number;
}

export async function getMonthlyUsage(keyId: number, now = Date.now()): Promise<MonthlyUsage> {
  try {
    await initDb();
    const rows = await query`
      SELECT requests, tokens FROM key_monthly_usage
      WHERE key_id = ${keyId} AND month = ${monthKey(now)}
    `;
    const r = rows[0] as any;
    return { requests: Number(r?.requests ?? 0), tokens: Number(r?.tokens ?? 0) };
  } catch {
    return { requests: 0, tokens: 0 };
  }
}

export interface MonthlyBudgetVerdict {
  allowed: boolean;
  reason?: "monthly_request_cap" | "monthly_token_cap";
  retryAfterSec?: number;
  release?: () => void;
}

/** Active reservations survive in-process so a stream outliving the lease
 * timeout still counts. Restarted process has none (DB holds settled usage).
 * One shared set: a WeakMap keyed on a throwaway object would never share. */
const activeReservationSet = new Set<{ keyId: number; tokens: number }>();

function activeReservations(): Set<{ keyId: number; tokens: number }> {
  return activeReservationSet;
}

/**
 * Check a key against its monthly caps, taking the current month's successful
 * usage plus the tokens THIS request would add.
 */
export async function checkMonthlyBudget(
  keyId: number,
  estimatedTokens: number,
  now = Date.now()
): Promise<MonthlyBudgetVerdict> {
  const caps = await getMonthlyBudgetCaps(keyId);
  if (caps.requestCap <= 0 && caps.tokenCap <= 0) return { allowed: true };
  const usage = await getMonthlyUsage(keyId, now);
  for (const reservation of activeReservations()) {
    if (reservation.keyId !== keyId) continue;
    usage.requests++;
    usage.tokens += reservation.tokens;
  }
  if (caps.requestCap > 0 && usage.requests >= caps.requestCap) {
    return { allowed: false, reason: "monthly_request_cap", retryAfterSec: secondsUntilNextMonth(now) };
  }
  if (caps.tokenCap > 0 && (usage.tokens >= caps.tokenCap || usage.tokens + Math.max(0, estimatedTokens) > caps.tokenCap)) {
    return { allowed: false, reason: "monthly_token_cap", retryAfterSec: secondsUntilNextMonth(now) };
  }
  return { allowed: true };
}

/**
 * Check and reserve synchronously before dispatch; release on every terminal
 * path. Returns `release` only when allowed.
 */
export async function reserveMonthlyBudget(
  keyId: number,
  estimatedTokens: number,
  now = Date.now()
): Promise<MonthlyBudgetVerdict> {
  const verdict = await checkMonthlyBudget(keyId, estimatedTokens, now);
  if (!verdict.allowed) return verdict;
  const active = activeReservations();
  const reservation = { keyId, tokens: Math.max(0, estimatedTokens) };
  active.add(reservation);
  return {
    allowed: true,
    release: () => {
      active.delete(reservation);
    },
  };
}

/** Record settled successful usage for a completed request. */
export async function settleMonthlyUsage(
  keyId: number,
  promptTokens: number,
  completionTokens: number,
  now = Date.now()
): Promise<void> {
  try {
    await initDb();
    const month = monthKey(now);
    await query`
      INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
      VALUES (${keyId}, ${month}, 1, ${promptTokens + completionTokens})
      ON CONFLICT (key_id, month) DO UPDATE SET
        requests = key_monthly_usage.requests + 1,
        tokens   = key_monthly_usage.tokens + ${promptTokens + completionTokens}
    `;
  } catch { /* best-effort */ }
}