// ── Provider quota observation (ported from FreeLLMAPI services/provider-quota.ts) ──
//
// Parses upstream rate-limit headers (x-ratelimit-*, x-credits-*, etc.) into
// structured quota observations, records them in `provider_quota_state` /
// `provider_quota_observations`, and exposes a cached headroom view for the
// router. No invented per-model budgets: every limit comes from a real
// upstream header.

import { query, initDb } from "../db/pg.ts";
import { AsyncLocalStorage } from "node:async_hooks";

export interface QuotaObservationContext {
  platform: string;
  keyId?: number;
  providerAccountId?: string | null;
  modelId?: string | null;
  quotaPoolKey?: string | null;
  endpoint?: string | null;
  origin?: "health" | "proxy" | "responses" | "manual" | "probe";
}

export interface QuotaObservationInput {
  platform?: string;
  keyId?: number;
  providerAccountId?: string | null;
  modelId?: string | null;
  quotaPoolKey?: string | null;
  metric?: QuotaMetric;
  limit?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  retryAfterMs?: number | null;
  resetStrategy?: QuotaResetStrategy;
  source?: QuotaObservationSource;
  statusCode?: number | null;
  notes?: string | null;
  rawJson?: string | null;
  endpoint?: string | null;
  confidence?: number;
  observedAt?: string;
}

export interface QuotaObservationView {
  platform: string;
  keyId: number;
  providerAccountId: string | null;
  modelId: string | null;
  quotaPoolKey: string | null;
  metric: QuotaMetric;
  limitValue: number | null;
  remainingValue: number | null;
  resetAt: string | null;
  resetStrategy: QuotaResetStrategy | null;
  source: QuotaObservationSource | null;
  confidence: number | null;
  notes: string | null;
  statusCode: number | null;
  retryAfterMs: number | null;
  rawJson: string | null;
  endpoint: string | null;
  observedAt: string;
  createdAt: string;
}

export type QuotaMetric = "requests" | "tokens" | "credits" | "characters";
export type QuotaObservationSource = "header" | "quota_api" | "error_body" | "local_usage" | "documentation" | "probe";
export type QuotaResetStrategy = "provider_reported" | "token_bucket" | "unknown";

const contextStore = new AsyncLocalStorage<QuotaObservationContext>();

const DEFAULT_CONFIDENCE: Record<QuotaObservationSource, number> = {
  header: 1,
  quota_api: 1,
  error_body: 0.75,
  local_usage: 0.45,
  documentation: 0.35,
  probe: 0.6,
};

export function runWithQuotaObservationContext<T>(context: QuotaObservationContext, fn: () => T): T {
  return contextStore.run(context, fn);
}

export function getQuotaObservationContext(): QuotaObservationContext | undefined {
  return contextStore.getStore();
}

function isoNow(): string {
  return new Date().toISOString();
}

function toSqliteUtc(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseHeaderNumber(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function parseResetAtFromHeader(raw: string | null, now = Date.now()): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    milliseconds = parsed > 1_000_000_000_000 ? parsed
      : parsed > 1_000_000_000 ? parsed * 1000 : now + parsed * 1000;
  } else if (/^(?:\d+(?:\.\d+)?(?:ms|[dhms]))+$/.test(value)) {
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
    milliseconds = 0;
    const matches = value.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g);
    for (const m of matches) {
      milliseconds += Number(m[1]) * units[m[2]];
    }
  } else {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

// ── Header specs per platform (live-observed headers only) ──────────────────
interface HeaderSpec {
  metric: QuotaMetric;
  limit: string;
  remaining?: string;
  reset?: string;
  strategy?: QuotaResetStrategy;
}

const HEADER_SPECS: Record<string, HeaderSpec[]> = {
  openai: [
    { metric: "requests", limit: "x-ratelimit-limit-requests", remaining: "x-ratelimit-remaining-requests", reset: "x-ratelimit-reset-requests", strategy: "provider_reported" },
    { metric: "tokens", limit: "x-ratelimit-limit-tokens", remaining: "x-ratelimit-remaining-tokens", reset: "x-ratelimit-reset-tokens", strategy: "provider_reported" },
  ],
  groq: [
    { metric: "requests", limit: "x-ratelimit-limit-requests", remaining: "x-ratelimit-remaining-requests", reset: "x-ratelimit-reset-requests", strategy: "provider_reported" },
    { metric: "tokens", limit: "x-ratelimit-limit-tokens", remaining: "x-ratelimit-remaining-tokens", reset: "x-ratelimit-reset-tokens", strategy: "provider_reported" },
  ],
  cerebras: [
    { metric: "requests", limit: "x-ratelimit-limit-requests-day", remaining: "x-ratelimit-remaining-requests-day", reset: "x-ratelimit-reset-requests-day", strategy: "provider_reported" },
    { metric: "tokens", limit: "x-ratelimit-limit-tokens-minute", remaining: "x-ratelimit-remaining-tokens-minute", reset: "x-ratelimit-reset-tokens-minute", strategy: "token_bucket" },
  ],
  openrouter: [
    { metric: "requests", limit: "x-ratelimit-limit-requests", remaining: "x-ratelimit-remaining-requests", reset: "x-ratelimit-reset-requests", strategy: "provider_reported" },
    { metric: "tokens", limit: "x-ratelimit-limit-tokens", remaining: "x-ratelimit-remaining-tokens", reset: "x-ratelimit-reset-tokens", strategy: "provider_reported" },
  ],
  electronhub: [
    { metric: "requests", limit: "x-ratelimit-limit", remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset", strategy: "provider_reported" },
  ],
  nvidia: [
    { metric: "requests", limit: "x-ratelimit-limit-user-rpm", remaining: "x-ratelimit-remaining-user-rpm", reset: "x-ratelimit-reset", strategy: "provider_reported" },
    { metric: "credits", limit: "x-ratelimit-limit-user-daily-usd", remaining: "x-ratelimit-remaining-user-daily-usd", reset: "x-ratelimit-reset-user-daily-usd", strategy: "provider_reported" },
  ],
  ollama: [
    // Local: no upstream quota headers. Probe-only observations.
  ],
  anthropic: [
    { metric: "requests", limit: "x-ratelimit-limit-requests", remaining: "x-ratelimit-remaining-requests", reset: "x-ratelimit-reset-requests", strategy: "provider_reported" },
    { metric: "tokens", limit: "x-ratelimit-limit-tokens", remaining: "x-ratelimit-remaining-tokens", reset: "x-ratelimit-reset-tokens", strategy: "provider_reported" },
  ],
  gemini: [
    { metric: "requests", limit: "x-ratelimit-limit-requests", remaining: "x-ratelimit-remaining-requests", reset: "x-ratelimit-reset-requests", strategy: "provider_reported" },
    { metric: "tokens", limit: "x-ratelimit-limit-tokens", remaining: "x-ratelimit-remaining-tokens", reset: "x-ratelimit-reset-tokens", strategy: "provider_reported" },
  ],
};

// ── Pool inference ──────────────────────────────────────────────────────────
export function inferPoolForPlatform(platform: string, modelId?: string | null): string {
  // Shared pools: all models share the same account quota.
  const SHARED: Record<string, string> = {
    openai: "shared",
    groq: "shared",
    cerebras: "shared",
    openrouter: "shared",
    electronhub: "shared",
    nvidia: "shared",
    ollama: "shared",
    anthropic: "shared",
    gemini: "shared",
  };
  return SHARED[platform] ?? (modelId ? `model:${modelId}` : "shared");
}

export function inferQuotaPoolKey(platform: string, modelId?: string | null): string {
  return inferPoolForPlatform(platform, modelId);
}

// ── Parse observations from HTTP response headers ──────────────────────────
export function parseQuotaObservationsFromResponse(
  response: { status: number; headers: Record<string, string> },
  opts: Pick<QuotaObservationInput, "platform" | "modelId" | "quotaPoolKey" | "keyId" | "providerAccountId" | "endpoint"> = {},
): QuotaObservationInput[] {
  const platform = opts.platform;
  if (!platform) return [];

  const get = (name: string): string | null => response.headers[name] ?? null;
  const observations: QuotaObservationInput[] = [];
  const specs = HEADER_SPECS[platform];
  if (specs) {
    for (const spec of specs) {
      maybeAddObservation(observations, {
        platform,
        keyId: opts.keyId,
        providerAccountId: opts.providerAccountId,
        modelId: opts.modelId,
        quotaPoolKey: opts.quotaPoolKey,
        endpoint: opts.endpoint,
        metric: spec.metric,
        limit: parseHeaderNumber(get(spec.limit)),
        remaining: spec.remaining ? parseHeaderNumber(get(spec.remaining)) : null,
        resetAt: spec.reset ? parseResetAtFromHeader(get(spec.reset)) : null,
        resetStrategy: spec.strategy ?? "provider_reported",
        source: "header",
        statusCode: response.status,
      });
    }
  }

  // Fallback: x-ratelimit-limit-{requests,tokens} for compatible providers
  for (const metric of ["requests", "tokens"] as const) {
    if (!observations.some((r) => r.metric === metric)) {
      maybeAddObservation(observations, {
        platform,
        keyId: opts.keyId,
        providerAccountId: opts.providerAccountId,
        modelId: opts.modelId,
        quotaPoolKey: opts.quotaPoolKey,
        endpoint: opts.endpoint,
        metric,
        limit: parseHeaderNumber(get(`x-ratelimit-limit-${metric}`)),
        remaining: parseHeaderNumber(get(`x-ratelimit-remaining-${metric}`)),
        resetAt: parseResetAtFromHeader(get(`x-ratelimit-reset-${metric}`)),
        resetStrategy: "provider_reported",
        source: "header",
        statusCode: response.status,
      });
    }
  }

  // 429/402 with no quota headers → low-confidence error evidence
  const retryAfterMs = parseRetryAfterMs(get("retry-after")) ?? null;
  if ((response.status === 429 || response.status === 402)
      && !observations.some((r) => r.metric === "requests" && r.remaining != null)) {
    observations.push({
      platform,
      keyId: opts.keyId,
      providerAccountId: opts.providerAccountId,
      modelId: opts.modelId,
      quotaPoolKey: opts.quotaPoolKey,
      endpoint: opts.endpoint,
      metric: "requests",
      limit: null,
      remaining: 0,
      resetAt: retryAfterMs == null ? null : new Date(Date.now() + retryAfterMs).toISOString(),
      retryAfterMs,
      resetStrategy: "unknown",
      source: "error_body",
      confidence: 0.55,
      notes: response.status === 402 ? "upstream payment/credit exhaustion" : "rate limited",
      statusCode: response.status,
    });
  }

  return observations;
}

function maybeAddObservation(
  observations: QuotaObservationInput[],
  base: QuotaObservationInput,
): void {
  if (!base.limit && base.remaining === null) return;
  observations.push(base);
}

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim();
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1_000_000 ? n : n * 1000;
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let total = 0;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)) {
    total += Number(m[1]) * units[m[2]];
  }
  return total > 0 ? total : null;
}

// ── Record quota observation ────────────────────────────────────────────────
export async function recordQuotaObservation(input: QuotaObservationInput): Promise<QuotaObservationView | null> {
  const context = getQuotaObservationContext();
  const platform = input.platform ?? context?.platform;
  if (!platform) return null;

  const keyId = input.keyId ?? context?.keyId ?? 0;
  const quotaPoolKey = input.quotaPoolKey ?? context?.quotaPoolKey ?? inferPoolForPlatform(platform, input.modelId ?? context?.modelId);
  const metric = input.metric ?? "requests";
  const source = input.source ?? "probe";
  const resetStrategy = input.resetStrategy ?? "unknown";
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE[source];
  const observedAt = input.observedAt ?? isoNow();
  const limitValue = input.limit ?? null;
  const remainingValue = input.remaining ?? null;
  const resetAt = input.resetAt ?? null;
  const retryAfterMs = input.retryAfterMs ?? null;
  const notes = input.notes ?? null;
  const providerAccountId = input.providerAccountId ?? context?.providerAccountId ?? null;
  const modelId = input.modelId ?? context?.modelId ?? null;
  const endpoint = input.endpoint ?? context?.endpoint ?? null;
  const statusCode = input.statusCode ?? null;
  const rawJson = input.rawJson ?? null;

  try {
    initDb();
    const nowSql = toSqliteUtc(observedAt);
    const updatedAt = nowSql;

    await query`
      INSERT INTO provider_quota_state (
        platform, key_id, quota_pool_key, metric, limit_value, remaining_value,
        reset_at, reset_strategy, source, confidence, notes, observed_at, updated_at
      ) VALUES (${platform}, ${keyId}, ${quotaPoolKey}, ${metric}, ${limitValue}, ${remainingValue},
        ${resetAt}, ${resetStrategy}, ${source}, ${confidence}, ${notes}, ${nowSql}, ${updatedAt})
      ON CONFLICT(platform, key_id, quota_pool_key, metric) DO UPDATE SET
        limit_value = excluded.limit_value,
        remaining_value = excluded.remaining_value,
        reset_at = excluded.reset_at,
        reset_strategy = excluded.reset_strategy,
        source = excluded.source,
        confidence = excluded.confidence,
        notes = excluded.notes,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
      WHERE excluded.remaining_value IS NOT NULL
        AND (provider_quota_state.remaining_value IS NULL
          OR provider_quota_state.observed_at <= excluded.observed_at)
    `;

    await query`
      INSERT INTO provider_quota_observations (
        id, platform, key_id, provider_account_id, model_id, quota_pool_key, metric,
        status_code, limit_value, remaining_value, reset_at, retry_after_ms,
        reset_strategy, source, confidence, notes, raw_json, endpoint, observed_at, created_at
      ) VALUES (gen_random_uuid(), ${platform}, ${keyId}, ${providerAccountId}, ${modelId}, ${quotaPoolKey}, ${metric},
        ${statusCode}, ${limitValue}, ${remainingValue}, ${resetAt}, ${retryAfterMs},
        ${resetStrategy}, ${source}, ${confidence}, ${notes}, ${rawJson}, ${endpoint}, ${nowSql}, ${nowSql})
    `;

    invalidateKeyQuotaHeadroom(platform);
  } catch (e) {
    console.error("[quota] recordQuotaObservation failed:", e);
    return null;
  }

  return {
    platform,
    keyId,
    providerAccountId,
    modelId,
    quotaPoolKey,
    metric,
    limitValue,
    remainingValue,
    resetAt,
    resetStrategy,
    source,
    confidence,
    notes,
    statusCode,
    retryAfterMs,
    rawJson,
    endpoint,
    observedAt: toSqliteUtc(observedAt),
    createdAt: toSqliteUtc(observedAt),
  };
}

export async function recordQuotaObservationsFromResponse(
  response: { status: number; headers: Record<string, string> },
  opts: Pick<QuotaObservationInput, "platform" | "modelId" | "quotaPoolKey" | "keyId" | "providerAccountId" | "endpoint"> = {},
): Promise<QuotaObservationView[]> {
  const observations = parseQuotaObservationsFromResponse(response, opts);
  const results = await Promise.all(observations.map(recordQuotaObservation));
  return results.filter((row): row is QuotaObservationView => row !== null);
}

// ── Headroom view for router ────────────────────────────────────────────────
const HEADROOM_MIN_CONFIDENCE = 0.7;
const HEADROOM_TTL_MS = 5_000;
const headroomCache = new Map<string, { at: number; map: Map<number, number> }>();

export async function getKeyQuotaHeadroom(platform: string): Promise<Map<number, number>> {
  const now = Date.now();
  const cached = headroomCache.get(platform);
  if (cached && now - cached.at < HEADROOM_TTL_MS) return cached.map;

  try {
    initDb();
    const rows = await query`
      SELECT key_id AS keyId,
             limit_value AS limitValue,
             remaining_value AS remainingValue,
             CASE WHEN reset_at IS NOT NULL AND reset_at < ${toSqlNow(now)}
                  THEN 1 ELSE 0 END AS expired
        FROM provider_quota_state
       WHERE platform = ${platform}
         AND confidence >= ${HEADROOM_MIN_CONFIDENCE}
         AND limit_value IS NOT NULL
         AND limit_value > 0
         AND remaining_value IS NOT NULL
    ` as { keyId: number; limitValue: number; remainingValue: number; expired: number }[];

    const map = new Map<number, number>();
    for (const row of rows) {
      const ratio = row.expired
        ? 1
        : Math.max(0, Math.min(1, row.remainingValue / row.limitValue));
      const prev = map.get(row.keyId);
      if (prev === undefined || ratio < prev) map.set(row.keyId, ratio);
    }
    headroomCache.set(platform, { at: now, map });
    return map;
  } catch {
    return new Map();
  }
}

function toSqlNow(now: number): string {
  return new Date(now).toISOString().replace("T", " ").replace("Z", "");
}

export function invalidateKeyQuotaHeadroom(platform?: string): void {
  if (platform) headroomCache.delete(platform);
  else headroomCache.clear();
}

export async function getQuotaStateForKeys(options: { normalizeExpired?: boolean } = {}): Promise<QuotaObservationView[]> {
  try {
    initDb();
    const rows = await query`
      SELECT platform, key_id AS keyId, provider_account_id AS providerAccountId,
             model_id AS modelId, quota_pool_key AS quotaPoolKey, metric,
             limit_value AS limitValue, remaining_value AS remainingValue,
             reset_at AS resetAt, reset_strategy AS resetStrategy,
             source, confidence, notes, status_code AS statusCode,
             retry_after_ms AS retryAfterMs, raw_json AS rawJson,
             endpoint, observed_at AS observedAt, created_at AS createdAt
        FROM provider_quota_state
       WHERE confidence >= ${HEADROOM_MIN_CONFIDENCE}
       ORDER BY platform, key_id, metric
    ` as QuotaObservationView[];
    return rows;
  } catch {
    return [];
  }
}