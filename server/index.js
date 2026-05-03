import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { initSocket } from "./socket/index.js";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import contactRoutes from "./routes/contacts.js";
import conversationRoutes from "./routes/conversations.js";
import messageRoutes from "./routes/messages.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);

// ─── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
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
app.use("/src", express.static("src"));
app.use("/node_modules", express.static("node_modules"));

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

// ─── Socket.io ────────────────────────────────────────────────────────────────
initSocket(httpServer);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
	console.log(`Rivo server running on port ${PORT}`);
});
