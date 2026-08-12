import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { createServer } from "http";
import { resolve } from "path";
import { existsSync } from "fs";
import { initSocket, userSockets } from "./socket/index.js";
import { openDueCapsules } from "./jobs/openCapsules.js";
import { initKeyStore, wrapDEK, generateDEK } from "./utils/encryption.js";
import * as Sentry from "@sentry/node";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import contactRoutes from "./routes/contacts.js";
import conversationRoutes from "./routes/conversations.js";
import messageRoutes from "./routes/messages.js";
import pushRoutes from "./routes/push.js";

dotenv.config();

// Safety: disallow enabling ephemeral KEK in production environments.
// An ephemeral KEK will prevent messages from being unwrapped after a restart
// if someone accidentally sets this flag in production. Fail-fast to avoid
// silent data-loss scenarios.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_EPHEMERAL_KEK === '1') {
	console.error('FATAL: ALLOW_EPHEMERAL_KEK must not be set in production');
	process.exit(1);
}

// Critical: fail fast if JWT secret is missing. Without a secret,
// jsonwebtoken may accept tokens signed with an empty string.
if (!process.env.JWT_SECRET) {
	throw new Error("JWT_SECRET not set");
}
if (process.env.JWT_SECRET.length < 32) {
	console.warn("⚠️  JWT_SECRET کوتاه‌تر از ۳۲ کاراکتر است و به‌راحتی قابل حدس زدن است.");
}

// بدون DATABASE_URL هیچ کوئری‌ای کار نمی‌کند؛ بهتر است همین‌جا با پیام واضح
// شکست بخوریم تا اینکه بعداً با خطای مبهم Prisma مواجه شویم.
if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL not set");
}

// بدون KEK پیام‌ها نه رمز می‌شوند نه رمزگشایی. حالت کلید موقت فقط برای
// توسعه‌ی محلی مجاز است و بالاتر در production مسدود شده.
if (!process.env.KEK_V1 && process.env.SECRET_PROVIDER !== "vault" && process.env.ALLOW_EPHEMERAL_KEK !== "1") {
	throw new Error("KEK_V1 not set (یا SECRET_PROVIDER=vault را تنظیم کنید، یا برای توسعه ALLOW_EPHEMERAL_KEK=1)");
}

if (process.env.NODE_ENV === "production") {
	// این‌ها در production واقعاً لازم‌اند؛ نبودشان قابلیت‌ها را بی‌صدا از کار می‌اندازد
	const missing = [];
	if (!process.env.ALLOWED_ORIGINS) missing.push("ALLOWED_ORIGINS");
	if (!process.env.SMTP_HOST || !process.env.SMTP_USER) missing.push("SMTP_HOST/SMTP_USER (تایید ایمیل و بازیابی رمز)");
	if (!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) missing.push("VAPID_PUBLIC/VAPID_PRIVATE (نوتیفیکیشن)");
	if (missing.length) {
		throw new Error(`متغیرهای زیر در production تنظیم نشده‌اند:\n  - ${missing.join("\n  - ")}`);
	}
	if (process.env.SECRET_PROVIDER === "vault" && (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN)) {
		throw new Error("SECRET_PROVIDER=vault است ولی VAULT_ADDR یا VAULT_TOKEN تنظیم نشده.");
	}
}

// Initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
	try {
		Sentry.init({ dsn: process.env.SENTRY_DSN });
	} catch (e) { console.warn('Sentry init failed', e); }
}

const app = express();
const httpServer = createServer(app);

// Optionally enable trust proxy in production when behind a reverse proxy.
// Set ENABLE_TRUST_PROXY=1 in the production environment to enable.
try {
	const enableTrustProxy = process.env.ENABLE_TRUST_PROXY === '1' && process.env.NODE_ENV === 'production';
	if (enableTrustProxy) {
		app.set('trust proxy', 1);
		console.info('trust proxy enabled');
	}
} catch (e) {
	// ignore if setting fails
}

// ─── Middleware ───────────────────────────────────────────────────────────────
// Allow local dev and production domains (add production hosts here)
const defaultOrigins = [
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"https://rivo.ir",
	"https://www.rivo.ir",
	"https://chat.rivo.ir",
];
const allowedOrigins = new Set(
	(process.env.ALLOWED_ORIGINS
		? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
		: defaultOrigins)
);
// Security headers
// Use Helmet for common security headers. Disable Helmet's default HSTS
// here so we can enable HSTS explicitly only in production. This avoids
// forcing HTTPS during local/IP development which breaks LAN testing.
// Disable Helmet's default HSTS and CSP here so our custom CSP middleware
// can apply a developer-friendly policy. We still enable HSTS explicitly
// when `NODE_ENV === 'production'` below.
const isProduction = process.env.NODE_ENV === 'production';
const upgradeDirective = isProduction ? ' upgrade-insecure-requests' : '';
// In production enable Helmet defaults (including CSP/HSTS configured below).
// In development we skip Helmet entirely to avoid strict headers that break
// LAN testing (HSTS/CSP upgrades, COOP/COEP behavior on insecure origins).
if (isProduction) {
	app.use(helmet());
	try {
		app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));
	} catch (e) {
		console.warn('HSTS setup failed', e);
	}
} else {
	// In development, only HSTS and CSP are disabled because they interfere with LAN testing.
	// The rest of the security headers should still be applied.
	app.use(helmet({ hsts: false, contentSecurityPolicy: false }));
}

// Ensure CSP allows blob: for images (some browsers use blob: URLs for uploads)
app.use((req, res, next) => {
	// Skip static asset requests and avoid running more than once per request
	if (req.path && (req.path.startsWith('/assets') || req.path.startsWith('/fonts') || req.path.startsWith('/icons'))) return next();
	if (res.locals && res.locals.__csp_augmented) return next();
	res.locals = res.locals || {};
	res.locals.__csp_augmented = true;

	const existing = res.getHeader && res.getHeader('Content-Security-Policy');
	// DEBUG: log existing CSP header for troubleshooting (dev only)
	try { if (!isProduction && existing) console.log('[CSP middleware] existing CSP header:', existing, 'path:', req.path); } catch (e) { /* ignore */ }
	const fallbackCSP = `default-src 'self'; base-uri 'self'; connect-src 'self' blob: wss: ws:; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; object-src 'none';${upgradeDirective}`;
	if (existing) {
		const existingStr = String(existing || '');
		// If an upstream middleware (or default Helmet config) set a very
		// restrictive CSP like "default-src 'none'", treat that as no
		// usable policy and replace it with our fallback.
		if (existingStr.includes("default-src 'none'")) {
			res.setHeader('Content-Security-Policy', fallbackCSP);
		} else {
			try {
				let updated = existingStr;
				// ensure img-src contains blob:
				updated = updated.replace(/img-src\s+([^;]+)/, (m, p1) => {
					if (p1.includes('blob:')) return m;
					return `img-src ${p1} blob:`;
				});
				// ensure connect-src contains blob:
				if (/connect-src\s+[^;]+/.test(updated)) {
					updated = updated.replace(/connect-src\s+([^;]+)/, (m, p1) => {
						if (p1.includes('blob:')) return m;
						return `connect-src ${p1} blob:`;
					});
				} else {
					// add connect-src with sensible defaults
					updated = updated.replace(/(default-src\s+'self';?)/, `$1 connect-src 'self' blob: wss: ws:;`);
				}
				res.setHeader('Content-Security-Policy', updated);
			} catch (e) {
				// if anything goes wrong, fall back to a permissive but safe CSP including connect-src blob
				res.setHeader('Content-Security-Policy', fallbackCSP);
			}
		}
	} else {
		res.setHeader('Content-Security-Policy', fallbackCSP);
	}
	next();
});

// Rate limiter for auth endpoints to mitigate brute-force attacks
const authLimiter = rateLimit({
	windowMs: (Number(process.env.AUTH_RATE_WINDOW_MINUTES) || 15) * 60 * 1000,
	max: Number(process.env.AUTH_RATE_MAX) || 10,
	standardHeaders: true,
	legacyHeaders: false,
	// Without a custom handler, the client receives a plain-text response instead of JSON.
	handler: (req, res) => res.status(429).json({ error: "Too many attempts, try again later" }),
});

app.use(
	cors({
		origin: (origin, callback) => {
			// allow non-browser tools (no origin) and local dev origins
			if (!origin) return callback(null, true);
			return callback(null, allowedOrigins.has(origin) ? origin : false);
		},
		credentials: true,
		allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Requested-With"],
	}),
);
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

// Serve a small client-config script that injects selected env vars into
// the browser as `window.__RIVO_CLIENT_CONFIG`. This allows runtime
// configuration of client pagination limits without rebuilding assets.
app.get('/chat/client-config.js', (req, res) => {
	try {
		const cfg = {
			DEFAULT_PAGE_LIMIT: Number(process.env.DEFAULT_PAGE_LIMIT) || 50,
			MAX_CLIENT_PAGE_LIMIT: Number(process.env.MAX_CLIENT_PAGE_LIMIT) || 100,
			CLIENT_PREFETCH_ON_OPEN: (String(process.env.CLIENT_PREFETCH_ON_OPEN || '').toLowerCase() === '1' || String(process.env.CLIENT_PREFETCH_ON_OPEN || '').toLowerCase() === 'true') || false,
		};
		res.setHeader('Content-Type', 'application/javascript');
		res.send(`window.__RIVO_CLIENT_CONFIG = ${JSON.stringify(cfg)};`);
	} catch (e) {
		res.setHeader('Content-Type', 'application/javascript');
		res.send("window.__RIVO_CLIENT_CONFIG = {};console.warn('client-config error');");
	}
});

// Attach Sentry request handler early so it can collect request data
if (process.env.SENTRY_DSN) {
	app.use(Sentry.Handlers.requestHandler());
}

// Minimal CSRF protection (double-submit cookie):
// - Server sets a non-HttpOnly `csrfToken` cookie at login
// - Client must echo that token in `X-CSRF-Token` header for state-changing requests
const csrfExcluded = new Set([
	"/api/auth/login",
	"/api/auth/register",
	"/api/auth/reset-password",
	// Allow unauthenticated verification flows
	"/api/auth/send-code",
	"/api/auth/verify-code",
	// Password recovery via emailed link: the user is logged out and has no CSRF cookie yet.
	"/api/auth/request-password-reset",
	"/api/auth/reset-password-with-token",
]);

function csrfProtection(req, res, next) {
	const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(
		req.method,
	);
	if (!unsafe) return next();
	if (csrfExcluded.has(req.path)) return next();
	const cookieToken = req.cookies?.csrfToken;
	const headerToken = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"];
	if (!cookieToken || !headerToken || cookieToken !== headerToken) {
		return res.status(403).json({ error: "Invalid CSRF token" });
	}
	next();
}

app.use(csrfProtection);
// Global HTTP rate limiter to mitigate abuse (configurable via env)
const enableHttpRateLimiter = (process.env.ENABLE_HTTP_RATE_LIMITER || "1") === "1";
if (enableHttpRateLimiter) {
	const HTTP_RATE_WINDOW_MS = Number(process.env.HTTP_RATE_WINDOW_MS || 60000);
	const HTTP_RATE_MAX = Number(process.env.HTTP_RATE_MAX || 600);
	app.use(
		rateLimit({
			windowMs: HTTP_RATE_WINDOW_MS,
			max: HTTP_RATE_MAX,
			standardHeaders: true,
			legacyHeaders: false,
			// skip static/socket/diag endpoints to avoid accidental blocking
			skip: (req) => {
				const p = req.path || "";
				return (
					p.startsWith("/public") ||
					p.startsWith("/src") ||
					p.startsWith("/node_modules") ||
					p.startsWith("/socket.io") ||
					p.startsWith("/__diag")
				);
			},
			handler: (req, res) => res.status(429).json({ error: "Too many requests" }),
		}),
	);
}
app.use(express.static("public"));
app.use("/public", express.static("public"));
// Only expose raw source in non-production environments to avoid leaking
// server-side logic and helpers.
if (process.env.NODE_ENV !== "production") {
	app.use("/components", express.static("src/components"));
	app.use("/utils", express.static("src/utils"));
}

if (process.env.NODE_ENV !== "production") {
	// Expose source and node_modules only in development for local debugging
	app.use("/src", express.static("src"));
	app.use("/node_modules", express.static("node_modules"));
}

// Serve landing assets: prefer public, fall back to src (register both so missing files cascade)
{
	const publicLandingDir = resolve("public/landing");
	const srcLandingDir = resolve("src/pages/landing");
	// always register public first (it may be empty), then src as fallback
	app.use('/landing', express.static(publicLandingDir));
	app.use('/landing', express.static(srcLandingDir));
}

// Serve chat app assets: prefer public/chat, fall back to src/pages/main (so
// production can serve the main app without exposing whole /src)
{
	const publicChat = resolve("public/chat");
	const srcMain = resolve("src/pages/main");
	app.use('/chat', express.static(publicChat));
	app.use('/chat', express.static(srcMain));
}

// Serve auth pages from src in case they are not copied to public in production
{
	const srcAuth = resolve("src/pages/auth");
	app.use('/auth', express.static(srcAuth));
}

app.get('/reset-password', (req, res) => {
	res.sendFile(resolve('public/reset-password.html'));
});

// Dev-only runtime diagnostics endpoint. Exposes memory and active handle counts.
if (process.env.NODE_ENV !== "production") {
	app.get("/__diag", (req, res) => {
			try {
				// Only allow local requests for diagnostics. Rely on req.ip
				// (respecting trust-proxy when enabled) instead of X-Forwarded-For
				// which can be trivially spoofed by a client.
				const ip = req.ip || req.connection?.remoteAddress || "";
				const allowed = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
				if (!allowed.includes(ip)) {
					return res.status(403).json({ error: "Forbidden" });
				}
			const mem = process.memoryUsage();
			const cpu = process.cpuUsage();
			const uptime = process.uptime();
			const handles = (process._getActiveHandles?.() || []).map(h => h?.constructor?.name || typeof h);
			const requests = (process._getActiveRequests?.() || []).map(r => r?.constructor?.name || typeof r);
			return res.json({
				memoryUsage: mem,
				cpuUsage: cpu,
				uptime,
				handlesCount: handles.length,
				handles,
				requestsCount: requests.length,
				requests,
			});
		} catch (e) {
			return res.status(500).json({ error: "diag error", detail: String(e) });
		}
	});
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/push", pushRoutes);

// Host-based fallback: serve landing for main domain and chat app for subdomain
// Fallback handler: use middleware instead of a route pattern to avoid path-to-regexp issues
app.use((req, res, next) => {
	// Only handle GET navigations and not API/socket/static requests
	if (req.method !== "GET") return next();
	const p = req.path || "";
	if (p.startsWith("/api") || p.startsWith("/socket.io") || p.startsWith("/public") || p.startsWith("/src") || p.startsWith("/node_modules") || p.startsWith("/__diag")) {
		return next();
	}
	const host = (req.headers.host || "").split(":")[0];

	// Serve chat app
	if (host === "chat.rivo.ir") {
		const publicChat = resolve("public/chat/index.html");
		const srcChat = resolve("src/pages/main/index.html");
		if (existsSync(publicChat)) return res.sendFile(publicChat);
		if (existsSync(srcChat)) return res.sendFile(srcChat);
		return res.status(404).send("Not found");
	}

	// Default -> landing page (prefer public, fall back to src)
	const publicLanding = resolve("public/landing/index.html");
	const srcLanding = resolve("src/pages/landing/index.html");
	if (existsSync(publicLanding)) return res.sendFile(publicLanding);
	if (existsSync(srcLanding)) return res.sendFile(srcLanding);
	return res.status(404).send("Not found");
});

// Sentry error handler (capture unhandled errors)
if (process.env.SENTRY_DSN) {
	app.use(Sentry.Handlers.errorHandler());
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
(async () => {
	try {
		await initKeyStore();
	} catch (e) {
		console.error("failed to initialize keystore:", e && e.message ? e.message : e);
		// If the application is configured to use Vault and we cannot initialize,
		// it's safer to stop startup than to run without KEKs.
		if ((process.env.SECRET_PROVIDER || "").toLowerCase() === "vault") {
			console.error("SECRET_PROVIDER=vault but keystore initialization failed — aborting startup.");
			process.exit(1);
		} else if (process.env.NODE_ENV === 'production') {
		console.error('KEK not configured or invalid — aborting startup.');
		process.exit(1);
	} else {
		console.warn('KEK not configured. For development, run `npm run gen-kek` to generate a base64 KEK and add it to your .env as KEK_V1=<base64>');
	}
	}

	// Quick runtime KEK sanity check: attempt to wrap a test DEK. This will
	// surface missing/invalid KEKs early. In development, the ALLOW_EPHEMERAL_KEK
	// opt-in can allow an ephemeral KEK to be generated; in production this will
	// fail and we warn/abort.
	try {
		wrapDEK(generateDEK());
	} catch (e) {
		console.error("KEK sanity check failed:", e && e.message ? e.message : e);
		if ((process.env.SECRET_PROVIDER || "").toLowerCase() === "vault") {
			console.error("SECRET_PROVIDER=vault but KEK unwrap/wrap failed — aborting startup.");
			process.exit(1);
		} else if (process.env.NODE_ENV === 'production') {
			console.error('KEK not configured or invalid — aborting startup.');
			process.exit(1);
		} else {
			console.warn(
				'KEK not configured or invalid. For development, run `npm run gen-kek` and add KEK_V1 to your .env. To allow an ephemeral dev-only KEK, set `ALLOW_EPHEMERAL_KEK=1` (do NOT use in production).',
			);
		}
	}
	const io = initSocket(httpServer);

	// Start background poll to open due time-capsules every 30 seconds
	try {
		setInterval(() => openDueCapsules(io, userSockets), 30_000);
	} catch (e) {
		console.error('failed to start openDueCapsules interval', e);
	}

	// Run once immediately on startup to open any already-due capsules
	try {
		openDueCapsules(io, userSockets).catch(e => console.error('capsule init error', e));
	} catch (e) {
		console.error('capsule init error', e);
	}
})();

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
	console.log(`Rivo server running on port ${PORT}`);
});
