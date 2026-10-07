// How the tests reach a real Rivo server: started here (node server/index.ts)
// on a free port against the test database, emails written to a file instead
// of being sent, the database inspected with Prisma (the server's own client,
// on the test database).
//
//   TEST_DATABASE_URL  a database only for tests (its name must contain
//                      "test": the tests write to it). `npm run test:api`
//                      brings its migrations up to date first.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../../server/prisma.ts";
import type { ProcessStats } from "../../server/utils/processStats.ts";

export type { ProcessStats };

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function testDatabaseUrl(): string {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error("TEST_DATABASE_URL is not set: point it at a database used only for tests (see docs/ARCHITECTURE.md → Tests).");
	const name = new URL(url).pathname.slice(1);
	if (!/test/i.test(name)) throw new Error(`TEST_DATABASE_URL names the database "${name}". The tests write to it, so its name must contain "test".`);
	return url;
}

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as AddressInfo;
			s.close(() => res(port));
		});
	});
}

/** Environment variables, by name. */
export type Env = Record<string, string>;

/** An email a test server "sent" (written to its capture file). */
export interface Mail {
	to: string;
	subject: string;
	text: string;
	html: string;
	at: string;
}

export interface TestServer {
	/** http://localhost:<port> */
	base: string;
	port: number;
	/** where its emails go */
	mailFile: string;
	/** its signing key (to forge a token in a test) */
	jwtSecret: string;
	/** everything it printed so far */
	log(): string;
	/** the server process's own figures (CPU, memory, event loop), or null if it did not answer within 5 s */
	stats(): Promise<ProcessStats | null>;
	stop(): Promise<void>;
}

const servers = new Map<string, { mailFile: string }>();

/** Settings every test server gets: fast password hashing, limits out of the way. */
export function testEnv(port: number, mailFile: string, extra: Env = {}): Env {
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
export async function startServer(extraEnv: Env = {}): Promise<TestServer> {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "rivo-test-"));
	const mailFile = join(dir, "mails.jsonl");
	const settings = testEnv(port, mailFile, extraEnv);
	const env = { ...process.env, DATABASE_URL: testDatabaseUrl(), ...settings };
	// (with an IPC channel: stop() asks it to stop over it, see there)
	const proc = spawn(process.execPath, ["server/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const out: Buffer[] = [];
	proc.stdout?.on("data", (d: Buffer) => out.push(d));
	proc.stderr?.on("data", (d: Buffer) => out.push(d));
	const base = `http://localhost:${port}`;
	const log = () => Buffer.concat(out).toString();
	for (let i = 0; ; i++) {
		if (proc.exitCode !== null) throw new Error(`the server stopped while starting:\n${log()}`);
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {
			/* not listening yet */
		}
		if (i === 200) throw new Error(`the server did not start in 20 s:\n${log()}`);
		await new Promise((r) => setTimeout(r, 100));
	}
	servers.set(base, { mailFile });
	return {
		base,
		port,
		mailFile,
		jwtSecret: settings.JWT_SECRET!,
		log,
		// (asked over the IPC channel: the server answers { stats } to "stats")
		stats: () =>
			new Promise((r) => {
				if (!proc.connected) return r(null);
				const done = (stats: ProcessStats | null) => {
					clearTimeout(timer);
					proc.off("message", onMessage);
					r(stats);
				};
				const onMessage = (m: unknown) => {
					if (m && typeof m === "object" && "stats" in m) done((m as { stats: ProcessStats }).stats);
				};
				const timer = setTimeout(() => done(null), 5000);
				proc.on("message", onMessage);
				proc.send("stats");
			}),
		// A clean stop, as a deploy does it. Not with kill("SIGTERM"): Windows has
		// no signals, and there that ends the process at once, without its
		// shutdown. The server takes a "shutdown" message instead (on every
		// system). Still running after 15 s: killed.
		stop: () =>
			new Promise((r) => {
				if (proc.exitCode !== null || proc.signalCode !== null) return r();
				proc.once("exit", () => r());
				if (proc.connected) proc.send("shutdown");
				else proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 15_000).unref();
			}),
	};
}

/**
 * Runs one of the command-line tools (server/scripts/…) on the test
 * database, with a test server's settings plus `env`: its exit code and
 * everything it printed.
 */
export function runScript(file: string, args: string[] = [], env: Env = {}): { code: number | null; out: string } {
	const r = spawnSync(process.execPath, [file, ...args], {
		cwd: ROOT,
		env: { ...process.env, ...testEnv(0, join(tmpdir(), "rivo-script-mails.jsonl")), DATABASE_URL: testDatabaseUrl(), ...env },
		encoding: "utf8",
		timeout: 120_000,
	});
	return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The emails a test server has "sent", oldest first. */
export async function mails(base: string): Promise<Mail[]> {
	// (a server started by another process, e.g. Playwright's global setup, names its file in the environment)
	const file = servers.get(base)?.mailFile ?? (base === process.env.E2E_BASE_URL ? process.env.E2E_MAIL_FILE : undefined);
	if (!file || !existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Mail);
}

type Delegates = Record<string, Record<string, (args: unknown) => Promise<unknown>>>;
let prisma: ReturnType<typeof createPrismaClient> | null = null;

/**
 * Runs one Prisma call on the test database, e.g.
 * db(base, "message", "findUnique", { where: { id } }). (What it returns is a
 * database row, not part of the app's contract: the caller says what it expects.)
 */
export async function db<T = any>(_base: string, model: string, op: string, args?: unknown): Promise<T> {
	// (quiet: tests make the database refuse things on purpose, e.g. a second
	// row for the same person, and Prisma would print each refusal)
	prisma ??= createPrismaClient(testDatabaseUrl(), { log: [] });
	const delegate = (prisma as unknown as Delegates)[model];
	if (!delegate?.[op]) throw new Error(`no prisma.${model}.${op}`);
	return (await delegate[op](args)) as T;
}

export async function closeDb(): Promise<void> {
	await prisma?.$disconnect();
	prisma = null;
}
