/**
 * P2 unit tests: cooldown-probe pure helpers.
 * DB-dependent integration is skipped (no DATABASE_URL in test runner).
 */
import { isRipe, resetCooldownProbeState } from "../services/cooldown-probe.ts";

const NOW = 1_000_000;

function makeCd(overrides: Record<string, unknown>) {
  return {
    platform: "test",
    model_id: "m",
    key_id: 1,
    expires_at_ms: NOW + 300_000,
    set_at_ms: NOW - 300_000,
    last_probed_at_ms: null,
    probe_count: 0,
    ...overrides,
  };
}

Deno.test("isRipe: false while cooldown is too young", () => {
  // 40% served (< 0.5 threshold)
  if (isRipe(makeCd({ expires_at_ms: NOW + 360_000, set_at_ms: NOW - 240_000 }), NOW)) {
    throw new Error("too young should not be ripe");
  }
});

Deno.test("isRipe: false when < MIN_REMAINING_MS (60s) left", () => {
  // 45s remaining — below MIN_REMAINING_MS=60s
  if (isRipe(makeCd({ expires_at_ms: NOW + 45_000, set_at_ms: NOW - 10_000 }), NOW)) {
    throw new Error("about-to-expire should not be ripe");
  }
});

Deno.test("isRipe: true when half the bench served and > 1 min remaining", () => {
  // 50% served, 5 min remaining
  if (!isRipe(makeCd({ expires_at_ms: NOW + 300_000, set_at_ms: NOW - 300_000 }), NOW)) {
    throw new Error("half-served should be ripe");
  }
});

Deno.test("isRipe: legacy rows without set_at_ms are treated as old enough", () => {
  if (!isRipe(makeCd({ set_at_ms: null }), NOW)) {
    throw new Error("legacy row without start time should be ripe");
  }
});

Deno.test("resetCooldownProbeState: idempotent, no-op second call", () => {
  resetCooldownProbeState();
  resetCooldownProbeState();
});
