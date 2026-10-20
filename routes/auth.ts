/**
 * /api/auth/* — dashboard auth, contract-compatible with the FreeLLMAPI SPA.
 *
 * Storage matches upstream FreeLLMAPI exactly: accounts in `users` (email +
 * scrypt `password_hash`) and SHA-256 hashed session tokens in `sessions`. This
 * is deliberate — accounts created in the original app remain valid here, which
 * the previous single-admin settings scheme (`admin_password_hash` /
 * `admin_email`) could not do (it also ignored the submitted email entirely, so
 * a correct password for a different account always returned "Invalid email or
 * password").
 *
 *   GET  /api/auth/status          -> { needsSetup, authenticated, email }
 *   POST /api/auth/setup           <- { email, password, setupCode? } -> { token, email }
 *   POST /api/auth/login           <- { email, password }             -> { token, email }
 *   POST /api/auth/logout          -> { ok: true, success: true }
 *   GET  /api/auth/me              -> { email }
 *   POST /api/auth/change-password <- { currentPassword, newPassword } -> { ok, success }
 *   POST /api/auth/change-email    <- { currentPassword, newEmail }    -> { ok, success, email }
 *   POST /api/auth/forgot-password -> { ok, success } (reset code logged)
 *   POST /api/auth/reset-password  <- { resetCode, newPassword } -> { token, email }
 * Errors use the SPA's shape: { error: { type, message } }.
 */
import { Hono, type Context } from "hono";
import { getSecret, setSecret } from "../db/pg.ts";
import {
  countUsers,
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  getFirstUser,
  getSessionUser,
  getUserByEmail,
  updateUserEmail,
  updateUserPassword,
} from "../db/pg.ts";
import {
  SESSION_TTL_MS,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  normalizeEmail,
  verifyPassword,
} from "../services/auth.ts";

export const authRouter = new Hono();

const SETUP_CODE_SECRET = "__setup_code";
const RESET_CODE_SECRET = "__reset_code";
const RESET_EXP_SECRET = "__reset_code_exp";
const RESET_TTL_MS = 15 * 60 * 1000;

function bearerToken(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (!auth) return null;
  return auth.replace(/^Bearer\s+/i, "").trim() || null;
}

/** Resolve the session user for the current request, or null. */
export async function currentUser(c: Context): Promise<{ userId: number; email: string } | null> {
  const token = bearerToken(c);
  if (!token) return null;
  return await getSessionUser(hashSessionToken(token));
}

async function issueSession(userId: number, email: string) {
  const token = newSessionToken();
  await createSession(hashSessionToken(token), userId, Date.now() + SESSION_TTL_MS);
  return { token, email };
}

/** Unambiguous alphabet (no 0/O/1/I/l) so a code from the logs is easy to type. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(len = 8): string {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function fail(c: Context, status: number, type: string, message: string) {
  return c.json({ error: { type, message } }, status as 400);
}

// One-time setup code. Persisted (survives restart) and cached in-memory (also
// works without Postgres). A `SETUP_CODE` env var overrides it so an operator
// can set a known value instead of digging through logs.
let _setupCode: string | null = null;
async function getOrCreateSetupCode(): Promise<string> {
  const fromEnv = Deno.env.get("SETUP_CODE")?.trim();
  if (fromEnv) return fromEnv;
  if (_setupCode) return _setupCode;
  let code = await getSecret(SETUP_CODE_SECRET);
  if (!code) {
    code = randomCode();
    await setSecret(SETUP_CODE_SECRET, code);
  }
  return (_setupCode = code);
}

async function needsSetup(): Promise<boolean> {
  return (await countUsers()) === 0;
}

/** Log the setup code at boot when the dashboard has not been set up yet. */
export async function ensureSetupCodeLogged(): Promise<void> {
  if (await needsSetup()) {
    if (Deno.env.get("SETUP_CODE")?.trim()) {
      console.log("[openllm] dashboard not set up — using SETUP_CODE from env");
      return;
    }
    const code = await getOrCreateSetupCode();
    console.log(`[openllm] dashboard not set up — setup code: ${code}`);
  }
}

// ── Brute-force throttle (in-memory, per email) ───────────────────────────────
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(email: string): boolean {
  const a = attempts.get(email);
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const a = attempts.get(email) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(email, a);
}
function clearFailures(email: string): void {
  attempts.delete(email);
}

authRouter.get("/status", async (c) => {
  const setup = await needsSetup();
  const user = setup ? null : await currentUser(c);
  return c.json({ needsSetup: setup, authenticated: !!user, email: user?.email ?? null });
});

authRouter.get("/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "authentication_error", "Authentication required");
  return c.json({ email: user.email });
});

authRouter.post("/setup", async (c) => {
  if (!(await needsSetup())) {
    return fail(c, 409, "setup_complete", "Setup already completed. Use login instead.");
  }
  const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string; setupCode?: string };
  const email = normalizeEmail(body.email ?? "");
  const password = body.password ?? "";
  if (!isValidEmail(email)) return fail(c, 400, "invalid_email", "A valid email is required");
  if (password.length < 8) return fail(c, 400, "weak_password", "Password must be at least 8 characters");

  const code = await getOrCreateSetupCode();
  if ((body.setupCode ?? "").trim() !== code) {
    return fail(c, 403, "setup_code_required", "A setup code is required to create the first account. Check the server logs, or set the SETUP_CODE env var.");
  }

  const user = await createUser(email, hashPassword(password));
  _setupCode = null;
  return c.json(await issueSession(user.id, user.email), 201);
});

authRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
  const email = normalizeEmail(body.email ?? "");
  const password = body.password ?? "";
  if (!email || !password) return fail(c, 400, "invalid_request", "Email and password are required");

  if (isLockedOut(email)) {
    c.header("Retry-After", String(LOCKOUT_MS / 1000));
    return fail(c, 429, "rate_limit_error", "Too many attempts. Wait 15 minutes or restart the app.");
  }

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(email);
    return fail(c, 401, "authentication_error", "Invalid email or password");
  }

  clearFailures(email);
  return c.json(await issueSession(user.id, user.email));
});

authRouter.post("/logout", async (c) => {
  const token = bearerToken(c);
  if (token) await deleteSession(hashSessionToken(token));
  return c.json({ ok: true, success: true });
});

authRouter.post("/change-password", async (c) => {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "authentication_error", "Authentication required");
  const body = await c.req.json().catch(() => ({})) as { currentPassword?: string; newPassword?: string };
  const full = await getUserByEmail(user.email);
  if (!full || !body.currentPassword || !verifyPassword(body.currentPassword, full.password_hash)) {
    return fail(c, 403, "invalid_password", "Current password is incorrect");
  }
  if (!body.newPassword || body.newPassword.length < 8) {
    return fail(c, 400, "weak_password", "Password must be at least 8 characters");
  }
  await updateUserPassword(user.userId, hashPassword(body.newPassword));
  return c.json({ ok: true, success: true });
});

authRouter.post("/change-email", async (c) => {
  const user = await currentUser(c);
  if (!user) return fail(c, 401, "authentication_error", "Authentication required");
  const body = await c.req.json().catch(() => ({})) as { currentPassword?: string; newEmail?: string };
  const full = await getUserByEmail(user.email);
  if (!full || !body.currentPassword || !verifyPassword(body.currentPassword, full.password_hash)) {
    return fail(c, 403, "invalid_password", "Current password is incorrect");
  }
  const email = normalizeEmail(body.newEmail ?? "");
  if (!isValidEmail(email)) return fail(c, 400, "invalid_email", "A valid email is required");
  if (email !== user.email && await getUserByEmail(email)) {
    return fail(c, 409, "email_taken", "An account with that email already exists");
  }
  await updateUserEmail(user.userId, email);
  return c.json({ ok: true, success: true, email });
});

authRouter.post("/forgot-password", async (c) => {
  // Always 200 to avoid account enumeration.
  const user = await getFirstUser();
  if (!user) return c.json({ ok: true, success: true });
  const code = randomCode();
  await setSecret(RESET_CODE_SECRET, code);
  await setSecret(RESET_EXP_SECRET, String(Date.now() + RESET_TTL_MS));
  console.log(`[openllm] password reset code: ${code} (valid ${RESET_TTL_MS / 60000} min)`);
  return c.json({ ok: true, success: true });
});

authRouter.post("/reset-password", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { resetCode?: string; newPassword?: string };
  const stored = await getSecret(RESET_CODE_SECRET);
  const exp = Number(await getSecret(RESET_EXP_SECRET) ?? "0");
  const given = (body.resetCode ?? "").trim();
  if (!stored || stored !== given || !Number.isFinite(exp) || Date.now() > exp) {
    return fail(c, 403, "invalid_reset_code", "Invalid or expired reset code");
  }
  if (!body.newPassword || body.newPassword.length < 8) {
    return fail(c, 400, "weak_password", "Password must be at least 8 characters");
  }
  const user = await getFirstUser();
  if (!user) return fail(c, 404, "not_found", "No account found");
  await updateUserPassword(user.id, hashPassword(body.newPassword));
  await setSecret(RESET_CODE_SECRET, "");
  await setSecret(RESET_EXP_SECRET, "0");
  // The code already proved control of the install; sign straight in.
  await deleteUserSessions(user.id);
  return c.json(await issueSession(user.id, user.email));
});


export default authRouter;
