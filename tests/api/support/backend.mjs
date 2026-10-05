// How the API tests reach a real Rivo server: started here (node
// server/index.ts) on a free port against the test database, emails written
// to a file instead of being sent, the database inspected with Prisma.
//
//   TEST_DATABASE_URL  a database only for tests (its name must contain
//                      "test": the tests write to it). `npm run test:api`
//                      brings its migrations up to date first.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

export const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export function testDatabaseUrl() {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error("TEST_DATABASE_URL is not set: point it at a database used only for tests (see docs/ARCHITECTURE.md → Tests).");
	const name = new URL(url).pathname.slice(1);
	if (!/test/i.test(name)) throw new Error(`TEST_DATABASE_URL names the database "${name}". The tests write to it, so its name must contain "test".`);
	return url;
}

function freePort() {
	return new Promise((res, rej) => {
		const s = createServer();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
}

const servers = new Map(); // base URL → { mailFile }

/** Settings every test server gets: fast password hashing, limits out of the way. */
export function testEnv(port, mailFile, extra = {}) {
	return {
		NODE_ENV: "test",
		PORT: String(port),
		APP_URL: `http://localhost:${port}`,
		ALLOWED_ORIGINS: `http://localhost:${port}`,
		JWT_SECRET: randomBytes(32).toString("hex"),
		// one key for every test server: they share the database (and nothing
		// from a developer's .env, like a key vault, applies)
		KEK_V1: createHash("sha256").update("rivo-test-kek").digest("base64"),
		ACTIVE_KEY_ID: "v1",
		SECRET_PROVIDER: "",
		ENABLE_TRUST_PROXY: "",
		SENTRY_DSN: "",
		MAIL_CAPTURE_FILE: mailFile,
		BCRYPT_ROUNDS: "4",
		HTTP_RATE_MAX: "100000",
		AUTH_RATE_MAX: "100000",
		SOCKET_RATE_MAX: "200",
		SOCKET_CONN_ATTEMPT_MAX: "100000",
		VERIFICATION_SEND_LIMIT: "100000",
		LOG_LEVEL: process.env.LOG_LEVEL || "warn",
		...extra,
	};
}

/** Starts a server; resolves once /api/health answers. */
export async function startServer(extraEnv = {}) {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "rivo-test-"));
	const mailFile = join(dir, "mails.jsonl");
	const settings = testEnv(port, mailFile, extraEnv);
	const env = { ...process.env, DATABASE_URL: testDatabaseUrl(), ...settings };
	const proc = spawn(process.execPath, ["server/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
	const out = [];
	proc.stdout.on("data", (d) => out.push(d));
	proc.stderr.on("data", (d) => out.push(d));
	const base = `http://localhost:${port}`;
	const log = () => Buffer.concat(out).toString();
	for (let i = 0; i < 200; i++) {
		if (proc.exitCode !== null) throw new Error(`the server stopped while starting:\n${log()}`);
		try {
			const r = await fetch(`${base}/api/health`);
			if (r.ok) break;
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 100));
		if (i === 199) throw new Error(`the server did not start in 20 s:\n${log()}`);
	}
	servers.set(base, { mailFile });
	return {
		base,
		port,
		mailFile,
		/** the server's signing key (to forge an old-style token in a test) */
		jwtSecret: settings.JWT_SECRET,
		log,
		stop: () =>
			new Promise((r) => {
				if (proc.exitCode !== null) return r();
				proc.once("exit", () => r());
				proc.kill("SIGTERM");
			}),
	};
}

/**
 * Runs one of the command-line tools (server/scripts/…) on the test
 * database, with a test server's settings plus `env`.
 * @returns {{ code: number | null, out: string }} exit code and everything it printed
 */
export function runScript(file, args = [], env = {}) {
	const r = spawnSync(process.execPath, [file, ...args], {
		cwd: ROOT,
		env: { ...process.env, ...testEnv(0, join(tmpdir(), "rivo-script-mails.jsonl")), DATABASE_URL: testDatabaseUrl(), ...env },
		encoding: "utf8",
		timeout: 120_000,
	});
	return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The emails a test server has "sent", oldest first. */
export async function mails(base) {
	// (a server started by another process, e.g. Playwright's global setup, names its file in the environment)
	const file = servers.get(base)?.mailFile ?? (base === process.env.E2E_BASE_URL ? process.env.E2E_MAIL_FILE : undefined);
	if (!file || !existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

let prisma = null;
/** Runs one Prisma call on the test database, e.g. db(base, "message", "findUnique", {...}). */
export async function db(base, model, op, args) {
	prisma ??= new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
	return prisma[model][op](args);
}

export async function closeDb() {
	await prisma?.$disconnect();
	prisma = null;
}
