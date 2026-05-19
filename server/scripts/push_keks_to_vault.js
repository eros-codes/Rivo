#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import readline from "node:readline";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-d") out.dry = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a.startsWith("--k1-id=")) out.k1Id = a.split("=")[1];
    else if (a.startsWith("--k2-id=")) out.k2Id = a.split("=")[1];
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
}

function usage() {
  console.log(`Usage: node server/scripts/push_keks_to_vault.js [--dry-run]

This helper writes KEK_V1 and KEK_V2 into Vault KV (v2) under VAULT_KV_MOUNT/VAULT_KV_PATH.
Environment:
  VAULT_ADDR (required) e.g. http://127.0.0.1:8200
  VAULT_TOKEN (required)
  VAULT_KV_MOUNT (optional, default: secret)
  VAULT_KV_PATH (optional, default: rivo)
  KEK_V1, KEK_V2 (optional; if missing you'll be prompted)

Options:
  --dry-run   Show payload but don't write to Vault
`);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function writeToVault(addr, token, mount, path, payload) {
  const base = addr.replace(/\/$/, "");
  const url = new URL(`${base}/v1/${mount}/data/${path}`);
  const httpx = url.protocol === "https:" ? https : http;

  const body = JSON.stringify({ data: payload });

  const opts = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      "X-Vault-Token": token,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = httpx.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, body: data });
        const err = new Error(`vault write failed ${res.statusCode}`);
        err.body = data;
        return reject(err);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const preArgs = parseArgs(process.argv.slice(2));
  if (preArgs.help) {
    usage();
    process.exit(0);
  }

  const addr = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  const mount = process.env.VAULT_KV_MOUNT || "secret";
  const path = process.env.VAULT_KV_PATH || "rivo";

  if (!addr || !token) {
    console.error("Please set VAULT_ADDR and VAULT_TOKEN in your environment before running this script.");
    console.error("Example (PowerShell): $env:VAULT_ADDR='http://127.0.0.1:8200'; $env:VAULT_TOKEN='s.xxxx'; node server/scripts/push_keks_to_vault.js");
    process.exit(2);
  }

  let kek1 = process.env.KEK_V1 || "";
  let kek2 = process.env.KEK_V2 || "";
  const args = parseArgs(process.argv.slice(2));
  const k1Id = args.k1Id || "KEK_V1";
  const k2Id = args.k2Id || "KEK_V2";
  const force = !!args.force;

  // helper to fetch existing secrets at path
  async function fetchExisting() {
    try {
      const base = addr.replace(/\/$/, "");
      const url = `${base}/v1/${mount}/data/${path}`;
      const u = new URL(url);
      const httpx = u.protocol === "https:" ? https : http;
      const opts = { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, headers: { "X-Vault-Token": token, Accept: "application/json" } };
      return await new Promise((resolve, reject) => {
        const req = httpx.request(opts, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = JSON.parse(body);
                // KV v2 shape
                if (json && json.data && json.data.data) return resolve(json.data.data);
                return resolve(json.data || {});
              } catch (e) {
                return resolve({});
              }
            }
            return resolve({});
          });
        });
        req.on("error", () => resolve({}));
        req.end();
      });
    } catch (e) {
      return {};
    }
  }

  if (!kek1) {
    kek1 = await ask(`${k1Id} (base64 or hex, empty to cancel): `);
    if (!kek1) {
      console.error(`${k1Id} required`);
      process.exit(3);
    }
  }
  if (!kek2) {
    kek2 = await ask(`${k2Id} (base64 or hex, empty to skip): `);
  }

  const payload = {};
  payload[k1Id] = kek1;
  if (kek2) payload[k2Id] = kek2;

  console.log(`Vault target: ${addr} (mount=${mount}, path=${path})`);

  // check existing
  const existing = await fetchExisting();
  const conflicts = [];
  for (const key of Object.keys(payload)) {
    if (Object.prototype.hasOwnProperty.call(existing, key) && !force) conflicts.push(key);
  }
  if (conflicts.length > 0) {
    console.error(`Refusing to overwrite existing keys: ${conflicts.join(", ")}. Use --force to override or choose different key ids.`);
    process.exit(4);
  }

  if (args.dry) {
    console.log("Dry run payload keys:", Object.keys(payload));
    console.log("Run without --dry-run to actually write to Vault.");
    process.exit(0);
  }

  try {
    const res = await writeToVault(addr, token, mount, path, payload);
    console.log("Vault write succeeded");
    try {
      const j = JSON.parse(res.body);
      console.log(j);
    } catch (e) {
      // ignore
    }
  } catch (e) {
    console.error("Vault write failed:", e.message);
    if (e.body) console.error(e.body);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
