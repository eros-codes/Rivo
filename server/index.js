import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { resolve } from "path";
import { existsSync } from "fs";
import { initSocket } from "./socket/index.js";
import * as Sentry from "@sentry/node";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import contactRoutes from "./routes/contacts.js";
import conversationRoutes from "./routes/conversations.js";
import messageRoutes from "./routes/messages.js";
import pushRoutes from "./routes/push.js";

dotenv.config();

// Initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
	try {
		Sentry.init({ dsn: process.env.SENTRY_DSN });
	} catch (e) { console.warn('Sentry init failed', e); }
}

const app = express();
const httpServer = createServer(app);

// ─── Middleware ───────────────────────────────────────────────────────────────
// Allow local dev and production domains (add production hosts here)
const allowedOrigins = new Set([
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"https://rivo.ir",
	"https://www.rivo.ir",
	"https://chat.rivo.ir",
]);
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
app.use(express.json());
app.use(cookieParser());

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
app.use(express.static("public"));
app.use("/public", express.static("public"));

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

// Dev-only runtime diagnostics endpoint. Exposes memory and active handle counts.
if (process.env.NODE_ENV !== "production") {
	app.get("/__diag", (req, res) => {
		try {
			// Only allow local requests for diagnostics
			const ip = req.ip || req.connection?.remoteAddress || "";
			const allowed = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
			if (!allowed.includes(ip) && !(req.headers["x-forwarded-for"] || "").includes("127.0.0.1")) {
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
app.use("/api/auth", authRoutes);
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
		const srcChat = resolve("src/pages/chat/index.html");
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
initSocket(httpServer);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
	console.log(`Rivo server running on port ${PORT}`);
});
