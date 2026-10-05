// A stand-in for HashiCorp Vault's KV store (version 2, plus version 1
// reads), for trying SECRET_PROVIDER=vault on this computer. It keeps
// everything in memory: stop it and the keys are gone. Never on a server.
//
//   npm run mock-vault
//
// MOCK_VAULT_PORT (8200), MOCK_VAULT_TOKEN (s.test) and VAULT_KV_MOUNT
// (secret) come from .env.
import "../env.ts";
import http from "node:http";

if (process.env.NODE_ENV === "production") {
	console.error("The mock Vault keeps keys in memory, unprotected: it does not run with NODE_ENV=production.");
	process.exit(2);
}

const PORT = Number(process.env.MOCK_VAULT_PORT || 8200);
const TOKEN = process.env.MOCK_VAULT_TOKEN || "s.test";
const MOUNT = process.env.VAULT_KV_MOUNT || "secret";

interface Entry {
	data: Record<string, unknown>;
	version: number;
	created: string;
}
const store = new Map<string, Entry>();

function send(res: http.ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 1_000_000) reject(new Error("body too large"));
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
		const parts = url.pathname.split("/").filter(Boolean);
		if (req.headers["x-vault-token"] !== TOKEN) return send(res, 403, { errors: ["permission denied"] });
		if (parts[0] !== "v1" || parts[1] !== MOUNT) return send(res, 404, { errors: [] });

		// KV v2: /v1/<mount>/data/<path>
		if (parts[2] === "data") {
			const key = parts.slice(3).join("/");
			const entry = store.get(key);
			if (req.method === "GET") {
				if (!entry) return send(res, 404, { errors: [] });
				return send(res, 200, { data: { data: entry.data, metadata: { version: entry.version, created_time: entry.created } } });
			}
			if (req.method === "POST" || req.method === "PUT") {
				let body: { data?: unknown; options?: { cas?: unknown } };
				try {
					body = JSON.parse(await readBody(req));
				} catch {
					return send(res, 400, { errors: ["invalid json"] });
				}
				if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return send(res, 400, { errors: ["no data provided"] });
				const current = entry?.version ?? 0;
				// check-and-set, like Vault: refuse when someone wrote in between
				if (body.options?.cas !== undefined && body.options.cas !== current) {
					return send(res, 400, { errors: ["check-and-set parameter did not match the current version"] });
				}
				const next: Entry = { data: body.data as Record<string, unknown>, version: current + 1, created: new Date().toISOString() };
				store.set(key, next);
				return send(res, 200, { data: { version: next.version, created_time: next.created } });
			}
			return send(res, 405, { errors: [] });
		}

		// KV v1 read: /v1/<mount>/<path>
		if (req.method === "GET") {
			const entry = store.get(parts.slice(2).join("/"));
			return entry ? send(res, 200, { data: entry.data }) : send(res, 404, { errors: [] });
		}
		return send(res, 405, { errors: [] });
	} catch (e) {
		return send(res, 500, { errors: [String(e)] });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`mock Vault on http://127.0.0.1:${PORT} (token ${TOKEN}, mount ${MOUNT}); keys live in memory only`);
});
