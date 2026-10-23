/**
 * custom-model-budget.ts — Monthly budget enforcement for custom models.
 *
 * Custom models can have a `monthly_token_budget` string (e.g. "500K", "~120M").
 * This module parses that budget and enforces it against successful usage
 * recorded in a `custom_model_monthly_usage` table.
 *
 * Mirrors the key-budget.ts pattern but per custom-model instead of per key.
 */

import { query, queryRaw, initDb } from "../db/pg.ts";
import { parseBudget } from "./scoring.ts";

function utcNextMonthStartMs(now = Date.now()): number {
  const d = new Date(now);
  const month = d.getUTCMonth() + 1;
  return Date.UTC(d.getUTCFullYear() + Math.floor(month / 12), month % 12, 1);
}

function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function secondsUntilNextMonth(now = Date.now()): number {
  return Math.max(1, Math.floor((utcNextMonthStartMs(now) - now) / 1000));
}

export function nextMonthResetAt(now = Date.now()): string {
  return new Date(utcNextMonthStartMs(now)).toISOString();
}

/** Get the parsed monthly token budget for a custom model. Returns 0 if none set. */
export async function getCustomModelMonthlyBudget(modelId: string): Promise<number> {
  try {
    await initDb();
    const rows = await query`
      SELECT monthly_token_budget FROM custom_models WHERE id = ${modelId}
    `;
    const r = rows[0] as any;
    if (!r || !r.monthly_token_budget) return 0;
    return parseBudget(r.monthly_token_budget);
  } catch {
    return 0;
  }
}

/** Get the current month's usage for a custom model. */
export async function getCustomModelMonthlyUsage(modelId: string, now = Date.now()): Promise<{ requests: number; tokens: number }> {
  try {
    await initDb();
    const rows = await query`
      SELECT requests, tokens FROM custom_model_monthly_usage
      WHERE model_id = ${modelId} AND month = ${monthKey(now)}
    `;
    const r = rows[0] as any;
    return { requests: Number(r?.requests ?? 0), tokens: Number(r?.tokens ?? 0) };
  } catch {
    return { requests: 0, tokens: 0 };
  }
}

/** Check a custom model against its monthly token budget. */
export interface CustomModelBudgetVerdict {
  allowed: boolean;
  reason?: "monthly_token_budget";
  retryAfterSec?: number;
  release?: () => void;
  budgetUsed?: number;
  budgetLimit?: number;
}

const activeCustomModelReservations = new Set<{ modelId: string; tokens: number }>();

function activeCustomModelReservationsSet(): Set<{ modelId: string; tokens: number }> {
  return activeCustomModelReservations;
}

export async function checkCustomModelBudget(
  modelId: string,
  estimatedTokens: number,
  now = Date.now()
): Promise<CustomModelBudgetVerdict> {
  const budgetLimit = await getCustomModelMonthlyBudget(modelId);
  if (budgetLimit <= 0) return { allowed: true };

  const usage = await getCustomModelMonthlyUsage(modelId, now);
  for (const res of activeCustomModelReservationsSet()) {
    if (res.modelId !== modelId) continue;
    usage.requests++;
    usage.tokens += res.tokens;
  }

  if (usage.tokens >= budgetLimit || usage.tokens + Math.max(0, estimatedTokens) > budgetLimit) {
    return {
      allowed: false,
      reason: "monthly_token_budget",
      retryAfterSec: secondsUntilNextMonth(now),
      budgetUsed: usage.tokens,
      budgetLimit,
    };
  }
  return { allowed: true, budgetUsed: usage.tokens, budgetLimit };
}

export async function reserveCustomModelBudget(
  modelId: string,
  estimatedTokens: number,
  now = Date.now()
): Promise<CustomModelBudgetVerdict> {
  const verdict = await checkCustomModelBudget(modelId, estimatedTokens, now);
  if (!verdict.allowed) return verdict;
  const active = activeCustomModelReservationsSet();
  const reservation = { modelId, tokens: Math.max(0, estimatedTokens) };
  active.add(reservation);
  return {
    allowed: true,
    release: () => { active.delete(reservation); },
    budgetUsed: verdict.budgetUsed,
    budgetLimit: verdict.budgetLimit,
  };
}

export async function settleCustomModelUsage(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  now = Date.now()
): Promise<void> {
  try {
    await initDb();
    const month = monthKey(now);
    const totalTokens = promptTokens + completionTokens;
    await query`
      INSERT INTO custom_model_monthly_usage (model_id, month, requests, tokens)
      VALUES (${modelId}, ${month}, 1, ${totalTokens})
      ON CONFLICT (model_id, month) DO UPDATE SET
        requests = custom_model_monthly_usage.requests + 1,
        tokens = custom_model_monthly_usage.tokens + ${totalTokens}
    `;
  } catch (e) {
    console.warn(`[custom-model-budget] settle failed for ${modelId}:`, e instanceof Error ? e.message : e);
  }
}

/** Forecast entry for a custom model's monthly budget. */
export interface CustomModelBudgetForecast {
  modelId: string;
  displayName: string;
  provider: string;
  budgetLimit: number;
  used: number;
  remaining: number;
  remainingPct: number;
  lowBalance: boolean;
  secondsUntilReset: number;
}

/** Get budget forecasts for all active custom models with a budget set. */
export async function getCustomModelBudgetForecasts(now = Date.now()): Promise<CustomModelBudgetForecast[]> {
  try {
    await initDb();
    const rows = await query`
      SELECT id, display_name, provider, monthly_token_budget
      FROM custom_models
      WHERE status = 'active' AND monthly_token_budget IS NOT NULL AND monthly_token_budget != ''
    `;
    const forecasts: CustomModelBudgetForecast[] = [];
    for (const r of rows as any[]) {
      const budgetLimit = parseBudget(r.monthly_token_budget);
      if (budgetLimit <= 0) continue;
      const usage = await getCustomModelMonthlyUsage(r.id, now);
      const remaining = Math.max(0, budgetLimit - usage.tokens);
      const remainingPct = budgetLimit > 0 ? Math.round((remaining / budgetLimit) * 1000) / 10 : 0;
      const lowBalance = remainingPct < 10 || (budgetLimit >= 200000 && remaining < 20000);
      forecasts.push({
        modelId: r.id,
        displayName: r.display_name,
        provider: r.provider,
        budgetLimit,
        used: usage.tokens,
        remaining,
        remainingPct,
        lowBalance,
        secondsUntilReset: secondsUntilNextMonth(now),
      });
    }
    return forecasts;
  } catch {
    return [];
  }
}