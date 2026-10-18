/**
 * DB layer: loads settings + api_keys from data.json (exported from SQLite).
 * Uses Deno.crypto.subtle for AES-256-GCM decryption.
 */

export interface DbSettings {
  [key: string]: string;
}

export interface ApiKey {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: boolean;
  base_url: string;
}

/** DbEntry — raw DB row shape coming back from Postgres.
 *  id is a string (Postgres/pg.js stringifies numeric ids); columns are nullable
 *  (encrypted_key / base_url etc. are OPTIONAL on insert).
 *  This is structurally identical to db/pg.ts's own DbEntry so api.ts — which
 *  imports DbEntry from here but calls listApiKeys()/saveApiKey() from pg.ts —
 *  type-checks without `as unknown as AnyKey[]` casts at every boundary.
 *  NOTE: this used to be `type DbEntry = ApiKey` (id: number, non-null fields).
 *  That alias was the lie causing 16 type errors — it described the *dashboard*
 *  contract, not the row. See notes/2026-09-20-hardening-reverted-by-migration
 *  for the same "interface ≠ runtime" class of bug.
 */
export interface DbEntry {
  id: string;          // Platform name (e.g., "groq") - used for provider registry lookup
  db_id: number;       // Database integer ID - used for quota/rate limiting
  platform: string;
  label?: string;
  encrypted_key?: string;
  iv?: string;
  auth_tag?: string;
  status?: string;
  enabled: boolean;
  base_url?: string;
}

export interface DiscoveredModel {
  id: string;
  platform: string;
  displayName: string;
  enabled: boolean;
  isFree?: boolean;
  priceNote?: string;
  contextWindow?: number;
  discoveredAt: number;
}

export interface LicenseStatus {
  valid: boolean;
  plan: 'annual' | 'lifetime' | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

export interface CatalogSyncState {
  baseUrl: string;
  appliedVersion: string | null;
  appliedTier: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
}

export interface DbData {
  encryption_key: string;
  settings: DbSettings;
  api_keys: ApiKey[];
  discovered_models: DiscoveredModel[];
}

// In-memory store (loaded once at startup from data.json)
let _data: DbData | null = null;
let _encKey: Uint8Array | null = null;

const ALGO = "AES-GCM";
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;

/** Convert Uint8Array to BufferSource-compatible ArrayBuffer */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function decryptKey(encryptedHex: string, ivHex: string, authTagHex: string): Promise<string> {
  if (!_encKey) throw new Error("Encryption key not loaded");
  const key = await crypto.subtle.importKey("raw", toBufferSource(_encKey), { name: ALGO, length: 256 }, false, ["decrypt"]);
  const iv = hexToBytes(ivHex);
  const authTag = hexToBytes(authTagHex);
  // Append auth tag to ciphertext for Web Crypto API
  const ciphertext = concatBytes(hexToBytes(encryptedHex), authTag);
  // @ts-ignore: TypeScript type system issue with ArrayBufferLike
  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv, tag: authTag }, key, toBufferSource(ciphertext));
  return bytesToString(new Uint8Array(decrypted));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** An empty in-memory DB used when data.json is unavailable. Postgres is the
 *  source of truth in that case; this keeps getDb()/middleware from throwing. */
function emptyDb(): DbData {
  return { encryption_key: "", settings: {}, api_keys: [], discovered_models: [] };
}

/** Point the crypto layer at a raw hex AES-256 key (also used to source the key
 *  from Postgres/ENCRYPTION_KEY when no data.json is shipped). */
export function setEncryptionKey(hex: string): void {
  _encKey = hex ? hexToBytes(hex) : null;
}

export function hasEncryptionKey(): boolean {
  return _encKey !== null;
}

// Load data from data.json at startup. Missing/invalid file is NOT fatal:
// the deploy artifact excludes db/data.json (see .gitignore), so on Deno Deploy
// this degrades to an empty in-memory DB and Postgres becomes the source of truth.
export async function loadDb(path = "db/data.json"): Promise<DbData> {
  try {
    const text = await Deno.readTextFile(path);
    const data = JSON.parse(text) as DbData;
    _encKey = data.encryption_key ? hexToBytes(data.encryption_key) : null;
    _data = data;
    console.log(`[db] loaded ${Object.keys(data.settings ?? {}).length} settings, ${(data.api_keys ?? []).length} api_keys from ${path}`);
    return data;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(`[db] ${path} unavailable (${reason}) — starting with empty in-memory DB; Postgres is the source of truth`);
    _encKey = null;
    _data = emptyDb();
    return _data;
  }
}

export function getDb(): DbData {
  if (!_data) {
    console.warn("[db] getDb() called before loadDb() — using empty in-memory DB");
    _data = emptyDb();
  }
  return _data;
}

export function getSetting(key: string): string | undefined {
  return _data?.settings[key];
}

export function getAllEnabledKeys(): ApiKey[] {
  return _data?.api_keys.filter((k) => k.enabled) ?? [];
}

export function getAllKeys(): ApiKey[] {
  return _data?.api_keys ?? [];
}

export function getAllDiscoveredModels(): DiscoveredModel[] {
  return _data?.discovered_models ?? [];
}

export function getApiKeyById(id: number): ApiKey | undefined {
  return _data?.api_keys.find((k) => k.id === id);
}

/** Decrypt an api_key's secret. Returns null if decrypt fails. */
export async function decryptKeyValue(key: ApiKey): Promise<string | null> {
  try {
    return await decryptKey(key.encrypted_key, key.iv, key.auth_tag);
  } catch {
    return null;
  }
}

/** Encrypt a plaintext key using AES-256-GCM. Returns { encrypted, iv, authTag } */
export async function encryptKey(plaintext: string): Promise<{ encrypted: string; iv: string; authTag: string }> {
  if (!_encKey) throw new Error("Encryption key not loaded");
  const key = await crypto.subtle.importKey("raw", toBufferSource(_encKey), { name: ALGO, length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: ALGO, iv }, key, plaintextBytes);
  const encryptedBytes = new Uint8Array(encrypted);
  // Split ciphertext and auth tag (last 16 bytes are auth tag)
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - AUTH_TAG_LEN);
  const authTag = encryptedBytes.slice(encryptedBytes.length - AUTH_TAG_LEN);
  return {
    encrypted: bytesToHex(ciphertext),
    iv: bytesToHex(iv),
    authTag: bytesToHex(authTag),
  };
}

/** Return the encryption key fingerprint (first 8 hex chars) for logging. */
export async function exportEncKeyFingerprint(): Promise<string> {
  if (!_encKey) return "(none)";
  const buf = await crypto.subtle.digest("SHA-256", toBufferSource(_encKey));
  return bytesToHex(new Uint8Array(buf)).slice(0, 8);
}

/** Map platform name to its default base URL. */
export function getBaseUrlForPlatform(platform: string): string {
  const map: Record<string, string> = {
    agnes: "https://apihub.agnes-ai.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    groq: "https://api.groq.com/openai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    zhipu: "https://open.bigmodel.cn/api/paas/v4",
    radeon: "https://cloud.radeon.com/openai/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    kilo: "https://api.kilo.com/v1",
    sail: "https://api.sailresearch.com/v1",
    openai: "https://api.openai.com/v1",
    ovh: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    ollama: "https://ollama.com/v1",
    mistral: "https://api.mistral.ai/v1",
  };
  return map[platform] ?? `https://api.${platform}.com/v1`;
}

/** Per-provider chat completions path prefix.
 * Most providers use /v1/chat/completions, but some differ:
 * - Groq: /openai/v1/chat/completions
 * - OpenAI: /v1/chat/completions (default)
 * - OpenRouter: /api/v1/chat/completions (already in baseUrl)
 */

/** License key related settings */
export const SETTING_LICENSE_KEY = 'premium_license_key';
export const SETTING_LICENSE_STATUS = 'premium_license_status';
export const SETTING_APPLIED_VERSION = 'catalog_applied_version';
export const SETTING_APPLIED_TIER = 'catalog_applied_tier';
export const SETTING_APPLIED_JSON = 'catalog_applied_json';
export const SETTING_LAST_SYNC_MS = 'catalog_last_sync_ms';
export const SETTING_LAST_ERROR = 'catalog_last_error';

/** Get license key from settings */
export function getLicenseKey(): string | undefined {
  return getSetting(SETTING_LICENSE_KEY);
}

/** Set license key in settings */
export function setLicenseKey(key: string): void {
  if (!_data) throw new Error("DB not loaded");
  if (key) {
    _data.settings[SETTING_LICENSE_KEY] = key;
  } else {
    delete _data.settings[SETTING_LICENSE_KEY];
  }
}

/** Get license status from settings */
export function getLicenseStatus(): LicenseStatus | null {
  const statusStr = getSetting(SETTING_LICENSE_STATUS);
  if (!statusStr) return null;
  try {
    return JSON.parse(statusStr) as LicenseStatus;
  } catch {
    return null;
  }
}

/** Set license status in settings */
export function setLicenseStatus(status: LicenseStatus): void {
  if (!_data) throw new Error("DB not loaded");
  _data.settings[SETTING_LICENSE_STATUS] = JSON.stringify(status);
}

/** Get applied catalog version */
export function getAppliedVersion(): string | undefined {
  return getSetting(SETTING_APPLIED_VERSION);
}

/** Set applied catalog version */
export function setAppliedVersion(version: string | null): void {
  if (!_data) throw new Error("DB not loaded");
  if (version === null) {
    delete _data.settings[SETTING_APPLIED_VERSION];
  } else {
    _data.settings[SETTING_APPLIED_VERSION] = version;
  }
}

/** Get applied catalog tier */
export function getAppliedTier(): string | undefined {
  return getSetting(SETTING_APPLIED_TIER);
}

/** Set applied catalog tier */
export function setAppliedTier(tier: string | null): void {
  if (!_data) throw new Error("DB not loaded");
  if (tier === null) {
    delete _data.settings[SETTING_APPLIED_TIER];
  } else {
    _data.settings[SETTING_APPLIED_TIER] = tier;
  }
}

/** Get applied catalog JSON */
export function getAppliedJson(): string | undefined {
  return getSetting(SETTING_APPLIED_JSON);
}

/** Set applied catalog JSON */
export function setAppliedJson(json: string | null): void {
  if (!_data) throw new Error("DB not loaded");
  if (json === null) {
    delete _data.settings[SETTING_APPLIED_JSON];
  } else {
    _data.settings[SETTING_APPLIED_JSON] = json;
  }
}

/** Get last sync timestamp */
export function getLastSyncMs(): number | undefined {
  const str = getSetting(SETTING_LAST_SYNC_MS);
  return str ? parseInt(str, 10) : undefined;
}

/** Set last sync timestamp */
export function setLastSyncMs(timestamp: number | null): void {
  if (!_data) throw new Error("DB not loaded");
  if (timestamp === null) {
    delete _data.settings[SETTING_LAST_SYNC_MS];
  } else {
    _data.settings[SETTING_LAST_SYNC_MS] = timestamp.toString();
  }
}

/** Get last error */
export function getLastError(): string | undefined {
  return getSetting(SETTING_LAST_ERROR);
}

/** Set last error */
export function setLastError(error: string | null): void {
  if (!_data) throw new Error("DB not loaded");
  if (error === null) {
    delete _data.settings[SETTING_LAST_ERROR];
  } else {
    _data.settings[SETTING_LAST_ERROR] = error;
  }
}

/** The Ed25519 public key the production catalog is signed with */
export const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----`;

/** 验证Ed25519签名 */
export async function verifyEd25519Signature(signature: Uint8Array, data: Uint8Array, publicKeyPEM: string = PINNED_CATALOG_PUBKEY): Promise<boolean> {
 try {
   // 导入公钥
   const publicKey = await crypto.subtle.importKey(
     "spki",
     // @ts-ignore: TypeScript type system issue with ArrayBufferLike
    toBufferSource(pemToDer(publicKeyPEM)),
     { name: "ED25519" },
     false,
     ["verify"]
   );

   // 验证签名
   return await crypto.subtle.verify(
     "ED25519",
     publicKey,
     // @ts-ignore: TypeScript type system issue with ArrayBufferLike
     signature,
     toBufferSource(data)
   );
 } catch (e) {
   console.error("Ed25519 signature verification failed:", e);
   return false;
 }
}

/** 将PEM格式的公钥转换为DER格式 */
function pemToDer(pem: string): Uint8Array {
 const lines = pem.split('\n');
 // 移除头尾行
 const content = lines.slice(1, -1).join('');
 // 解码Base64
 const binary = atob(content);
 const bytes = new Uint8Array(binary.length);
 for (let i = 0; i < binary.length; i++) {
   bytes[i] = binary.charCodeAt(i);
 }
 return bytes;
}


