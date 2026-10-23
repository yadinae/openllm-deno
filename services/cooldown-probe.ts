/**
 * cooldown-probe.ts — probe-based early recovery for benched keys.
 *
 * Ported from FreeLLMAPI services/cooldown-probe.ts (9.3 KB, 227 lines).
 *
 * Cooldowns are deliberately pessimistic: a transient 429 benches a model+key
 * for 90s, the escalation ladder for up to a day, and an upstream 401 for the
 * whole 5-minute health cycle. When the provider recovers sooner (a per-minute
 * window rolled over, a provider incident ended, a key was un-revoked), that
 * capacity sits idle until the timer runs out. This job periodically issues the
 * same cheap validateKey call the health checker uses against keys sitting in a
 * HEURISTIC cooldown, and clears those cooldowns early when the probe passes.
 *
 * What it will never do:
 *   - probe a cooldown backed by an authoritative retry time (explicit
 *     Retry-After, daily-quota reset) or a credit/tier bench — those are
 *     provider-stated facts, filtered out at the query (getProbeableCooldowns);
 *   - extend a cooldown: a failed probe only schedules the next probe further
 *     out (exponential backoff), the bench itself is untouched;
 *   - feed the health checker's consecutive-failure counter (probeKeyValidity
 *     is side-effect-free by design);
 *   - thundering-herd providers after a restart: a key's first sighting only
 *     schedules a jittered probe, and each pass probes at most a handful of
 *     keys.
 *
 * The probe unit is the KEY, not the model: validateKey exercises the
 * credential, so one pass/fail is the same evidence for every heuristic
 * cooldown that key holds, and probing per key is what keeps probe traffic
 * bounded no matter how many models are benched on it.
 *
 * Kill switch: COOLDOWN_PROBE_DISABLED=1 (same convention as
 * CATALOG_SYNC_DISABLED). Per-pass probe budget: COOLDOWN_PROBE_MAX_PER_PASS.
 */

import { cooldownManager } from "./ratelimit.ts";
import { probeKeyValidity } from "./health.ts";

// How often the scanner wakes up to look at the cooldown table.
const SCAN_INTERVAL_MS = 60 * 1000;

// A cooldown only becomes probe-ripe after this fraction of its bench has been
// served. Probing a seconds-old cooldown would mostly re-confirm the failure
// that caused it; by half-time a transient condition has had a real chance to
// clear, and long escalated benches still recover hours early.
const MIN_ELAPSED_FRACTION = 0.5;

// Not worth probing a cooldown that is about to expire on its own — the probe
// would cost a validate call to save less than a scan interval of idle time.
const MIN_REMAINING_MS = 60 * 1000;

// Failed-probe backoff per key: 2m, 4m, 8m, capped at 15m. Keys that stay bad
// converge to one validate call per 15 minutes — a third of what the 5-minute
// health pass already sends them.
const PROBE_BACKOFF_BASE_MS = 2 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 15 * 60 * 1000;

// Stagger window for a key's FIRST probe after it is sighted (covers the
// restart case, where every persisted cooldown is sighted at once).
const FIRST_PROBE_STAGGER_MS = 45 * 1000;

const DEFAULT_MAX_PROBES_PER_PASS = 3;

/** Per-pass probe budget. Tunable for large key fleets. */
function getMaxProbesPerPass(): number {
  const raw = Deno.env.get("COOLDOWN_PROBE_MAX_PER_PASS");
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PASS;
}

/** Kill switch. */
function isDisabled(): boolean {
  return Deno.env.get("COOLDOWN_PROBE_DISABLED") === "1";
}

/** Per-key probe pacing state (in-memory, survives restarts via first-sighting stagger). */
interface KeyProbeState {
  failures: number;
  nextProbeAtMs: number;
}
const keyState = new Map<number, KeyProbeState>();

/** Test seam: injectable probe, jitter, and maxProbes so unit tests need no network/timers. */
export interface ProbePassOptions {
  now?: number;
  probe?: (keyId: number) => Promise<"valid" | "invalid" | "error">;
  jitter?: () => number; // [0, 1), defaults to Math.random
  maxProbes?: number;
}

/** Result of one probe pass. */
export interface ProbePassResult {
  probedKeyIds: number[];
  clearedCooldowns: number;
}

/**
 * True when this cooldown has served enough of its bench to be worth probing.
 */
export function isRipe(
  cooldown: {
    platform: string;
    model_id: string;
    key_id: number;
    expires_at_ms: number;
    set_at_ms: number | null;
    last_probed_at_ms: number | null;
    probe_count: number;
  },
  now: number,
): boolean {
  if (cooldown.expires_at_ms - now < MIN_REMAINING_MS) return false;
  // Rows persisted before the provenance migration have no start time; treat
  // them as old enough rather than never probing them.
  if (cooldown.set_at_ms == null) return true;
  const duration = cooldown.expires_at_ms - cooldown.set_at_ms;
  return now - cooldown.set_at_ms >= duration * MIN_ELAPSED_FRACTION;
}

/**
 * One probe pass: find ripe heuristic cooldowns, probe up to maxProbes of their
 * keys (respecting per-key backoff), and clear every heuristic cooldown on a
 * key whose probe passed. Exported for tests; production runs it on the
 * scheduler via startCooldownProbe.
 */
export async function runCooldownProbePass(
  opts: ProbePassOptions = {},
): Promise<ProbePassResult> {
  const now = opts.now ?? Date.now();
  const probe = opts.probe ?? probeKeyValidity;
  const jitter = opts.jitter ?? Math.random;
  const maxProbes = opts.maxProbes ?? getMaxProbesPerPass();

  const all = await cooldownManager.getProbeableCooldowns();

  // Drop pacing state for keys with no probeable cooldowns left (expired,
  // cleared, or re-benched as authoritative) so old backoff cannot delay a
  // future, unrelated bench.
  const keysWithCooldowns = new Set(all.map((c) => c.key_id));
  for (const keyId of [...keyState.keys()]) {
    if (!keysWithCooldowns.has(keyId)) keyState.delete(keyId);
  }

  const ripeByKey = new Map<number, typeof all>();
  for (const cooldown of all) {
    if (!isRipe(cooldown, now)) continue;
    const list = ripeByKey.get(cooldown.key_id) ?? [];
    list.push(cooldown);
    ripeByKey.set(cooldown.key_id, list);
  }

  const probedKeyIds: number[] = [];
  let clearedCooldowns = 0;

  for (const [keyId, cooldownsForKey] of ripeByKey) {
    if (probedKeyIds.length >= maxProbes) break;

    let state = keyState.get(keyId);
    if (!state) {
      // First sighting: schedule, don't probe. This is the restart stagger —
      // a boot with dozens of persisted cooldowns spreads its first probes
      // across the jitter window instead of validating everything at once.
      state = {
        failures: 0,
        nextProbeAtMs: now + Math.floor(jitter() * FIRST_PROBE_STAGGER_MS),
      };
      keyState.set(keyId, state);
      continue;
    }
    if (now < state.nextProbeAtMs) continue;

    probedKeyIds.push(keyId);
    await cooldownManager.recordProbeAttempt(
      cooldownsForKey[0].platform,
      cooldownsForKey[0].model_id,
      keyId,
    );

    const outcome = await probe(keyId);

    if (outcome === "valid") {
      for (const cd of cooldownsForKey) {
        await cooldownManager.clearCooldownEarly(cd.platform, cd.model_id, keyId);
        clearedCooldowns++;
      }
      keyState.delete(keyId);
      console.log(
        `[cooldown-probe] Key ${keyId} validated — cleared ${cooldownsForKey.length} cooldown(s) early ` +
          `(${cooldownsForKey.map((c) => `${c.platform}/${c.model_id}`).join(", ")})`,
      );
    } else {
      // Failed or inconclusive: the bench stays EXACTLY as it was — a probe
      // must never extend a cooldown — and this key backs off before the next
      // attempt so probes cannot burn quota against a provider that is down.
      state.failures++;
      const backoff = Math.min(
        PROBE_BACKOFF_BASE_MS * 2 ** (state.failures - 1),
        PROBE_BACKOFF_MAX_MS,
      );
      state.nextProbeAtMs = now + backoff;
      console.log(
        `[cooldown-probe] Key ${keyId} probe ${outcome} — backoff ${Math.round(
          (state.nextProbeAtMs - now) / 1000,
        )}s`,
      );
    }
  }

  return { probedKeyIds, clearedCooldowns };
}

/** Overlap guard: a slow validateKey must not stack a second pass on top. */
let passInFlight: Promise<ProbePassResult> | null = null;

async function runGuardedPass(): Promise<ProbePassResult> {
  if (passInFlight) return passInFlight;
  passInFlight = runCooldownProbePass().finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

let _probeInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic probe scanner (Deno.cron).
 *
 * Uses Deno.cron for reliable scheduling on Deno Deploy (replaces the
 * FreeLLMAPI Scheduler abstraction). The interval is 60s.
 */
export function startCooldownProbe(): void {
  if (_probeInterval !== null) return;
  if (isDisabled()) {
    console.log("[cooldown-probe] Disabled via COOLDOWN_PROBE_DISABLED=1");
    return;
  }

  console.log(
    `[cooldown-probe] Starting scanner (every ${SCAN_INTERVAL_MS / 1000}s, max ${getMaxProbesPerPass()} probes/pass)`,
  );

  // Deno.cron: runs every minute (`* * * * *` = every minute).
  // Note: Deno Deploy cron syntax is standard cron.
  _probeInterval = setInterval(async () => {
    try {
      await runGuardedPass();
    } catch (err) {
      console.error("[cooldown-probe] Pass failed:", err);
    }
  }, SCAN_INTERVAL_MS);
}

/** Stop the periodic probe scanner (for graceful shutdown / tests). */
export function stopCooldownProbe(): void {
  if (_probeInterval !== null) {
    clearInterval(_probeInterval);
    _probeInterval = null;
  }
}

/** Test seam: drop all per-key probe pacing state. */
export function resetCooldownProbeState(): void {
  keyState.clear();
}

/** Manual trigger for admin dashboard. */
export async function triggerCooldownProbe(): Promise<{ probed: number; cleared: number }> {
  const beforeProbeable = await cooldownManager.getProbeableCooldowns();
  await runGuardedPass();
  const afterProbeable = await cooldownManager.getProbeableCooldowns();
  return {
    probed: beforeProbeable.length,
    cleared: beforeProbeable.length - afterProbeable.length,
  };
}