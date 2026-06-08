#!/usr/bin/env node
import http from "node:http";

const PORT = Number(process.env.MOCK_VAULT_PORT || 8200);
const TOKEN = process.env.MOCK_VAULT_TOKEN || "s.test";
const MOUNT = process.env.VAULT_KV_MOUNT || "secret";

const store = Object.create(null); // path -> data object

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url, `http://${host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const tokenHeader = String(req.headers["x-vault-token"] || "");

    // Basic token check (if TOKEN set)
    if (TOKEN && tokenHeader !== TOKEN) {
      return sendJson(res, 403, { errors: ["invalid token"] });
    }

    // POST /v1/{mount}/data/{path}  (KV v2 write)
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === MOUNT && parts[2] === "data") {
      const keypath = parts.slice(3).join("/");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (j && j.data && typeof j.data === "object") {
            store[keypath] = j.data;
            return sendJson(res, 200, { data: { created_time: new Date().toISOString(), version: 1 } });
          }
          return sendJson(res, 400, { errors: ["bad payload"] });
        } catch (e) {
          return sendJson(res, 400, { errors: ["invalid json"] });
        }
      });
      return;
    }

    // GET /v1/{mount}/data/{path}  (KV v2 read)
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === MOUNT && parts[2] === "data") {
      const keypath = parts.slice(3).join("/");
      const data = store[keypath] || {};
      return sendJson(res, 200, { data: { data } });
    }

    // GET /v1/{mount}/{path}  (KV v1 read)
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === MOUNT) {
      const keypath = parts.slice(2).join("/");
      const data = store[keypath] || {};
      return sendJson(res, 200, { data });
    }

    return sendJson(res, 404, { errors: ["not found"] });
  } catch (err) {
    return sendJson(res, 500, { errors: [String(err)] });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock Vault server listening on http://127.0.0.1:${PORT} (token=${TOKEN})`);
  console.log("Accepts KV v2 POST/GET at /v1/<mount>/data/<path>");
});
