import { Hono } from 'hono';
import { getDb } from '../db/mod.ts';
import type { DbData } from '../db/mod.ts';

export const keysRouter = new Hono();

// GET /api/keys - List all keys with masked values
keysRouter.get('/', async (c) => {
  const db = c.get('db') as DbData;
  const keys = db.api_keys.map((k) => ({
    id: k.id,
    platform: k.platform,
    label: k.label,
    enabled: k.enabled,
    base_url: k.base_url,
    has_key: !!k.encrypted_key,
    masked_key: k.encrypted_key ? `${k.encrypted_key.slice(0, 8)}...${k.encrypted_key.slice(-4)}` : null,
  }));
  return c.json({ keys });
});
