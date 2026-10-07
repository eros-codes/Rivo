// Rivo server: HTTP API, pages and the real-time connection.
import "./env.ts";
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import prisma from "./prisma.ts";
import { initKeyStore, wrapDEK, generateDEK } from "./utils/encryption.ts";
import { contentSecurityPolicy, corsPolicy, csrfProtection, securityHeaders } from "./http/security.ts";
import { cleanupSessions } from "./auth/sessions.ts";
import { initSocket, userSockets, type RivoServer } from "./socket/index.ts";
import { openDueCapsules } from "./jobs/openCapsules.ts";
import authRoutes from "./routes/auth.ts";
import sessionRoutes from "./routes/sessions.ts";
import userRoutes from "./routes/users.ts";
import contactRoutes from "./routes/contacts.ts";
import conversationRoutes from "./routes/conversations.ts";
import messageRoutes from "./routes/messages.ts";
import pushRoutes from "./routes/push.ts";
import { log, requestLogging } from "./utils/logger.ts";
import { messageOf } from "./utils/errors.ts";
import { processStats } from "./utils/processStats.ts";

// ─── Configuration checks (fail fast with a clear message) ─────────────────
if (config.isProd && process.env.ALLOW_EPHEMERAL_KEK === "1") {
	log.error("FATAL: ALLOW_EPHEMERAL_KEK must not be set in production");
	process.exit(1);
}
if (!config.jwtSecret) throw new Error("JWT_SECRET not set");
if (config.jwtSecret.length < 32) log.warn("⚠️  JWT_SECRET is shorter than 32 characters and easy to guess.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
if (config.isProd && process.env.MAIL_CAPTURE_FILE) {
	// (the tests' way of reading emails: in production they must really be sent)
	log.error("FATAL: MAIL_CAPTURE_FILE must not be set in production");
	process.exit(1);
}
if (!process.env.KEK_V1 && process.env.SECRET_PROVIDER !== "vault" && process.env.ALLOW_EPHEMERAL_KEK !== "1") {
	throw new Error("KEK_V1 not set (or set SECRET_PROVIDER=vault, or ALLOW_EPHEMERAL_KEK=1 for local development)");
}
if (config.isProd) {
	const missing = [];
	if (!process.env.ALLOWED_ORIGINS) missing.push("ALLOWED_ORIGINS");
	if (!process.env.SMTP_HOST || !process.env.SMTP_USER) missing.push("SMTP_HOST/SMTP_USER (email verification and password reset)");
	if (!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) missing.push("VAPID_PUBLIC/VAPID_PRIVATE (notifications)");
	if (missing.length) throw new Error(`These variables are required in production:\n  - ${missing.join("\n  - ")}`);
	if (process.env.SECRET_PROVIDER === "vault" && (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN)) {
		throw new Error("SECRET_PROVIDER=vault but VAULT_ADDR or VAULT_TOKEN is not set.");
	}
	if (!process.env.APP_URL) {
		log.warn(`⚠️  APP_URL is not set: links in emails point to ${config.appUrl}. Set it to the site's address (e.g. https://chat.rivo.ir).`);
	}
}

// Error reporting is started by server/instrument.ts, before this file runs
// (see there). Without it, a SENTRY_DSN would quietly report nothing.
const sentry = config.sentryDsn ? await import("@sentry/node") : null;
if (sentry && !sentry.isInitialized()) {
	log.warn("⚠️  SENTRY_DSN is set but errors are not reported: start the server with `node --import ./server/instrument.ts server/index.ts` (npm start does).");
}

const app = express();
const httpServer = createServer(app);
const PUBLIC = resolve("public");
const VERSION = config.version;
let stopping = false;

if (config.trustProxy) app.set("trust proxy", 1);
app.disable?.("x-powered-by");

// ─── Middleware ───────────────────────────────────────────────────────────
app.use(requestLogging());
app.use(securityHeaders());
app.use(contentSecurityPolicy());
app.use(corsPolicy());
// ─── Health (uptime monitors, load balancers, deploy scripts) ─────────────
// 200 when the server and its database answer; 503 otherwise or while the
// server is shutting down (so a load balancer stops sending it requests).
// The answer is reused for a second: a flood of checks is not a flood of queries.
let lastHealth = { at: 0, ok: false, dbMs: 0 };
app.get("/api/health", async (_req, res) => {
	res.setHeader("Cache-Control", "no-store");
	if (stopping) return void res.status(503).json({ status: "stopping" });
	if (Date.now() - lastHealth.at > 1000) {
		const started = Date.now();
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				prisma.$queryRaw`SELECT 1`,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("database did not answer within 2 s")), 2000);
				}),
			]);
			lastHealth = { at: Date.now(), ok: true, dbMs: Date.now() - started };
		} catch (e) {
			log.error("health check: database unreachable", e);
			lastHealth = { at: Date.now(), ok: false, dbMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
		}
	}
	const body = { status: lastHealth.ok ? "ok" : "degraded", db: lastHealth.ok ? "ok" : "unreachable", dbMs: lastHealth.dbMs, uptime: Math.round(process.uptime()), version: VERSION };
	return void res.status(lastHealth.ok ? 200 : 503).json(body);
});

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use(csrfProtection);

if (config.rate.http.enabled) {
	app.use(
		rateLimit({
			windowMs: config.rate.http.windowMs,
			limit: config.rate.http.max,
			standardHeaders: true,
			legacyHeaders: false,
			// only the API: a page load fetches many files, and many people can
			// share one address (carrier NAT)
			// (routes match without regard to case, so the check must too)
			skip: (req) => !req.path.toLowerCase().startsWith("/api/"),
			handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
		}),
	);
}

// Which field of the request names the account each auth endpoint acts on.
// The limit is kept per address *and* that account, read from the same field
// the endpoint reads (any other field could be changed freely to get a new
// allowance).
const AUTH_ACCOUNT_FIELD: Record<string, string | undefined> = {
	"/login": "identifier",
	"/request-password-reset": "identifier",
	"/send-code": "email",
	"/verify-code": "email",
	"/register": "email",
};
const authLimiter = rateLimit({
	windowMs: config.rate.auth.windowMs,
	limit: config.rate.auth.max,
	standardHeaders: true,
	legacyHeaders: false,
	// only failed attempts count: a normal sign-up never hits it, guessing a
	// password or a code does, and one person's typos do not lock out
	// everyone behind the same address
	skipSuccessfulRequests: true,
	// (an IPv6 address counts by its /56 network: one connection gets a whole
	// range of addresses, any of which would otherwise be a fresh allowance)
	keyGenerator: (req) => {
		const route = req.path.toLowerCase().replace(/\/+$/, "");
		const field = AUTH_ACCOUNT_FIELD[route];
		const value = field ? req.body?.[field] : "";
		return `${ipKeyGenerator(req.ip ?? "")}|${route}|${typeof value === "string" ? value.trim().toLowerCase().slice(0, 254) : ""}`;
	},
	skip: (req) => req.path.toLowerCase().replace(/\/+$/, "") === "/logout",
	handler: (_req, res) => res.status(429).json({ error: "Too many attempts, try again later" }),
});

// The same failures counted per address only, with more room: trying many
// accounts from one place (credential stuffing) runs into this one.
const authAddressLimiter = rateLimit({
	windowMs: config.rate.auth.windowMs,
	limit: config.rate.auth.max * 10,
	standardHeaders: false,
	legacyHeaders: false,
	skipSuccessfulRequests: true,
	// (an unknown address, a connection already gone, is the key "")
	keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
	skip: (req) => req.path.toLowerCase().replace(/\/+$/, "") === "/logout",
	handler: (_req, res) => res.status(429).json({ error: "Too many attempts, try again later" }),
});

// ─── API ──────────────────────────────────────────────────────────────────
app.use("/api/auth", authAddressLimiter, authLimiter, authRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/users", userRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/push", pushRoutes);
app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found" }));

// ─── Pages and files ──────────────────────────────────────────────────────
const page = (file: string): RequestHandler => {
	const full = resolve(PUBLIC, file);
	return (_req, res, next) => {
		if (!existsSync(full)) return next();
		res.setHeader("Cache-Control", "no-cache");
		res.sendFile(full);
	};
};
const withQuery = (req: Request, path: string): string => path + (req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "");

app.get("/", (req, res, next) => {
	// the app's own host opens the app
	if (req.hostname === "chat.rivo.ir") return void res.redirect(302, "/chat/");
	return page("landing/index.html")(req, res, next);
});
// "/chat" → "/chat/" (Express routes match both spellings, so check it)
const addSlash = (path: string): RequestHandler => (req, res, next) => (req.path.endsWith("/") ? next() : res.redirect(301, withQuery(req, path)));
app.get("/chat", addSlash("/chat/"));
app.get("/auth", addSlash("/auth/"));
app.get("/chat/", page("chat/index.html"));
app.get("/auth/", page("auth/index.html"));
app.get("/reset-password.html", page("reset-password.html"));

app.use(
	express.static(PUBLIC, {
		index: false,
		setHeaders(res, file) {
			const f = file.replace(/\\/g, "/");
			if (f.includes("/public/app/") || f.includes("/assets/images/user-profiles/")) {
				// content-hashed bundles and uniquely named avatars never change
				res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			} else if (f.endsWith(".html") || f.endsWith("/service-worker.js") || f.endsWith(".webmanifest")) {
				res.setHeader("Cache-Control", "no-cache");
			} else {
				res.setHeader("Cache-Control", "public, max-age=604800");
			}
		},
	}),
);

app.use((req, res) => {
	res.status(404);
	const notFound = resolve(PUBLIC, "404.html");
	if (req.method === "GET" && req.accepts?.("html") !== false && existsSync(notFound)) {
		res.setHeader("Cache-Control", "no-cache");
		return void res.sendFile(notFound);
	}
	return void res.type("text/plain").send("Not found");
});

// (four parameters: that is how Express tells an error handler apart)
const onError: ErrorRequestHandler = (err, req, res, _next) => {
	const status = Number(err?.status || err?.statusCode) || 500;
	if (status >= 500) log.error("request failed", req.method, req.path, err);
	if (res.headersSent) return void res.end();
	const message = status === 413 ? "Request is too large" : status === 400 ? "Malformed request" : "Server error";
	if (req.path.startsWith("/api/") || req.get("accept")?.includes("json")) return void res.status(status).json({ error: message });
	return void res.status(status).type("text/plain").send(message);
};
app.use(onError);

// ─── Start ────────────────────────────────────────────────────────────────
let io: RivoServer | null = null;
const timers: NodeJS.Timeout[] = [];

async function start() {
	try {
		await initKeyStore();
	} catch (e) {
		log.error("failed to initialize the key store:", messageOf(e) || e);
		if ((process.env.SECRET_PROVIDER || "").toLowerCase() === "vault" || config.isProd) process.exit(1);
	}
	try {
		// surfaces a missing / invalid KEK now, not on the first message
		wrapDEK(generateDEK());
	} catch (e) {
		log.error("KEK check failed:", messageOf(e) || e);
		if ((process.env.SECRET_PROVIDER || "").toLowerCase() === "vault" || config.isProd) process.exit(1);
		log.warn("For development: `npm run gen-kek` and put KEK_V1 in .env (or ALLOW_EPHEMERAL_KEK=1).");
	}

	io = initSocket(httpServer);
	timers.push(setInterval(() => openDueCapsules(), 30_000));
	openDueCapsules();
	timers.push(setInterval(() => cleanupSessions(), 6 * 60 * 60 * 1000));
	cleanupSessions();

	httpServer.listen(config.port, "0.0.0.0", () => log.info(`Rivo server running on port ${config.port}`, { version: VERSION }));
}

// ─── Stop ─────────────────────────────────────────────────────────────────
// A deploy or restart sends SIGTERM: health turns 503, no new connections are
// taken, requests in progress finish, live connections are told to reconnect
// (to the new process), then the database connection is closed. Ten seconds
// at most.
async function shutdown(signal: string, code = 0): Promise<void> {
	if (stopping) return;
	stopping = true;
	log.info(`${signal}: shutting down`);
	timers.forEach(clearInterval);
	const force = setTimeout(() => {
		log.error("shutdown took longer than 10 s: exiting now");
		process.exit(code || 1);
	}, 10_000);
	force.unref?.();
	try {
		const wasListening = httpServer.listening;
		const closed = new Promise<void>((r) => httpServer.once("close", () => r()));
		// socket.io disconnects every socket (and closes the HTTP server itself)
		io?.close();
		if (httpServer.listening) httpServer.close();
		httpServer.closeIdleConnections?.();
		if (wasListening) await closed;
		await prisma.$disconnect();
		// (what is still waiting to be reported, e.g. the error that stopped it)
		if (sentry?.isInitialized()) await sentry.flush(2000);
		log.info("stopped");
	} catch (e) {
		log.error("shutdown error", e);
	}
	process.exit(code);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Windows has no SIGTERM (stopping a process there ends it at once), so a
// parent that started the server with an IPC channel asks for the same clean
// stop with a message: pm2 (shutdown_with_message), the tests.
process.on("message", (m) => {
	if (m === "shutdown") void shutdown("shutdown message");
	// the load test's measurements of this process (tests/load): only the
	// process that started this one can ask, over the same channel
	else if (m === "stats") process.send?.({ stats: processStats([...userSockets.values()].reduce((n, set) => n + set.size, 0)) });
});
// A bug that escaped every handler: logged with its stack. An unhandled
// promise rejection is logged and the server goes on; an exception thrown
// outside any promise leaves the process in an unknown state, so it stops
// (the process manager starts it again).
process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", reason));
process.on("uncaughtException", (e) => {
	log.error("uncaught exception: stopping", e);
	void shutdown("uncaughtException", 1);
});

start();
