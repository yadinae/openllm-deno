/**
 * cooldown-probe.ts — probe-based early recovery for benched keys.
 *
 * Ported from FreeLLMAPI services/cooldown-probe.js (180 lines).
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

const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute scan interval
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

/**
 * One probe pass: find ripe heuristic cooldowns, probe up to maxProbes of their
 * keys, clear cooldowns early on success, record attempt for backoff on failure.
 */
async function runProbePass(): Promise<void> {
  if (isDisabled()) return;

  const maxProbes = getMaxProbesPerPass();
  const probeable = await cooldownManager.getProbeableCooldowns();
  if (probeable.length === 0) return;

  // Group by keyId: one probe validates all cooldowns on that key
  const byKey = new Map<number, typeof probeable>();
  for (const cd of probeable) {
    const list = byKey.get(cd.key_id);
    if (list) list.push(cd);
    else byKey.set(cd.key_id, [cd]);
  }

  const keyIds = [...byKey.keys()];
  let probed = 0;

  for (const keyId of keyIds) {
    if (probed >= maxProbes) break;

    const cooldowns = byKey.get(keyId)!;
    await cooldownManager.recordProbeAttempt(
      cooldowns[0].platform,
      cooldowns[0].model_id,
      keyId
    );

    const result = await probeKeyValidity(keyId);

    if (result === "valid") {
      // Clear ALL heuristic cooldowns for this key (same credential)
      for (const cd of cooldowns) {
        await cooldownManager.clearCooldownEarly(cd.platform, cd.model_id, keyId);
      }
      console.log(`[cooldown-probe] Key ${keyId} probe valid — cleared ${cooldowns.length} cooldown(s)`);
    } else if (result === "invalid") {
      // Key is genuinely invalid — leave cooldowns in place (they'll expire naturally)
      // The health checker will eventually disable the key.
      console.log(`[cooldown-probe] Key ${keyId} probe invalid — cooldowns retained`);
    } else {
      // Transport error — inconclusive, backoff will delay next probe
      console.log(`[cooldown-probe] Key ${keyId} probe error (transport) — backoff applied`);
    }

    probed++;
  }

  if (probed > 0) {
    console.log(`[cooldown-probe] Pass complete: ${probed} key(s) probed, ${byKey.size - probed} remaining`);
  }
}

/** Start the periodic probe scanner (Deno.cron). */
export function startCooldownProbe(): void {
  if (isDisabled()) {
    console.log("[cooldown-probe] Disabled via COOLDOWN_PROBE_DISABLED=1");
    return;
  }

  console.log(`[cooldown-probe] Starting scanner (every ${SCAN_INTERVAL_MS / 1000}s, max ${getMaxProbesPerPass()} probes/pass)`);

  // Use Deno.cron for reliable scheduling on Deno Deploy
  Deno.cron("cooldown-probe", `*/${SCAN_INTERVAL_MS / 1000 / 60} * * * *`, async () => {
    try {
      await runProbePass();
    } catch (err) {
      console.error("[cooldown-probe] Pass failed:", err);
    }
  });
}

/** Manual trigger for admin dashboard. */
export async function triggerCooldownProbe(): Promise<{ probed: number; cleared: number }> {
  const beforeProbeable = await cooldownManager.getProbeableCooldowns();
  await runProbePass();
  const afterProbeable = await cooldownManager.getProbeableCooldowns();
  return {
    probed: beforeProbeable.length,
    cleared: beforeProbeable.length - afterProbeable.length,
  };
}