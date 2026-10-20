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
import type { Context, Next } from "hono";
import { getDb, loadDb, setEncryptionKey, hasEncryptionKey, type DbData } from "./db/mod.ts";
import { chatRouter } from "./routes/chat.ts";
import { getModels } from "./routes/models.ts";
import { apiCompat } from "./routes/api.ts";
import { authRouter, ensureSetupCodeLogged } from "./routes/auth.ts";
import { dashboardRouter } from "./routes/dashboard.ts";
import { premiumRouter } from "./routes/premium.ts";
// P1 inbound protocol gateways
import anthropicRouter from "./routes/anthropic.ts";
import responsesRouter from "./routes/responses.ts";
import moderationsRouter from "./routes/moderations.ts";
import embeddingsRouter from "./routes/embeddings.ts";
import mediaRouter from "./routes/media.ts";
import rerankRouter from "./routes/rerank.ts";
import ollamaRouter from "./routes/ollama.ts";
// P2
import transcriptionRouter from "./routes/transcriptions.ts";
import analyticsRouter from "./routes/analytics.ts";
import {
  initDb as initPg,
  listApiKeys,
  saveApiKey,
  saveSetting,
  getAllSettings,
  getSecret,
  getSessionUser,
  setSecret,
} from "./db/pg.ts";
import { hashSessionToken } from "./services/auth.ts";
import { runDiscoveryCron } from "./services/cron-discovery.ts";

const app = new Hono<{ Variables: { db: DbData } }>();

// ── DB seed (Postgres-only) ─────────────────────────────────────────────────

await loadDb("db/data.json");

if (Deno.env.get("DATABASE_URL")) {
  try {
    await initPg();

    const existingSettings = await getAllSettings();

    // Encryption key resolution (Postgres is the source of truth):
    //   1) an existing app_secrets row (never exposed by /api/settings)
    //   2) the key baked into db/data.json (if shipped)
    //   3) the ENCRYPTION_KEY env var
    // Whichever is found is persisted, so later deploys need neither data.json
    // nor the env var.
    const encSettingKey = "__encryption_key";
    const storedEnc = await getSecret(encSettingKey);
    if (storedEnc) {
      setEncryptionKey(storedEnc);
      console.log("[openllm] encryption key loaded from Postgres");
    } else if (hasEncryptionKey()) {
      await setSecret(encSettingKey, getDb().encryption_key);
      console.log("[openllm] encryption key seeded into Postgres from data.json");
    } else {
      const envKey = Deno.env.get("ENCRYPTION_KEY")?.trim();
      if (envKey) {
        setEncryptionKey(envKey);
        await setSecret(encSettingKey, envKey);
        console.log("[openllm] encryption key seeded into Postgres from ENCRYPTION_KEY");
      } else {
        console.warn("[openllm] no encryption key available (Postgres/data.json/ENCRYPTION_KEY) — decryption will fail");
      }
    }

    const existing = await listApiKeys();
    if (existing.length === 0) {
      for (const k of getDb().api_keys) {
        await saveApiKey({
          id: k.platform, platform: k.platform, label: k.label,
          encrypted_key: k.encrypted_key, iv: k.iv, auth_tag: k.auth_tag,
          status: k.status, enabled: k.enabled, base_url: k.base_url,
          db_id: k.id,
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

    // Seed settings once so /api/settings reflects db/data.json on first boot.
    // Migrate any data.json-only settings (e.g. the applied catalog) into
    // Postgres, then read the authoritative set back — so a later deploy that
    // ships no data.json still serves the full catalog.
    const localSettings = getDb().settings;
    let migrated = 0;
    for (const [key, value] of Object.entries(localSettings)) {
      if (!(key in existingSettings)) {
        await saveSetting(key, value);
        migrated++;
      }
    }
    if (migrated) console.log(`[openllm] migrated ${migrated} settings from data.json into Postgres`);
    if (Object.keys(existingSettings).length > 0 || migrated > 0) {
      getDb().settings = (await getAllSettings()) as never;
      console.log(`[openllm] loaded ${Object.keys(getDb().settings).length} settings from Postgres`);
    }

    await ensureSetupCodeLogged();
  } catch (e) {
    console.error("[openllm] Postgres init failed, falling back to file DB:", e);
  }
} else {
  console.log("[openllm] DATABASE_URL not set — file DB only");
  await ensureSetupCodeLogged();
}

// ── Provider Registry Initialization ───────────────────────────────────────────

import { initializeRegistry } from "./providers/index.ts";
initializeRegistry();
console.log("[openllm] provider registry initialized with built-in providers");

// ── Request Logger Initialization ──────────────────────────────────────────────

import { requestLogger, setClientMeta } from "./services/request-log.ts";
import { classifyClientAgent } from "./services/client-classifier.ts";
requestLogger.start();
console.log("[openllm] request logger started (batch flush every 5s)");

// ── Middleware ────────────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  c.set("db", getDb());
  await next();
});

// Caller identity for analytics: which coding agent made this call, and from
// where. Every client shares the unified gateway key, so the User-Agent (plus
// the forwarded ip) is the only per-caller signal — /agents and /analytics group
// by it. Must run before the /v1 routers so their log calls see it.
app.use("*", async (c, next) => {
  const ua = c.req.header("user-agent") ?? "";
  const xff = (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  setClientMeta({
    clientAgent: classifyClientAgent({
      path: c.req.path,
      userAgent: ua,
      claudeCodeSessionId: c.req.header("x-claude-code-session-id"),
      sessionId: c.req.header("x-session-id"),
    }),
    clientIp: xff || undefined,
    clientUserAgent: ua ? ua.slice(0, 300) : undefined,
  });
  await next();
});

// Session gate for the dashboard API. The SPA sends the token from /api/auth/login
// as `Authorization: Bearer <token>` on every call. /api/auth/* stays open (login,
// setup, status); everything else requires the session so key reveal / the unified
// gateway key are never world-readable.
const PUBLIC_API = ["/api/auth/", "/api/health"];
app.use("/api/*", async (c, next) => {
  if (PUBLIC_API.some((p) => c.req.path.startsWith(p))) return next();
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return c.json({ error: { type: "authentication_error", message: "unauthorized" } }, 401);
  }
  const session = await getSessionUser(hashSessionToken(token));
  if (!session) {
    return c.json({ error: { type: "authentication_error", message: "unauthorized" } }, 401);
  }
  await next();
});

// ── V1 OpenAI-compatible router ──────────────────────────────────────────────

app.route("/v1", chatRouter);
app.get("/v1/models", getModels);

// P1 inbound protocol gateways (mounted under /v1 for OpenAI-compatible ones)
app.route("/v1", anthropicRouter);      // /v1/messages
app.route("/v1", responsesRouter);      // /v1/responses
app.route("/v1", moderationsRouter);    // /v1/moderations
app.route("/v1", embeddingsRouter);     // /v1/embeddings, /v1/embeddings/models
app.route("/v1", mediaRouter);          // /v1/images/generations, /v1/audio/speech, /v1/models, /v1/modalities
app.route("/v1", rerankRouter);         // /v1/rerank

// Ollama inbound (mounted at /v1/ollama for API key auth)
app.route("/v1", ollamaRouter);           // /v1/ollama/api/tags, /v1/ollama/api/chat, etc.

app.route("/v1", transcriptionRouter);    // /v1/audio/transcriptions

app.route("/api/analytics", analyticsRouter); // /api/analytics/*

// ── Dashboard API (contract-compliant layer) ─────────────────────────────────

app.route("/api/auth", authRouter);
app.route("/api", apiCompat);
app.route("/api", dashboardRouter);
app.route("/api/premium", premiumRouter);

// ── Health ───────────────────────────────────────────────────────────────────

/** Deno.hostname() needs --allow-sys; never let it turn /health into a 500. */
function safeHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return "unknown";
  }
}

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString(), hostname: safeHostname(), storage: "Prisma Postgres" }));

// ── Static Files (FreeLLMAPI React SPA) ──────────────────────────────────────

const DIST = `${Deno.cwd()}/dist`;

app.all("*", async (c) => {
  const path = c.req.path;
  if (path.startsWith("/api/") || path.startsWith("/v1/") || path === "/health") return c.notFound();

  // Only GET/HEAD serve static content; everything else is a 404.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.notFound();

  // Reject path traversal / NUL bytes before touching the filesystem.
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    return c.notFound();
  }
  if (rel.includes("\0") || rel.split("/").some((s) => s === "..")) return c.notFound();

  const filePath = rel === "/" ? "/index.html" : rel;
  try {
    const file = await Deno.readFile(DIST + filePath);
    const ext = filePath.split(".").pop() ?? "";
    const ct: Record<string, string> = {
      html: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8",
      css: "text/css; charset=utf-8", svg: "image/svg+xml", woff2: "font/woff2", json: "application/json",
    };
    return c.body(file, 200, {
      "Content-Type": ct[ext] ?? "application/octet-stream",
      "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
  } catch {
    // fall through to index.html (SPA client-side routing)
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

// ── Free Model Detection Background Refresh (Phase B Week 9) ───────────────────
// Refreshes pricing cache and clears free model cache every 6 hours.
try {
  import("./providers/free-detect-service.ts").then(({ startBackgroundRefresh }) => {
    startBackgroundRefresh(6 * 60 * 60 * 1000); // 6 hours
    console.log("[openllm] free model detection background refresh started (6h interval)");
  }).catch(() => {
    console.log("[openllm] free-detect-service unavailable — skipping background refresh");
  });
} catch {
  console.log("[openllm] free-detect-service unavailable — skipping background refresh");
}

// Track startup time for uptime metric
(globalThis as any).openllmStartTime = Date.now();

// ── Start ────────────────────────────────────────────────────────────────────

const port = Number(Deno.env.get("PORT") || "9999");
console.log(`[openllm] starting on :${port} (Prisma Postgres)`);
Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
