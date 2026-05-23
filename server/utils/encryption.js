"use strict";

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

const DEK_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const TAG_LENGTH = 16; // 128 bits
const DATA_ALGO = "aes-256-gcm";
const WRAP_ALGO = "aes-256-gcm";

// in-memory cache populated by initKeyStore()
let _vaultCache = null;
let _vaultCacheTs = 0;
const _vaultCacheTtl = Number(process.env.VAULT_CACHE_TTL || 60) * 1000;
let _vaultRefreshInterval = null;

function _decodeKey(str) {
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

function _getKekBuffer(keyId = "v1") {
  // Accept env names like KEK_V1, KEK_v1 or fallback to KEK
  const candidateNames = [];
  const normalized = String(keyId);
  if (/^KEK_/i.test(normalized)) candidateNames.push(normalized.toUpperCase());
  else candidateNames.push(`KEK_${normalized.toUpperCase()}`);
  candidateNames.push("KEK");

  // First: check in-memory vault cache populated by initKeyStore()
  if (_vaultCache && Date.now() - _vaultCacheTs < _vaultCacheTtl) {
    for (const name of candidateNames) {
      if (Object.prototype.hasOwnProperty.call(_vaultCache, name)) {
        try {
          return _decodeKey(String(_vaultCache[name]));
        } catch (err) {
          throw new Error(`invalid KEK in vault ${name}: ${err.message}`);
        }
      }
    }
  }

  // Fallback to environment variables
  for (const name of candidateNames) {
    if (process.env[name]) {
      try {
        return _decodeKey(process.env[name]);
      } catch (err) {
        throw new Error(`invalid KEK in env ${name}: ${err.message}`);
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
  if (process.env.NODE_ENV === "development" && (allowEphemeral === "1" || allowEphemeral === "true")) {
    console.warn(`No KEK found (tried: ${candidateNames.join(", ")}). Generating ephemeral KEK because ALLOW_EPHEMERAL_KEK is set. This KEK will be lost on restart.`);
    return crypto.randomBytes(DEK_LENGTH);
  }
  throw new Error(`no KEK found (tried: ${candidateNames.join(", ")})`);
}

function generateDEK() {
  return crypto.randomBytes(DEK_LENGTH);
}

function encryptMessage(plaintext, dek) {
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

function decryptMessage(ciphertextB64, ivB64, authTagB64, dek) {
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
    throw new Error(`decryption failed: ${err.message}`);
  }
}

// Wrap a DEK with the KEK. KEK may come from env or from a previously-initialized vault cache.
function wrapDEK(dek, keyId = "v1") {
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

function unwrapDEK(wrappedB64, keyId = "v1") {
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
    throw new Error(`failed to unwrap DEK: ${err.message}`);
  }
}

// --- Vault integration (optional) -------------------------------------------------
async function _fetchVaultSecrets() {
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
      throw new Error(`VAULT_ADDR is invalid or insecure: ${String(e && e.message ? e.message : e)}`);
    }
  }

  const base = addr.replace(/\/$/, "");
  const v2 = `${base}/v1/${mount}/data/${path}`;
  const v1 = `${base}/v1/${mount}/${path}`;

  async function _getJson(url) {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(url);
        const httpx = u.protocol === "https:" ? https : http;
        const opts = {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers: { "X-Vault-Token": token, Accept: "application/json" },
        };
        const req = httpx.request(opts, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                return resolve(JSON.parse(body));
              } catch (e) {
                return reject(new Error("invalid json from vault"));
              }
            }
            const err = new Error(`vault responded ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = body;
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
      throw new Error(`failed to fetch secrets from Vault: ${e.message}; ${e2?.message || ""}`);
    }
  }
}

// initKeyStore populates an in-memory cache from Vault when SECRET_PROVIDER=vault
async function initKeyStore() {
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
            // eslint-disable-next-line no-console
            console.error('vault refresh failed', e && e.message ? e.message : e);
          });
        }, refreshMs);
      } catch (e) {
        // ignore interval setup failures
      }
      return;
    }
    throw new Error("empty secret data from vault");
  } catch (e) {
    // surface clear error so server startup can decide how to handle
    throw new Error(`initKeyStore failed: ${e.message}`);
  }
}

// Attempt to refresh the in-memory vault cache by fetching secrets again.
// This helps avoid a situation where the short TTL expires and code falls back
// to env vars (which may be absent when SECRET_PROVIDER=vault).
async function refreshKeyStore() {
  const provider = (process.env.SECRET_PROVIDER || "env").toLowerCase();
  if (provider !== "vault") return;
  try {
    const data = await _fetchVaultSecrets();
    if (data && typeof data === "object") {
      _vaultCache = data;
      _vaultCacheTs = Date.now();
    }
  } catch (e) {
    // propagate error to caller; caller should log but must not crash
    throw e;
  }
}

export { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage, initKeyStore, refreshKeyStore };
