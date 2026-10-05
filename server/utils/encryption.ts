import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { log } from "./logger.ts";
import { messageOf } from "./errors.ts";

const DEK_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const TAG_LENGTH = 16; // 128 bits
const DATA_ALGO = "aes-256-gcm";
const WRAP_ALGO = "aes-256-gcm";

// in-memory cache populated by initKeyStore()
let _vaultCache: Record<string, unknown> | null = null;
let _vaultCacheTs = 0;
const _vaultCacheTtl = Number(process.env.VAULT_CACHE_TTL || 60) * 1000;
let _vaultRefreshInterval: NodeJS.Timeout | null = null;
// Dev-only ephemeral KEKs, one per key id. They must stay the same for the
// whole process, otherwise nothing wrapped earlier could be unwrapped again.
const _ephemeralKeks = new Map<string, Buffer>();

function _decodeKey(str: string): Buffer {
  if (!str) throw new Error("empty key string");
  // try base64
  try {
    const b = Buffer.from(str, "base64");
    if (b.length === DEK_LENGTH) return b;
  } catch (e) {
    // fallthrough
  }
  // try hex
  try {
    const b = Buffer.from(str, "hex");
    if (b.length === DEK_LENGTH) return b;
  } catch (e) {
    // fallthrough
  }
  throw new Error("KEK must be 32 bytes encoded as base64 or hex");
}

function _getKekBuffer(keyId = "v1"): Buffer {
  // key id "v1" → KEK_V1 (an id given as "KEK_V1" works too). There is no
  // catch-all: a shared fallback would quietly wrap "v2" with some other key
  // when KEK_V2 is missing, and those messages would break the day KEK_V2 is set.
  const normalized = String(keyId);
  const candidateNames = [/^KEK_/i.test(normalized) ? normalized.toUpperCase() : `KEK_${normalized.toUpperCase()}`];

  // First: check in-memory vault cache populated by initKeyStore()
  if (_vaultCache && Date.now() - _vaultCacheTs < _vaultCacheTtl) {
    for (const name of candidateNames) {
      if (Object.prototype.hasOwnProperty.call(_vaultCache, name)) {
        try {
          return _decodeKey(String(_vaultCache[name]));
        } catch (err) {
          throw new Error(`invalid KEK in vault ${name}: ${messageOf(err)}`, { cause: err });
        }
      }
    }
  }

  // When Vault is the authoritative source, silently falling back to env keys
  // could encrypt new messages with the wrong material. Fail loudly instead.
  if ((process.env.SECRET_PROVIDER || "").toLowerCase() === "vault") {
    throw new Error("SECRET_PROVIDER=vault but the key cache is stale/empty — refusing to fall back to env keys");
  }

  // Fallback to environment variables
  for (const name of candidateNames) {
    const value = process.env[name];
    if (value) {
      try {
        return _decodeKey(value);
      } catch (err) {
        throw new Error(`invalid KEK in env ${name}: ${messageOf(err)}`, { cause: err });
      }
    }
  }
  // In development, allow an explicit opt-in to generate an ephemeral KEK.
  // This is destructive across restarts and MUST NOT be enabled in production.
  const allowEphemeral = (process.env.ALLOW_EPHEMERAL_KEK || "").toLowerCase();
  // Prevent accidental use of ephemeral KEK in production
  if (process.env.NODE_ENV === "production" && (allowEphemeral === "1" || allowEphemeral === "true")) {
    throw new Error("ALLOW_EPHEMERAL_KEK must not be used in production");
  }
  if (process.env.NODE_ENV !== "production" && (allowEphemeral === "1" || allowEphemeral === "true")) {
    const cacheKey = candidateNames[0] as string;
    let kek = _ephemeralKeks.get(cacheKey);
    if (!kek) {
      log.warn(`No KEK found (tried: ${candidateNames.join(", ")}). Generating ephemeral KEK because ALLOW_EPHEMERAL_KEK is set. Messages encrypted with it cannot be read after a restart.`);
      kek = crypto.randomBytes(DEK_LENGTH);
      _ephemeralKeks.set(cacheKey, kek);
    }
    return kek;
  }
  throw new Error(`no KEK found (tried: ${candidateNames.join(", ")})`);
}

function generateDEK(): Buffer {
  return crypto.randomBytes(DEK_LENGTH);
}

/** The three base64 parts of an encrypted text, as stored. */
export interface Sealed {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function encryptMessage(plaintext: unknown, dek: Buffer): Sealed {
  if (!Buffer.isBuffer(dek)) throw new TypeError("DEK must be a Buffer");
  if (dek.length !== DEK_LENGTH) throw new TypeError(`DEK must be ${DEK_LENGTH} bytes`);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(DATA_ALGO, dek, iv, { authTagLength: TAG_LENGTH });
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
  const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

function decryptMessage(ciphertextB64: string, ivB64: string, authTagB64: string, dek: Buffer): string {
  if (!Buffer.isBuffer(dek)) throw new TypeError("DEK must be a Buffer");
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");

  if (iv.length !== IV_LENGTH) throw new Error("invalid iv length");
  if (authTag.length !== TAG_LENGTH) throw new Error("invalid auth tag length");

  const decipher = crypto.createDecipheriv(DATA_ALGO, dek, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch (err) {
    // GCM authentication failures will throw here
    throw new Error(`decryption failed: ${messageOf(err)}`, { cause: err });
  }
}

/**
 * A short text that belongs to a message (its quote, its forwarded copy),
 * sealed with the message's DEK and stored as JSON {c, iv, t}.
 */
function sealText(plain: string, dek: Buffer): string {
  const r = encryptMessage(plain, dek);
  return JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
}

/** The text sealText stored. Throws when the value is not one or `dek` does not open it. */
function openText(value: string, dek: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("not a sealed text");
  }
  const s = parsed as { c?: unknown; iv?: unknown; t?: unknown } | null;
  if (!s || typeof s !== "object" || typeof s.c !== "string" || typeof s.iv !== "string" || typeof s.t !== "string") {
    throw new Error("not a sealed text");
  }
  return decryptMessage(s.c, s.iv, s.t, dek);
}

// Wrap a DEK with the KEK. KEK may come from env or from a previously-initialized vault cache.
function wrapDEK(dek: Buffer, keyId = "v1"): string {
  if (!Buffer.isBuffer(dek)) throw new TypeError("DEK must be a Buffer");
  if (dek.length !== DEK_LENGTH) throw new TypeError(`DEK must be ${DEK_LENGTH} bytes`);
  const kek = _getKekBuffer(keyId);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(WRAP_ALGO, kek, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, tag, ciphertext]);
  return out.toString("base64");
}

function unwrapDEK(wrappedB64: string, keyId = "v1"): Buffer {
  const kek = _getKekBuffer(keyId);
  const wrapped = Buffer.from(wrappedB64, "base64");
  if (wrapped.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error("invalid wrapped DEK length");
  const iv = wrapped.slice(0, IV_LENGTH);
  const tag = wrapped.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = wrapped.slice(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(WRAP_ALGO, kek, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  try {
    const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (dek.length !== DEK_LENGTH) throw new Error("unwrapped DEK length mismatch");
    return dek;
  } catch (err) {
    throw new Error(`failed to unwrap DEK: ${messageOf(err)}`, { cause: err });
  }
}

// --- Vault integration (optional) -------------------------------------------------
// (KV v2 answers { data: { data: {…} } }, KV v1 { data: {…} })
type VaultJson = { data?: { data?: Record<string, unknown> } & Record<string, unknown> } | null;
async function _fetchVaultSecrets(): Promise<Record<string, unknown> | undefined> {
  const addr = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  const mount = process.env.VAULT_KV_MOUNT || "secret";
  const path = process.env.VAULT_KV_PATH || "rivo";

  if (!addr || !token) throw new Error("Vault not configured (VAULT_ADDR and VAULT_TOKEN required)");

  // In production, require Vault addresses to use HTTPS to avoid sending
  // the X-Vault-Token header in cleartext over the network.
  if (process.env.NODE_ENV === 'production') {
    try {
      const ua = new URL(addr);
      if (ua.protocol !== 'https:') {
        throw new Error('Vault must use HTTPS in production');
      }
    } catch (e) {
      throw new Error(`VAULT_ADDR is invalid or insecure: ${String(messageOf(e) || e)}`, { cause: e });
    }
  }

  const base = addr.replace(/\/$/, "");
  const v2 = `${base}/v1/${mount}/data/${path}`;
  const v1 = `${base}/v1/${mount}/${path}`;

  async function _getJson(url: string): Promise<VaultJson> {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(url);
        const httpx = u.protocol === "https:" ? https : http;
        const opts = {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers: { "X-Vault-Token": token as string, Accept: "application/json" },
        };
        const req = httpx.request(opts, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              try {
                return resolve(JSON.parse(body));
              } catch (e) {
                return reject(new Error("invalid json from vault"));
              }
            }
            const err = Object.assign(new Error(`vault responded ${res.statusCode}`), { statusCode: res.statusCode, body });
            return reject(err);
          });
        });
        req.on("error", reject);
        req.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  try {
    const json = await _getJson(v2);
    if (json && json.data && json.data.data) return json.data.data;
  } catch (e) {
    // try v1 path
    try {
      const json2 = await _getJson(v1);
      if (json2 && json2.data) return json2.data;
    } catch (e2) {
      throw new Error(`failed to fetch secrets from Vault: ${messageOf(e)}; ${messageOf(e2) || ""}`, { cause: e2 });
    }
  }
  // (an answer without secrets in it)
  return undefined;
}

// initKeyStore populates an in-memory cache from Vault when SECRET_PROVIDER=vault
async function initKeyStore(): Promise<void> {
  const provider = (process.env.SECRET_PROVIDER || "env").toLowerCase();
  if (provider !== "vault") return;
  try {
    const data = await _fetchVaultSecrets();
    if (data && typeof data === "object") {
      _vaultCache = data;
      _vaultCacheTs = Date.now();
      // schedule periodic refresh to avoid cache expiry gaps
      try {
        const refreshMs = Math.max(1000, Math.floor(_vaultCacheTtl * 0.8));
        if (_vaultRefreshInterval) clearInterval(_vaultRefreshInterval);
        _vaultRefreshInterval = setInterval(() => {
          refreshKeyStore().catch((e) => {
            // Log but do not crash the process
            log.error('vault refresh failed', messageOf(e) || e);
          });
        }, refreshMs);
        // the refresh alone does not keep a process running (a script that
        // is done would otherwise never exit; the server has its listener)
        _vaultRefreshInterval.unref();
      } catch (e) {
        // ignore interval setup failures
      }
      return;
    }
    throw new Error("empty secret data from vault");
  } catch (e) {
    // surface clear error so server startup can decide how to handle
    throw new Error(`initKeyStore failed: ${messageOf(e)}`, { cause: e });
  }
}

// Attempt to refresh the in-memory vault cache by fetching secrets again.
// This helps avoid a situation where the short TTL expires and code falls back
// to env vars (which may be absent when SECRET_PROVIDER=vault).
async function refreshKeyStore(): Promise<void> {
  const provider = (process.env.SECRET_PROVIDER || "env").toLowerCase();
  if (provider !== "vault") return;
  const data = await _fetchVaultSecrets();
  if (data && typeof data === "object") {
    _vaultCache = data;
    _vaultCacheTs = Date.now();
  }
}

export { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage, sealText, openText, initKeyStore, refreshKeyStore };
