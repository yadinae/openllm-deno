/**
 * Premium路由 - 处理许可证和高级功能
 */

import { Hono } from 'hono';
import { getLicenseKey, getLicenseStatus, setLicenseStatus, setLicenseKey } from '../db/mod.ts';
import { validateLicenseKey, refreshLicenseStatus, syncCatalog, catalogBaseUrl, getSyncState } from '../services/catalog-sync.ts';

export const premiumRouter = new Hono();

function maskKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function statusPayload() {
  const key = getLicenseKey();
  return {
    hasKey: Boolean(key),
    maskedKey: key ? maskKey(key) : null,
    license: getLicenseStatus(),
    catalog: getSyncState(),
    // Where "Go Premium" / "recover key" links point. Overridable for forks.
    siteUrl: (Deno.env.get('PREMIUM_SITE_URL') ?? 'https://freellmapi.co').replace(/\/+$/, '')
  };
}

/** GET /api/premium — everything the Premium page renders. */
premiumRouter.get('/', (c) => c.json(statusPayload()));

/**
 * POST /api/premium/key { key } — activate a license key.
 * Validates against the catalog service first; only a key the service accepts
 * is stored. A live-tier sync is kicked off right away so the upgrade is
 * visible within seconds, not at the next 12h poll.
 */
premiumRouter.post('/key', async (c) => {
  const body = await c.req.json() as { key?: string };
  const key = typeof body.key === 'string' ? body.key.trim() : '';

  if (key.length < 8) {
    return c.json({ error: 'Enter the license key from your purchase email.' }, 400);
  }

  const result = await validateLicenseKey(key, 15000);
  if (!result) {
    return c.json({ error: 'Could not reach the license service. Check your connection and try again.' }, 502);
  }

  if (!result.valid) {
    const reasons: Record<string, string> = {
      unknown_key: 'That key was not recognized. Check for typos, or use key recovery on the website.',
      expired: 'That key has expired. Renew on the website to keep the live catalog.',
      canceled: 'That subscription was canceled. Re-subscribe on the website to reactivate.',
      refunded: 'That purchase was refunded, so the key is no longer active.',
    };
    return c.json({ error: reasons[result.reason ?? ''] ?? 'That key is not active.' }, 400);
  }

  setLicenseKey(key);
  await refreshLicenseStatus();
  const sync = await syncCatalog(true);
  return c.json({ ...statusPayload(), sync });
});

/** DELETE /api/premium/key — deactivate locally (the purchase itself is untouched). */
premiumRouter.delete('/key', (c) => {
  setLicenseKey('');
  setLicenseStatus({
    valid: false,
    plan: null,
    status: null,
    expiresAt: null,
    cancelAtPeriodEnd: false,
    checkedAtMs: Date.now()
  });

  // Drop back to the free tier in the background; failure just means the next
  // scheduled poll handles it.
  setTimeout(() => {
    syncCatalog(true);
  }, 0);

  return c.json(statusPayload());
});

/** POST /api/premium/sync — manual "check for updates now" */
premiumRouter.post('/sync', async (c) => {
  await refreshLicenseStatus();
  const sync = await syncCatalog(true);
  return c.json({ ...statusPayload(), sync });
});

/**
 * POST /api/premium/portal — Stripe Billing Portal session for the stored key.
 * This is how an annual subscriber cancels, updates a card, or pulls invoices,
 * entirely self-serve.
 */
premiumRouter.post('/portal', async (c) => {
  const key = getLicenseKey();
  if (!key) {
    return c.json({ error: 'No license key configured.' }, 400);
  }

  try {
    const r = await fetch(`${catalogBaseUrl()}/v1/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15000)
    });

    const body = await r.json() as { url?: string; error?: string };
    if (!r.ok || !body.url) {
      return c.json({ error: body.error ?? 'Could not open the billing portal.' }, 502);
    }

    return c.json({ url: body.url });
  } catch {
    return c.json({ error: 'Could not reach the billing service. Try again shortly.' }, 502);
  }
});
