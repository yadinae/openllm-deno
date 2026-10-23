/**
 * P1 unit tests for the scoring/router helper functions.
 * Pure, no DB/server needed: validates the mathematical and parsing contracts
 * that were missing or broken on the OpenLLM side.
 */
import {
  estimateRequestTokens,
  routingReserveTokens,
  fitsContextWindowStrict,
  fitsContextWindow,
  requestNeedsVision,
  requestNeedsTools,
  stickySessionKey,
  getStickyModel,
  setStickyModel,
  windowUsedFraction,
  CONTEXT_WINDOW_SAFETY_FACTOR,
} from "../services/router.ts";
import { parseBudget } from "../services/scoring.ts";
import type { ChatCompletionRequest } from "../providers/types.ts";

Deno.test("routingReserveTokens: caps at OUTPUT_RESERVE_CAP, defaults to 1000", () => {
  if (routingReserveTokens(undefined) !== 1000) throw new Error("expected 1000 default");
  if (routingReserveTokens(null) !== 1000) throw new Error("expected 1000 default");
  if (routingReserveTokens(200_000) !== 2000) throw new Error("expected 2000 cap");
  if (routingReserveTokens(500) !== 500) throw new Error("expected 500");
  if (routingReserveTokens(0) !== 1000) throw new Error("expected 1000 for zero");
});

Deno.test("fitsContextWindowStrict: null window never gated; exact fit passes", () => {
  if (fitsContextWindowStrict(null, 1_000_000) !== true) throw new Error("null should pass");
  if (fitsContextWindowStrict(200_000, 200_000) !== true) throw new Error("exact should pass");
  if (fitsContextWindowStrict(200_000, 200_001) !== false) throw new Error("over should fail");
});

Deno.test("fitsContextWindow: 1.25x safety factor with reserve", () => {
  if (fitsContextWindow(1_000_000, 10_000, 1_000) !== true) throw new Error("should fit with margin");
  // 100k window, 90k estimate, 1k reserve: (90000-1000)*1.25+1000 = 112250 > 100000 → margin FAILS
  if (fitsContextWindow(100_000, 90_000, 1_000) !== false) throw new Error("margin should fail");
  if (fitsContextWindow(null, 1_000_000) !== true) throw new Error("null should pass");
});

Deno.test("CONTEXT_WINDOW_SAFETY_FACTOR is 1.25", () => {
  if (CONTEXT_WINDOW_SAFETY_FACTOR !== 1.25) throw new Error("safety factor must be 1.25");
});

Deno.test("estimateRequestTokens: chars/4 + capped reserve", () => {
  const base = { model: "auto", messages: [{ role: "user", content: "hello world" }] } as unknown as ChatCompletionRequest;
  // ~11 chars → 3 tokens + 1000 reserve = 1003
  if (estimateRequestTokens(base) !== 1003) throw new Error(`expected 1003 got ${estimateRequestTokens(base)}`);
  // max_tokens=200000 → reserve capped at 2000
  if (estimateRequestTokens({ ...base, max_tokens: 200_000 } as unknown as ChatCompletionRequest) !== 2003) {
    throw new Error("reserve should cap at 2000");
  }
});

Deno.test("requestNeedsVision: detects image content in OpenAI and content-block shapes", () => {
  if (requestNeedsVision({ model: "auto", messages: [{ role: "user", content: "hi" }] } as unknown as ChatCompletionRequest)) {
    throw new Error("text-only should not need vision");
  }
  if (!requestNeedsVision({
    model: "auto",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }],
  } as unknown as ChatCompletionRequest)) throw new Error("image_url not detected");
  if (!requestNeedsVision({
    model: "auto",
    messages: [{ role: "user", content: [{ type: "image", source: { data: "abc" } }] }],
  } as unknown as ChatCompletionRequest)) throw new Error("image block not detected");
});

Deno.test("requestNeedsTools: detects non-empty tools array", () => {
  if (requestNeedsTools({ model: "auto", messages: [] } as unknown as ChatCompletionRequest)) throw new Error("no tools");
  if (!requestNeedsTools({
    model: "auto",
    messages: [],
    tools: [{ type: "function", function: { name: "x" } }],
  } as unknown as ChatCompletionRequest)) throw new Error("tools not detected");
});

Deno.test("parseBudget: token budgets, not request-rate masks", () => {
  if (parseBudget("~120M") !== 120_000_000) throw new Error(`got ${parseBudget("~120M")}`);
  if (parseBudget("~500K") !== 500_000) throw new Error(`got ${parseBudget("~500K")}`);
  if (parseBudget("~12M") !== 12_000_000) throw new Error(`got ${parseBudget("~12M")}`);
  if (parseBudget("free · 40 RPM") !== 0) throw new Error("rate label should be 0");
  if (parseBudget("free · 14.4K rpd") !== 0) throw new Error("14.4K rpd is requests, not tokens");
  if (parseBudget("~500K tokens/day") !== 500_000 * 30) throw new Error("daily should scale x30");
  if (parseBudget("promo (trial)") !== 0) throw new Error("non-budget label should be 0");
  if (parseBudget("") !== 0) throw new Error("empty should be 0");
});

Deno.test("stickySessionKey: header beats message hash; strategy scopes the key", async () => {
  const req = { model: "auto", messages: [{ role: "user", content: "hello" }] } as unknown as ChatCompletionRequest;
  const h = await stickySessionKey(req, "sess-1", "balanced");
  if (h !== "hdr:sess-1::balanced") throw new Error(`got ${h}`);
  const h2 = await stickySessionKey(req, undefined, "balanced");
  const h2b = await stickySessionKey(req, undefined, "smartest");
  if (h2 === h2b) throw new Error("strategy key must scope the session");
  const empty = await stickySessionKey(
    { model: "auto", messages: [] } as unknown as ChatCompletionRequest, undefined, "balanced");
  if (empty !== "") throw new Error("empty session key expected for no user msg + no header");
});

Deno.test("sticky lifecycle: first turn is free-routing; set then get within TTL", async () => {
  const req = {
    model: "auto",
    messages: [
      { role: "user", content: "conv-abc" },
      { role: "assistant", content: "hi" },
    ],
  } as unknown as ChatCompletionRequest;
  // No assistant turn yet → must not return a sticky model
  const noSticky = await getStickyModel(
    { model: "auto", messages: [{ role: "user", content: "conv-abc" }] } as unknown as ChatCompletionRequest);
  if (noSticky !== undefined) throw new Error("first turn must be free-routing");

  await setStickyModel(req, "openai/gpt-4o-mini");
  const got = await getStickyModel(req);
  if (got !== "openai/gpt-4o-mini") throw new Error(`expected sticky model, got ${got}`);
});

Deno.test("windowUsedFraction: null/zero limits → 0; worst-case max clamps to 1", () => {
  const m = (o: Record<string, unknown>): any => ({
    rpm_used: 0, rpd_used: 0, tpm_used: 0, tpd_used: 0,
    rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null,
    ...o,
  });
  if (windowUsedFraction(m({}) ) !== 0) throw new Error("no limits → 0");
  if (windowUsedFraction(m({ rpm_limit: 100, rpm_used: 50, rpd_limit: 1000, rpd_used: 50 })) !== 0.5) throw new Error("expected 0.5");
  if (windowUsedFraction(m({ rpm_limit: 100, rpm_used: 200 })) !== 1) throw new Error("expected 1 clamp");
});
