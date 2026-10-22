/**
 * quota-forecast.ts — Daily free-tier balance forecast (#1104 parity).
 *
 * Ported from FreeLLMAPI services/quota-forecast.ts.
 *
 * Aggregates provider quota observations (`provider_quota_state`) and recent
 * successful request activity (`requests` table) into per-pool forecasts.
 * No new tables, no extra probes — pure aggregation over existing data.
 *
 * Answers: "Can I keep calling this platform for the rest of today?"
 * Plus: low-balance warning an agent can gate on BEFORE sending a request that would 429.
 */

import { query, initDb } from "../db/pg.ts";
import { inferPoolForPlatform, getQuotaStateForKeys, type QuotaObservationView } from "./provider-quota.ts";

// ── Thresholds (matching FreeLLMAPI) ────────────────────────────────────────

/** <10% of the daily window left → warn */
export const LOW_BALANCE_THRESHOLD = 0.1;

/** ...or fewer than 20 requests left */
export const LOW_BALANCE_ABSOLUTE = 20;

/** The absolute floor only applies when the window is at least this large.
 *  "20 left" is alarming out of 14400/day but unremarkable out of 30/day.
 *  Below this limit the percentage rule alone decides.
 */
export const LOW_BALANCE_ABSOLUTE_MIN_LIMIT = 200;

/** Rate observation window: look at requests in the last N minutes to estimate
 *  current consumption speed. Ten minutes covers bursty usage while ignoring
 *  sub-hour lulls; shorter windows would jitter, longer ones would lag.
 */
export const RATE_OBSERVATION_WINDOW_MINUTES = 10;

/** Minimum observed requests in the window to trust the rate. */
export const MIN_FORECAST_REQUESTS = 3;

// ── Types ────────────────────────────────────────────────────────────────────

export interface QuotaForecastEntry {
  /** Platform the pool belongs to, e.g. 'groq'. */
  platform: string;

  /** Human-readable pool label (platform::scope), e.g. 'groq::shared'. */
  pool: string;

  /** Requests used in the current window. Null when `remaining` is unknown,
   *  since used is only ever derived from it. */
  used: number | null;

  /** Requests remaining in the current window. Null when unknown. */
  remaining: number | null;

  /** Window total. Null when the provider never reported a limit. */
  limit: number | null;

  /** 0..100 share of the window still available (best-effort). */
  remaining_pct: number | null;

  /** ISO timestamp of the window reset, or null when never observed. */
  reset_at: string | null;

  /** True when less than LOW_BALANCE_THRESHOLD of the window remains, or —
   *  on a window of at least LOW_BALANCE_ABSOLUTE_MIN_LIMIT — fewer than
   *  LOW_BALANCE_ABSOLUTE requests do. Always false when remaining is unknown. */
  low_balance: boolean;

  /** Seconds until reset_at, or null when reset_at is unknown/expired. */
  seconds_until_reset: number | null;

  /** Observed request rate in the last `RATE_OBSERVATION_WINDOW_MINUTES` minutes,
   *  or null when there is not enough recent request volume to estimate honestly.
   *  Non-null values are rounded to 2 decimal places. */
  rate_per_min: number | null;

  /** ISO timestamp of when the current window is expected to be exhausted at the
   *  observed rate, or null when the rate is too low / unknown to predict.
   *  A pool whose window has already expired or whose remaining is unknown is excluded. */
  estimated_exhaustion_at: string | null;
}

export interface RecentQuotaActivity {
  platform: string;
  keyId: number | null;
  pool: string;
  count: number;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function secondsUntilReset(resetAt: string | null): number | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
}

/** Convert JS Date to SQLite UTC string: 'YYYY-MM-DD HH:MM:SS' */
function toSqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Check if a quota observation row is usable for forecasting. */
function unavailableReason(
  row: QuotaObservationView,
  now: number,
): "quota_not_reported" | "stale_observation" | "low_confidence" | "reset_not_reported" | null {
  if (
    row.limitValue == null ||
    !Number.isFinite(row.limitValue) ||
    row.limitValue <= 0 ||
    row.remainingValue == null ||
    !Number.isFinite(row.remainingValue) ||
    row.remainingValue < 0 ||
    row.remainingValue > row.limitValue
  ) {
    return "quota_not_reported";
  }

  const observed = Date.parse(
    row.observedAt.includes("T") ? row.observedAt : row.observedAt.replace(" ", "T") + "Z",
  );
  const reset = row.resetAt
    ? Date.parse(
        row.resetAt.includes("T") ? row.resetAt : row.resetAt.replace(" ", "T") + "Z",
      )
    : NaN;

  const MAX_OBSERVATION_AGE_MS = RATE_OBSERVATION_WINDOW_MINUTES * 60_000;

  if (
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > MAX_OBSERVATION_AGE_MS ||
    (Number.isFinite(reset) && reset <= now)
  ) {
    return "stale_observation";
  }

  const conf = row.confidence;
  if (conf == null || !Number.isFinite(conf) || conf < 0.7) {
    return "low_confidence";
  }

  return Number.isFinite(reset) ? null : "reset_not_reported";
}

/** Estimate exhaustion timestamp from remaining + rate + reset. */
export function estimateExhaustionAt(
  remaining: number,
  ratePerMin: number | null,
  resetAt: string | null,
  now: number,
): string | null {
  if (ratePerMin === null || ratePerMin <= 0) return null;
  if (remaining <= 0) return new Date(now).toISOString();

  const minutesUntilEmpty = remaining / ratePerMin;
  const secondsFromNow = Math.ceil(minutesUntilEmpty * 60);
  const exhaustionMs = now + secondsFromNow * 1000;

  const resetMs = resetAt ? new Date(resetAt).getTime() : NaN;
  if (Number.isFinite(resetMs) && exhaustionMs >= resetMs) {
    // Would exhaust after the window resets — not a useful prediction.
    return null;
  }

  return new Date(exhaustionMs).toISOString();
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Recent successful traffic grouped by the same key/pool identity used for observations. */
export async function getRecentQuotaActivity(now = Date.now()): Promise<RecentQuotaActivity[]> {
  try {
// await 而不是 initDb(); —— 该 promise 会 reject，飘着的 rejection 会让 Deno 直接终止 isolate
    await initDb();
    const since = toSqliteUtc(now - RATE_OBSERVATION_WINDOW_MINUTES * 60_000);
    const rows = await query`
      SELECT platform, key_id AS "keyId", model_id AS "modelId", COUNT(*) AS count
      FROM requests
      WHERE created_at >= ${since}
        AND datetime(created_at) >= ${since}
        AND datetime(created_at) <= ${toSqliteUtc(now)}
        AND status_code = 200
      GROUP BY platform, key_id, model_id
    `;

    return rows.map((row: any) => ({
      platform: row.platform,
      keyId: row.keyId ? Number(row.keyId) : null,
      pool: inferPoolForPlatform(row.platform, row.modelId ?? null),
      count: Number(row.count),
    }));
  } catch {
    return [];
  }
}

/**
 * Main forecast function: aggregates quota observations + recent activity
 * into per-pool entries the dashboard / agents can consume.
 *
 * Accepts pre-fetched rows for testing; otherwise fetches from DB.
 */
export async function getQuotaForecast(
  rowsOrNull: QuotaObservationView[] | null = null,
  now = Date.now(),
): Promise<QuotaForecastEntry[]> {
  const rows = rowsOrNull ?? (await getQuotaStateForKeys({ normalizeExpired: false }));

  // 1) Local activity (measurable even without provider quota headers)
  const activity = await getRecentQuotaActivity(now);
  const activityByPool = new Map<string, number>();
  for (const a of activity) {
    activityByPool.set(a.pool, (activityByPool.get(a.pool) ?? 0) + a.count);
  }

  // 2) Select the best observation per pool
  // Priority: usable (no reason) > reset_not_reported > stale > quota_not_reported > low_confidence
  // Among usable: tightest remaining_pct (rounded to nearest %)
  const selected = new Map<string, QuotaObservationView>();
  const rank = (row: QuotaObservationView) => {
    const reason = unavailableReason(row, now);
    if (reason === null) return 0;
    if (reason === "reset_not_reported") return 1;
    if (reason === "stale_observation") return 2;
    if (reason === "quota_not_reported") return 3;
    return 4; // low_confidence
  };

  const score = (row: QuotaObservationView): number => {
    if (
      row.limitValue != null &&
      row.limitValue > 0 &&
      row.remainingValue != null
    ) {
      return Math.round((row.remainingValue / row.limitValue) * 100);
    }
    return Infinity;
  };

  // Only consider 'requests' metric for the dashboard forecast
  for (const row of rows) {
    if (row.metric !== "requests") continue;
    const poolKey = row.quotaPoolKey ?? "unknown";
    const existing = selected.get(poolKey);
    const r = rank(row);
    const e = existing ? rank(existing) : Infinity;

    if (!existing || r < e || (r === e && score(row) < score(existing))) {
      selected.set(poolKey, row);
    }
  }

  // 3) Build forecast entries
  const entries: QuotaForecastEntry[] = [];

  for (const row of selected.values()) {
    const reason = unavailableReason(row, now);
    const poolKey = row.quotaPoolKey ?? "unknown";
    const activityCount = activityByPool.get(poolKey) ?? 0;
    const rate = Math.round((activityCount / RATE_OBSERVATION_WINDOW_MINUTES) * 100) / 100;
    const known = reason !== "quota_not_reported";

    const resetMs = row.resetAt
      ? Date.parse(
          row.resetAt.includes("T")
            ? row.resetAt
            : row.resetAt.replace(" ", "T") + "Z",
        )
      : NaN;
    const resetAt = Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null;

    const remaining = row.remainingValue;
    const limit = row.limitValue;
    const used = limit != null && remaining != null ? limit - remaining : null;

    const remaining_pct =
      limit != null && limit > 0 && remaining != null
        ? Math.round((remaining / limit) * 1000) / 10 // 0.1% precision
        : null;

    // Low balance: <10% remaining OR (<20 absolute AND limit >= 200)
    const low_balance =
      remaining != null &&
      limit != null &&
      limit > 0 &&
      (remaining_pct != null && remaining_pct < LOW_BALANCE_THRESHOLD * 100 ||
        (limit >= LOW_BALANCE_ABSOLUTE_MIN_LIMIT && remaining < LOW_BALANCE_ABSOLUTE));

    const seconds_until_reset = secondsUntilReset(resetAt);
    const exhaustion = estimateExhaustionAt(remaining ?? 0, rate, resetAt, now);

    entries.push({
      platform: row.platform,
      pool: poolKey,
      used,
      remaining,
      limit,
      remaining_pct,
      reset_at: resetAt,
      low_balance,
      seconds_until_reset,
      rate_per_min: rate > 0 ? rate : null,
      estimated_exhaustion_at: exhaustion,
    });
  }

  // Sort: low_balance first, then by remaining_pct ascending (tightest first)
  entries.sort((a, b) => {
    if (a.low_balance !== b.low_balance) return a.low_balance ? -1 : 1;
    const pa = a.remaining_pct ?? Infinity;
    const pb = b.remaining_pct ?? Infinity;
    return pa - pb;
  });

  return entries;
}

/**
 * Convenience: get a simple "can I use this platform?" boolean for agents.
 * Returns true when the platform has at least one pool with usable headroom.
 */
export async function hasPlatformQuotaHeadroom(platform: string): Promise<boolean> {
  const forecast = await getQuotaForecast();
  return forecast.some(
    (e) => e.platform === platform && (e.remaining_pct ?? 0) > 0 && !e.low_balance,
  );
}