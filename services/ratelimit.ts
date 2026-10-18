/**
 * QuotaEngine + CooldownManager — Rate limiting, quota enforcement, and cooldown handling.
 * Phase A Week 3: Core quota/cooldown engine.
 */

import { query, initDb } from "../db/pg.ts";

/** Quota check result */
export interface QuotaResult {
  allowed: boolean;
  reason?: string;
  retry_after_ms?: number;
  current_usage?: { rpm: number; tpm: number };
  limits?: { rpm: number; tpm: number };
}

/** Cooldown state */
export interface CooldownState {
  in_cooldown: boolean;
  expires_at_ms?: number;
  reason?: string;
}

/** Rate limit window configuration */
interface RateLimitWindow {
  window_ms: number;
  max_requests: number;
  max_tokens: number;
}

/** Default rate limit windows */
const WINDOWS: Record<string, RateLimitWindow> = {
  minute: { window_ms: 60_000, max_requests: 60, max_tokens: 100_000 },
  hour: { window_ms: 3_600_000, max_requests: 1_000, max_tokens: 1_000_000 },
  day: { window_ms: 86_400_000, max_requests: 10_000, max_tokens: 10_000_000 },
};

/**
 * QuotaEngine — Enforces RPM/TPM limits using Sliding Window Log algorithm.
 * Tracks usage in rate_limit_usage table with millisecond precision.
 */
export class QuotaEngine {
  /**
   * Check if request is within quota and atomically reserve capacity.
   * Returns allowed=true if within limits, false with retry_after_ms if exceeded.
   */
  async checkAndConsume(
    keyId: number,
    platform: string,
    modelId: string,
    estimatedTokens: number
  ): Promise<QuotaResult> {
    try {
      // Validate keyId
      if (!keyId || keyId <= 0 || isNaN(keyId)) {
        console.warn("[quota] Invalid keyId, failing open:", keyId);
        return { allowed: true };
      }
      
      await initDb();

      const now = Date.now();
      const minuteWindowStart = now - WINDOWS.minute.window_ms;

      // Get current usage in the last minute
      const usageRows = await query`
        SELECT 
          COALESCE(SUM(CASE WHEN kind = 'request' THEN tokens ELSE 0 END), 0) as rpm,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN tokens ELSE 0 END), 0) as tpm
        FROM rate_limit_usage
        WHERE key_id = ${keyId}
          AND platform = ${platform}
          AND model_id = ${modelId}
          AND created_at_ms >= ${minuteWindowStart}
      `;

      const currentRpm = Number(usageRows[0]?.rpm ?? 0);
      const currentTpm = Number(usageRows[0]?.tpm ?? 0);

      // Get limits from model config (with defaults)
      const limits = await this.getLimits(platform, modelId);
      
      // Check RPM limit
      if (currentRpm >= limits.rpm) {
        const oldestRequest = await query`
          SELECT created_at_ms FROM rate_limit_usage
          WHERE key_id = ${keyId} AND platform = ${platform} AND model_id = ${modelId}
            AND kind = 'request' AND created_at_ms >= ${minuteWindowStart}
          ORDER BY created_at_ms ASC LIMIT 1
        `;
        const retryAfter = oldestRequest.length > 0
          ? oldestRequest[0].created_at_ms + WINDOWS.minute.window_ms - now
          : WINDOWS.minute.window_ms;
        
        return {
          allowed: false,
          reason: "rpm_exceeded",
          retry_after_ms: Math.max(1000, retryAfter),
          current_usage: { rpm: currentRpm, tpm: currentTpm },
          limits: { rpm: limits.rpm, tpm: limits.tpm },
        };
      }

      // Check TPM limit
      if (currentTpm + estimatedTokens > limits.tpm) {
        const oldestRequest = await query`
          SELECT created_at_ms FROM rate_limit_usage
          WHERE key_id = ${keyId} AND platform = ${platform} AND model_id = ${modelId}
            AND kind = 'tokens' AND created_at_ms >= ${minuteWindowStart}
          ORDER BY created_at_ms ASC LIMIT 1
        `;
        const retryAfter = oldestRequest.length > 0
          ? oldestRequest[0].created_at_ms + WINDOWS.minute.window_ms - now
          : WINDOWS.minute.window_ms;

        return {
          allowed: false,
          reason: "tpm_exceeded",
          retry_after_ms: Math.max(1000, retryAfter),
          current_usage: { rpm: currentRpm, tpm: currentTpm },
          limits: { rpm: limits.rpm, tpm: limits.tpm },
        };
      }

      // Reserve capacity by recording the request
      await this.recordUsage(keyId, platform, modelId, estimatedTokens);

      return {
        allowed: true,
        current_usage: { rpm: currentRpm + 1, tpm: currentTpm + estimatedTokens },
        limits: { rpm: limits.rpm, tpm: limits.tpm },
      };
    } catch (e) {
      console.error("[quota] checkAndConsume error:", e);
      // Fail open - allow request if quota check fails
      return { allowed: true };
    }
  }

  /**
   * Record actual usage after successful response.
   * Updates rate_limit_usage with real token counts.
   */
  async recordUsage(
    keyId: number,
    platform: string,
    modelId: string,
    tokens: number,
    isRequest: boolean = true
  ): Promise<void> {
    try {
      if (!keyId || keyId <= 0 || isNaN(keyId)) {
        console.warn("[quota] Invalid keyId in recordUsage, skipping:", keyId);
        return;
      }
      await initDb();
      const now = Date.now();
      
      await query`
        INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms, created_at)
        VALUES (
          ${platform}, ${modelId}, ${keyId},
          ${isRequest ? 'request' : 'tokens'},
          ${isRequest ? 1 : tokens},
          ${now}, ${new Date(now).toISOString()}
        )
      `;
    } catch (e) {
      console.error("[quota] recordUsage error:", e);
    }
  }

  /**
   * Called after receiving response from provider.
   * Records actual token usage and checks for rate limit headers.
   */
  async onResponse(
    keyId: number,
    platform: string,
    modelId: string,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    headers: Headers
  ): Promise<void> {
    try {
      if (!keyId || keyId <= 0 || isNaN(keyId)) {
        console.warn("[quota] Invalid keyId in onResponse, skipping:", keyId);
        return;
      }
      // Record actual token usage
      await this.recordUsage(keyId, platform, modelId, usage.prompt_tokens, false);
      await this.recordUsage(keyId, platform, modelId, usage.completion_tokens, false);

      // Check for rate limit headers from provider
      const retryAfter = headers.get('retry-after') || headers.get('x-ratelimit-reset');
      if (retryAfter) {
        const cooldownMs = parseInt(retryAfter) * 1000;
        if (cooldownMs > 0) {
          await CooldownManager.setCooldown(platform, modelId, keyId, Date.now() + cooldownMs, "provider_rate_limit");
        }
      }

      // Check standard rate limit headers
      const remaining = headers.get('x-ratelimit-remaining-requests') || headers.get('x-ratelimit-remaining');
      if (remaining !== null) {
        const rem = parseInt(remaining);
        if (rem <= 0) {
          const reset = headers.get('x-ratelimit-reset') || headers.get('retry-after');
          const cooldownMs = reset ? parseInt(reset) * 1000 : 60_000;
          await CooldownManager.setCooldown(platform, modelId, keyId, Date.now() + cooldownMs, "provider_rate_limit_header");
        }
      }
    } catch (e) {
      console.error("[quota] onResponse error:", e);
    }
  }

  /**
   * Get rate limits for a provider/model from database config.
   * Falls back to sensible defaults.
   */
  private async getLimits(platform: string, modelId: string): Promise<{ rpm: number; tpm: number }> {
    try {
      const rows = await query`
        SELECT rpm_limit, tpm_limit, rpd_limit, tpd_limit
        FROM models
        WHERE platform = ${platform} AND model_id = ${modelId}
      `;
      
      if (rows.length > 0) {
        const m = rows[0];
        return {
          rpm: m.rpm_limit ?? WINDOWS.minute.max_requests,
          tpm: m.tpm_limit ?? WINDOWS.minute.max_tokens,
        };
      }
    } catch {
      // Fall through to defaults
    }
    return { rpm: WINDOWS.minute.max_requests, tpm: WINDOWS.minute.max_tokens };
  }

  /**
   * Probe cooldown status for a provider/model/key.
   * Returns cooldown state if in cooldown.
   */
  async probeCooldown(keyId: number, platform: string, modelId: string): Promise<CooldownState> {
    if (!keyId || keyId <= 0 || isNaN(keyId)) {
      console.warn("[quota] Invalid keyId in probeCooldown, skipping:", keyId);
      return { in_cooldown: false };
    }
    return CooldownManager.getState(platform, modelId, keyId);
  }

  /**
   * Get current usage statistics for a key.
   */
  async getUsageStats(keyId: number, platform: string, modelId: string): Promise<{
    rpm: number; tpm: number; rph: number; tph: number; rpd: number; tpd: number;
  }> {
    try {
      if (!keyId || keyId <= 0 || isNaN(keyId)) {
        console.warn("[quota] Invalid keyId in getUsageStats, skipping:", keyId);
        return { rpm: 0, tpm: 0, rph: 0, tph: 0, rpd: 0, tpd: 0 };
      }
      await initDb();
      const now = Date.now();
      
      const minuteAgo = now - WINDOWS.minute.window_ms;
      const hourAgo = now - WINDOWS.hour.window_ms;
      const dayAgo = now - WINDOWS.day.window_ms;

      const [minute, hour, day] = await Promise.all([
        query`
          SELECT 
            COALESCE(SUM(CASE WHEN kind = 'request' THEN tokens ELSE 0 END), 0) as rpm,
            COALESCE(SUM(CASE WHEN kind = 'tokens' THEN tokens ELSE 0 END), 0) as tpm
          FROM rate_limit_usage
          WHERE key_id = ${keyId} AND platform = ${platform} AND model_id = ${modelId}
            AND created_at_ms >= ${minuteAgo}
        `,
        query`
          SELECT 
            COALESCE(SUM(CASE WHEN kind = 'request' THEN tokens ELSE 0 END), 0) as rph,
            COALESCE(SUM(CASE WHEN kind = 'tokens' THEN tokens ELSE 0 END), 0) as tph
          FROM rate_limit_usage
          WHERE key_id = ${keyId} AND platform = ${platform} AND model_id = ${modelId}
            AND created_at_ms >= ${hourAgo}
        `,
        query`
          SELECT 
            COALESCE(SUM(CASE WHEN kind = 'request' THEN tokens ELSE 0 END), 0) as rpd,
            COALESCE(SUM(CASE WHEN kind = 'tokens' THEN tokens ELSE 0 END), 0) as tpd
          FROM rate_limit_usage
          WHERE key_id = ${keyId} AND platform = ${platform} AND model_id = ${modelId}
            AND created_at_ms >= ${dayAgo}
        `,
      ]);

      return {
        rpm: Number(minute[0]?.rpm ?? 0),
        tpm: Number(minute[0]?.tpm ?? 0),
        rph: Number(hour[0]?.rph ?? 0),
        tph: Number(hour[0]?.tph ?? 0),
        rpd: Number(day[0]?.rpd ?? 0),
        tpd: Number(day[0]?.tpd ?? 0),
      };
    } catch {
      return { rpm: 0, tpm: 0, rph: 0, tph: 0, rpd: 0, tpd: 0 };
    }
  }
}

/**
 * CooldownManager — Handles provider/model/key cooldown periods.
 * When a provider returns 429/5xx, marks the combination as cooling down
 * and prevents further requests until expiry.
 */
export class CooldownManager {
  /**
     * Set a cooldown for a provider/model/key combination.
     */
    static async setCooldown(
      platform: string,
      modelId: string,
      keyId: number,
      expiresAtMs: number,
      reason: string = "rate_limit"
    ): Promise<void> {
      try {
        if (!keyId || keyId <= 0 || isNaN(keyId)) {
          console.warn("[cooldown] Invalid keyId in setCooldown, skipping:", keyId);
          return;
        }
        await initDb();
        await query`
          INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms, created_at)
          VALUES (${platform}, ${modelId}, ${keyId}, ${expiresAtMs}, ${new Date().toISOString()})
          ON CONFLICT (platform, model_id, key_id) DO UPDATE SET
            expires_at_ms = GREATEST(rate_limit_cooldowns.expires_at_ms, ${expiresAtMs}),
            created_at = ${new Date().toISOString()}
        `;
        console.log(`[cooldown] Set for ${platform}/${modelId}/${keyId} until ${new Date(expiresAtMs).toISOString()} (${reason})`);
      } catch (e) {
        console.error("[cooldown] setCooldown error:", e);
      }
    }

    /**
     * Get current cooldown state.
     */
    static async getState(platform: string, modelId: string, keyId: number): Promise<CooldownState> {
      try {
        if (!keyId || keyId <= 0 || isNaN(keyId)) {
          console.warn("[cooldown] Invalid keyId in getState, skipping:", keyId);
          return { in_cooldown: false };
        }
        await initDb();
        const rows = await query`
          SELECT expires_at_ms, created_at
          FROM rate_limit_cooldowns
          WHERE platform = ${platform} AND model_id = ${modelId} AND key_id = ${keyId}
        `;

      if (rows.length === 0) {
        return { in_cooldown: false };
      }

      const expiresAt = Number(rows[0].expires_at_ms);
      const now = Date.now();

      if (expiresAt > now) {
        return {
          in_cooldown: true,
          expires_at_ms: expiresAt,
          reason: "rate_limit",
        };
      } else {
        // Expired - clean up
        await this.clearCooldown(platform, modelId, keyId);
        return { in_cooldown: false };
      }
    } catch (e) {
      console.error("[cooldown] getState error:", e);
      return { in_cooldown: false };
    }
  }

  /**
   * Clear cooldown (when expired or manually released).
   */
  static async clearCooldown(platform: string, modelId: string, keyId: number): Promise<void> {
    try {
      if (!keyId || keyId <= 0 || isNaN(keyId)) {
        console.warn("[cooldown] Invalid keyId in clearCooldown, skipping:", keyId);
        return;
      }
      await initDb();
      await query`
        DELETE FROM rate_limit_cooldowns
        WHERE platform = ${platform} AND model_id = ${modelId} AND key_id = ${keyId}
      `;
    } catch (e) {
      console.error("[cooldown] clearCooldown error:", e);
    }
  }

  /**
   * Check if in cooldown (convenience method).
   */
  static async isInCooldown(platform: string, modelId: string, keyId: number): Promise<boolean> {
    if (!keyId || keyId <= 0 || isNaN(keyId)) {
      console.warn("[cooldown] Invalid keyId in isInCooldown, skipping:", keyId);
      return false;
    }
    const state = await this.getState(platform, modelId, keyId);
    return state.in_cooldown;
  }

  /**
   * Get all active cooldowns (for monitoring/debugging).
   */
  static async getAllActive(): Promise<Array<{
    platform: string; model_id: string; key_id: string; expires_at_ms: number; created_at: string;
  }>> {
    try {
      await initDb();
      const now = Date.now();
      const rows = await query`
        SELECT platform, model_id, key_id, expires_at_ms, created_at
        FROM rate_limit_cooldowns
        WHERE expires_at_ms > ${now}
        ORDER BY expires_at_ms ASC
      `;
      return rows.map((r: any) => ({
        platform: r.platform,
        model_id: r.model_id,
        key_id: String(r.key_id),
        expires_at_ms: Number(r.expires_at_ms),
        created_at: r.created_at,
      }));
    } catch {
      return [];
    }
  }
}

/** Global instances */
export const quotaEngine = new QuotaEngine();
export const cooldownManager = CooldownManager;

/**
 * Middleware helper: wrap a chat request with quota check + cooldown check.
 * Returns { allowed: true } or { allowed: false, error, retry_after_ms }
 */
export async function checkQuotaAndCooldown(
  keyId: number,
  platform: string,
  modelId: string,
  estimatedTokens: number
): Promise<QuotaResult> {
  // Validate keyId early
  if (!keyId || keyId <= 0 || isNaN(keyId)) {
    console.warn("[quota] Invalid keyId in checkQuotaAndCooldown, failing open:", keyId);
    return { allowed: true };
  }
  
  // Check cooldown first
  const cooldown = await cooldownManager.getState(platform, modelId, keyId);
  if (cooldown.in_cooldown) {
    return {
      allowed: false,
      reason: "cooldown",
      retry_after_ms: (cooldown.expires_at_ms ?? Date.now()) - Date.now(),
    };
  }

  // Check quota
  return quotaEngine.checkAndConsume(keyId, platform, modelId, estimatedTokens);
}