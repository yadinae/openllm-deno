// ── Bandit routing score (ported from FreeLLMAPI services/scoring.ts) ─────────
//
// Three-axis weights (reliability, speed, intelligence) with four presets.
// Peak-hours adjustment, task-type bias, Beta posterior reliability,
// throughput+TTFB speed, tier+sqrt(rank) intelligence, headroom guardrails,
// rate-limit penalty, Thompson sampling.
//
// This is the SINGLE source of truth for all routing scores. The old hardcoded
// 4-axis weights in router.ts are removed.

export interface RoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
}

export type RoutingStrategy =
  | 'priority'
  | 'balanced'
  | 'smartest'
  | 'fastest'
  | 'reliable'
  | 'custom'
  | 'decision';

export type PresetStrategy = 'balanced' | 'smartest' | 'fastest' | 'reliable';

export type KeySelectionStrategy = 'auto' | 'least-remaining';

export const BANDIT_PRESETS: Record<PresetStrategy, RoutingWeights> = {
  balanced: { reliability: 0.5, speed: 0.25, intelligence: 0.25 },
  smartest: { reliability: 0.35, speed: 0.1, intelligence: 0.55 },
  fastest: { reliability: 0.35, speed: 0.55, intelligence: 0.1 },
  reliable: { reliability: 0.7, speed: 0.15, intelligence: 0.15 },
};

export const DEFAULT_STRATEGY: RoutingStrategy = 'balanced';

// ── Peak-hours dynamic ranking ──────────────────────────────────────────────
export interface PeakHoursConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
}

export const DEFAULT_PEAK_START_HOUR = 18;
export const DEFAULT_PEAK_END_HOUR = 6;
export const DEFAULT_PEAK_TIMEZONE = 'UTC';
export const PEAK_SPEED_TO_RELIABILITY = 0.6;

export const DEFAULT_PEAK_HOURS: PeakHoursConfig = {
  enabled: false,
  startHour: DEFAULT_PEAK_START_HOUR,
  endHour: DEFAULT_PEAK_END_HOUR,
  timezone: DEFAULT_PEAK_TIMEZONE,
};

export const PEAK_EXEMPT_STRATEGIES: readonly RoutingStrategy[] = [
  'fastest',
  'reliable',
];

export function isPeakExemptStrategy(strategy: RoutingStrategy): boolean {
  return PEAK_EXEMPT_STRATEGIES.includes(strategy);
}

export function isValidPeakHour(hour: unknown): hour is number {
  return typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function hourInTimezone(now: Date, timezone: string): number {
  const zone = isValidTimezone(timezone) ? timezone : DEFAULT_PEAK_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const raw = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed % 24 : 0;
}

export function isPeakHours(config: PeakHoursConfig, now = new Date()): boolean {
  if (!config.enabled) return false;
  if (!isValidPeakHour(config.startHour) || !isValidPeakHour(config.endHour)) return false;
  if (config.startHour === config.endHour) return false;
  const h = hourInTimezone(now, config.timezone);
  return config.startHour < config.endHour
    ? h >= config.startHour && h < config.endHour
    : h >= config.startHour || h < config.endHour;
}

export function peakAdjustedWeights(
  base: RoutingWeights,
  strategy: RoutingStrategy,
  config: PeakHoursConfig,
  now = new Date(),
): { weights: RoutingWeights; adjusted: boolean } {
  if (isPeakExemptStrategy(strategy)) return { weights: base, adjusted: false };
  if (!isPeakHours(config, now)) return { weights: base, adjusted: false };
  const shift = base.speed * PEAK_SPEED_TO_RELIABILITY;
  if (shift <= 0) return { weights: base, adjusted: false };
  return {
    weights: {
      reliability: base.reliability + shift,
      speed: base.speed - shift,
      intelligence: base.intelligence,
    },
    adjusted: true,
  };
}

// ── Task-type weight bias ───────────────────────────────────────────────────
export const TASK_WEIGHT_SHARE = 0.3;

export const TASK_EXEMPT_STRATEGIES: readonly RoutingStrategy[] = [
  ...PEAK_EXEMPT_STRATEGIES,
  'custom',
];

export function isTaskExemptStrategy(strategy: RoutingStrategy): boolean {
  return TASK_EXEMPT_STRATEGIES.includes(strategy);
}

export function taskAdjustedWeights(
  base: RoutingWeights,
  task: 'code' | 'chat',
  strategy: RoutingStrategy,
  share = TASK_WEIGHT_SHARE,
): { weights: RoutingWeights; adjusted: boolean } {
  if (isTaskExemptStrategy(strategy)) return { weights: base, adjusted: false };
  if (share <= 0) return { weights: base, adjusted: false };
  if (task === 'code') {
    const shift = base.speed * share;
    if (shift <= 0) return { weights: base, adjusted: false };
    return {
      weights: {
        reliability: base.reliability,
        speed: base.speed - shift,
        intelligence: base.intelligence + shift,
      },
      adjusted: true,
    };
  }
  const shift = base.intelligence * share;
  if (shift <= 0) return { weights: base, adjusted: false };
  return {
    weights: {
      reliability: base.reliability,
      speed: base.speed + shift,
      intelligence: base.intelligence - shift,
    },
    adjusted: true,
  };
}

// ── Reliability (Beta posterior + community prior) ──────────────────────────
export const PRIOR_SUCCESS = 1;
export const PRIOR_FAILURE = 1;

export interface CommunityReliabilityPrior {
  successes: number;
  failures: number;
}

export function reliabilityPosterior(
  successes: number,
  failures: number,
  community?: CommunityReliabilityPrior,
): { alpha: number; beta: number } {
  return {
    alpha: Math.max(0, successes) + (community?.successes ?? 0) + PRIOR_SUCCESS,
    beta: Math.max(0, failures) + (community?.failures ?? 0) + PRIOR_FAILURE,
  };
}

export function expectedReliability(
  successes: number,
  failures: number,
  community?: CommunityReliabilityPrior,
): number {
  const { alpha, beta } = reliabilityPosterior(successes, failures, community);
  return alpha / (alpha + beta);
}

// ── Speed (throughput + TTFB) ───────────────────────────────────────────────
export const SPEED_SCALE_TOK_S = 60;
export const TTFB_BEST_MS = 300;
export const TTFB_WORST_MS = 5000;
const THROUGHPUT_WEIGHT = 0.6;
const TTFB_WEIGHT = 0.4;
export const SPEED_PRIOR = 0.6;

export const TIMEOUT_LATENCY_CAP_MS = 120_000;

function throughputScore(tokPerSec: number): number {
  if (tokPerSec <= 0) return 0;
  return 1 - Math.exp(-tokPerSec / SPEED_SCALE_TOK_S);
}

function ttfbScore(ttfbMs: number): number {
  if (ttfbMs <= TTFB_BEST_MS) return 1;
  if (ttfbMs >= TTFB_WORST_MS) return 0;
  return 1 - (ttfbMs - TTFB_BEST_MS) / (TTFB_WORST_MS - TTFB_BEST_MS);
}

export function speedScore(tokPerSec: number, ttfbMs: number | null): number {
  if (tokPerSec <= 0 && ttfbMs === null) return SPEED_PRIOR;
  const tp = throughputScore(tokPerSec);
  if (ttfbMs === null) return tp;
  if (tokPerSec <= 0) return ttfbScore(ttfbMs);
  return THROUGHPUT_WEIGHT * tp + TTFB_WEIGHT * ttfbScore(ttfbMs);
}

// ── Observed speed rank ─────────────────────────────────────────────────────
export const OBSERVED_SPEED_RANK_BEST = 1;
export const OBSERVED_SPEED_RANK_WORST = 10;

export function observedSpeedRank(speed: number): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(speed) ? speed : 0));
  const span = OBSERVED_SPEED_RANK_WORST - OBSERVED_SPEED_RANK_BEST;
  return OBSERVED_SPEED_RANK_BEST + Math.round((1 - s) * span);
}

// ── Intelligence (tier + sqrt(rank)) ────────────────────────────────────────
export const TIER_VALUE: Record<string, number> = {
  Frontier: 4,
  Large: 3,
  Medium: 2,
  Small: 1,
};

export function tierValue(sizeLabel: string): number {
  return TIER_VALUE[sizeLabel] ?? 0;
}

const RANK_SCALE = 31;

export function intelligenceComposite(sizeLabel: string, intelligenceRank: number): number {
  return tierValue(sizeLabel) * 1000 - Math.sqrt(Math.max(1, intelligenceRank)) * RANK_SCALE;
}

export function intelligenceScore(composite: number, min: number, max: number): number {
  if (max <= min) return 1;
  return (composite - min) / (max - min);
}

// Export RANK_SCALE for use in router.ts
export { RANK_SCALE };

// ── Monthly budget label parsing (ported from FreeLLMAPI lib/budget.ts) ─────

/**
 * Parse a human budget label like '~120M', '~50-100M', '~500K' (optionally
 * with period/unit suffixes like '/day', 'rpd') into an absolute token count.
 * Returns 0 meaning "no budget info" — callers treat 0 as no headroom limit.
 *
 * Guards (each learned as a production bug upstream):
 *  - rate labels without a magnitude unit ('free · 40 RPM') are NOT budgets;
 *  - request-count budgets ('14.4K rpd', '1K calls/mo') are NOT token budgets;
 *  - daily caps ('500K tokens/day') scale ×30 into the monthly pool;
 *  - parenthetical rate hints ('~2M (60-100/hr)') are stripped before scanning.
 */
export function parseBudget(s: string): number {
  if (!s) return 0;
  const label = String(s).toLowerCase();
  const head = label.replace(/\([^)]*\)/g, '').trim();
  const m = head.match(/~?([\d.]+)(?:-([\d.]+))?([mk])(?![a-z])/);
  if (!m) return 0;
  const high = parseFloat(m[2] ?? m[1]);
  if (Number.isNaN(high)) return 0;
  const tail = head.slice((m.index ?? 0) + m[0].length);
  if (/^\s*(?:rpd|rpm|rph|rps|req|requests?|calls?|messages?|prompts?|neurons?)\b/.test(tail)) return 0;
  const tokens = high * (m[3] === 'm' ? 1_000_000 : 1_000);
  const period = tail.split(/[,·;]/)[0];
  const perDay = /\b(?:per\s*)?days?\b|\bdaily\b|\b24\s*h(?:rs?|ours?)?\b/.test(period);
  return perDay ? tokens * 30 : tokens;
}

// ── Guardrail: headroom (monthly budget & rate window share same ramp) ──────
export const HEADROOM_FLOOR = 0.1;
export const HEADROOM_RAMP_START = 0.2;

export interface HeadroomThresholds {
  rampStart?: number;
  floor?: number;
}

export function headroomFactor(
  usedTokens: number,
  budgetTokens: number,
  opts?: HeadroomThresholds,
): number {
  if (!budgetTokens || budgetTokens <= 0) return 1;
  return headroomRamp(1 - usedTokens / budgetTokens, opts);
}

export function rateWindowHeadroomFactor(
  usedFraction: number | null,
  opts?: HeadroomThresholds,
): number {
  if (usedFraction === null || !Number.isFinite(usedFraction)) return 1;
  return headroomRamp(1 - usedFraction, opts);
}

function headroomRamp(remainingRaw: number, opts?: HeadroomThresholds): number {
  const rampStart = clampUnit(opts?.rampStart, HEADROOM_RAMP_START);
  const floor = clampUnit(opts?.floor, HEADROOM_FLOOR);
  const remaining = Math.max(0, Math.min(1, remainingRaw));
  if (remaining >= rampStart) return 1;
  return floor + (1 - floor) * (remaining / rampStart);
}

function clampUnit(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

// ── Guardrail: live rate-limit penalty ──────────────────────────────────────
export const MAX_PENALTY = 10;
export const RATE_LIMIT_MAX_DAMP = 0.6;

export function rateLimitFactor(penalty: number): number {
  const p = Math.min(Math.max(0, penalty), MAX_PENALTY);
  return 1 - (p / MAX_PENALTY) * RATE_LIMIT_MAX_DAMP;
}

// ── Beta sampler (Marsaglia & Tsang) ────────────────────────────────────────
function randomNormal(): number {
  const u1 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random() || Number.EPSILON, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

// ── Combined score ──────────────────────────────────────────────────────────
export interface ScoreInputs {
  reliability: number; // [0,1] — sampled (routing) or expected (display)
  speed: number; // [0,1]
  intelligence: number; // [0,1]
  headroom: number; // [floor,1] multiplier
  rateLimit: number; // [floor,1] multiplier
}

export function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number {
  const wSum = weights.reliability + weights.speed + weights.intelligence || 1;
  const base =
    (weights.reliability * inputs.reliability +
      weights.speed * inputs.speed +
      weights.intelligence * inputs.intelligence) /
    wSum;
  return base * inputs.headroom * inputs.rateLimit;
}

// ── Settings keys for router.ts persistence ─────────────────────────────────
export const SETTING_ROUTING_STRATEGY = 'routing_strategy';
export const SETTING_ROUTING_WEIGHTS = 'routing_weights';
export const SETTING_PEAK_HOURS = 'peak_hours';
export const SETTING_TASK_WEIGHT_SHARE = 'routing_task_weight_share';
export const SETTING_MIN_RELIABILITY_FLOOR = 'routing_min_reliability_floor';
export const SETTING_HEADROOM_RAMP_START = 'routing_headroom_ramp_start';
export const SETTING_HEADROOM_FLOOR = 'routing_headroom_floor';
export const SETTING_PROVIDER_MOMENT_ATTRIBUTION = 'routing_provider_moment_attribution';
export const SETTING_EXPLORE_CHANCE = 'routing_explore_chance';
export const SETTING_EXPLORE_MIN_SAMPLES = 'routing_explore_min_samples';
export const SETTING_COMMUNITY_PRIOR_MAX_SAMPLES = 'routing_community_prior_max_samples';