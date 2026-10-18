/**
 * OpenLLM - FreeLLMAPI Deno Deploy Edition
 *
 * LLM API gateway with FreeLLMAPI React SPA frontend.
 * Uses Prisma Postgres (DATABASE_URL injected by Deno Deploy).
 *
 * Architecture:
 *  - /v1/*     OpenAI-compatible chat endpoint
 *  - /api/*    Dashboard API (contract-compliant layer)
 *  - /         FreeLLMAPI React SPA (static files)
 *  - /health   process health check
 */

import { Hono } from "hono";
import { getDb, loadDb, type DbData } from "./db/mod.ts";
import { chatRouter } from "./routes/chat.ts";
import { getModels } from "./routes/models.ts";
import { discoverModels, testProvider } from "./services/discovery.ts";
import {
  saveApiKey, saveModels, initDb as initPg,
  getApiKey, listApiKeys, getModels as getDiscoveredModels, isFreshDiscovery,
  saveSetting, getSetting, getAllSettings,
} from "./db/pg.ts";
import { apiCompat } from "./routes/api.ts";
import { runDiscoveryCron } from "./services/cron-discovery.ts";

const app = new Hono<{ Variables: { db: DbData } }>();

// ── DB seed (Postgres-only) ─────────────────────────────────────────────────

await loadDb("db/data.json");

if (Deno.env.get("DATABASE_URL")) {
  try {
    await initPg();
    const existing = await listApiKeys();
    if (existing.length === 0) {
      for (const k of getDb().api_keys) {
        await saveApiKey({
          id: k.platform, platform: k.platform, label: k.label,
          encrypted_key: k.encrypted_key, iv: k.iv, auth_tag: k.auth_tag,
          status: k.status, enabled: k.enabled, base_url: k.base_url,
        });
      }
      console.log(`[openllm] seeded ${getDb().api_keys.length} api keys into Postgres`);
    } else {
      getDb().api_keys = (await listApiKeys()).map((k, i) => ({
        id: i + 1, platform: k.platform, label: k.label ?? "",
        encrypted_key: k.encrypted_key ?? "", iv: k.iv ?? "",
        auth_tag: k.auth_tag ?? "", status: k.status ?? "healthy",
        enabled: k.enabled, base_url: k.base_url ?? "",
      })) as never;
      console.log(`[openllm] loaded ${existing.length} api keys from Postgres`);
    }
  } catch (e) {
    console.error("[openllm] Postgres init failed, falling back to file DB:", e);
  }
} else {
  console.log("[openllm] DATABASE_URL not set — file DB only");
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  c.set("db", getDb());
  await next();
});

// ── V1 OpenAI-compatible router ──────────────────────────────────────────────

app.route("/v1", chatRouter);
app.get("/v1/models", getModels);

// ── Dashboard API (contract-compliant layer) ─────────────────────────────────

app.route("/api", apiCompat);

// ── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString(), hostname: Deno.hostname(), storage: "Prisma Postgres" }));

// ── Static Files (FreeLLMAPI React SPA) ──────────────────────────────────────

const DIST = `${Deno.cwd()}/dist`;

app.all("*", async (c) => {
  const path = c.req.path;
  if (path.startsWith("/api/") || path.startsWith("/v1/") || path === "/health") return c.notFound();
  const filePath = path === "/" ? "/index.html" : path;
  try {
    const file = await Deno.readFile(DIST + filePath);
    const ext = filePath.split(".").pop() ?? "";
    const ct: Record<string, string> = {
      html: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8",
      css: "text/css; charset=utf-8", svg: "image/svg+xml", woff2: "font/woff2", json: "application/json",
    };
    return c.body(file, 200, {
      "Content-Type": ct[ext] ?? "application/octet-stream",
      "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
  } catch {
    // fall through to index.html
  }
  try {
    const idx = await Deno.readFile(DIST + "/index.html");
    return c.body(idx, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  } catch {
    return c.json({ error: "dist/ not found" }, 500);
  }
});

// ── Cron Jobs (native Deno.cron) ─────────────────────────────────────────────
// Auto-discovers models for all enabled providers every 6 hours.
// Deno.cron requires --unstable-cron flag locally; on Deno Deploy it's enabled.
// Guard so local file-mode runs don't crash.
try {
  Deno.cron("auto-discover", "0 */6 * * *", async () => {
    const results = await runDiscoveryCron();
    for (const [platform, info] of Object.entries(results)) {
      if (info.error) {
        console.error(`[cron][${platform}] error: ${info.error}`);
      } else {
        console.log(`[cron][${platform}] discovered ${info.total} models`);
      }
    }
  });
} catch {
  console.log("[openllm] Deno.cron unavailable (local run) — skipping auto-discover cron");
}

// ── Start ────────────────────────────────────────────────────────────────────

const port = Number(Deno.env.get("PORT") || "9999");
console.log(`[openllm] starting on :${port} (Prisma Postgres)`);
Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
