/**
 * Dashboard credential + session primitives.
 *
 * Byte-compatible with FreeLLMAPI's `server/src/lib/password.ts` and
 * `services/auth.ts` so accounts (and hashes) are interchangeable:
 *   - password hashes: `scrypt$<saltHex>$<hashHex>` (N=16384, r=8, p=1, 64-byte key)
 *   - session tokens: 32 random bytes, hex-encoded; only SHA-256(token) is stored
 */
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const SALT_BYTES = 16;
const KEYLEN = 64;

/** Session lifetime, matching FreeLLMAPI (30 days). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The one spelling of an address the DB is keyed on. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Mint a session token (returned to the client, never persisted raw). */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** What actually lands in the `sessions` table. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
