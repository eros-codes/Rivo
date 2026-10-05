// Security headers, CORS and CSRF.
import cors from "cors";
import helmet from "helmet";
import { config } from "../config.js";
import { csrfFor, readToken, safeEqual, tokenFromRequest } from "../auth/sessions.js";

// One policy for development and production, so a violation shows up while
// developing instead of after a deploy. Only https-specific parts differ.
export function contentSecurityPolicy() {
	const directives = [
		"default-src 'self'",
		"base-uri 'self'",
		"script-src 'self'",
		"script-src-attr 'none'",
		// the landing page uses Google Fonts; emoji-picker-element injects styles
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"font-src 'self' data: https://fonts.gstatic.com",
		"img-src 'self' data: blob:",
		"connect-src 'self' ws: wss:",
		"worker-src 'self'",
		"manifest-src 'self'",
		"media-src 'self'",
		"object-src 'none'",
		"frame-ancestors 'self'",
		"form-action 'self'",
	];
	if (config.isProd) directives.push("upgrade-insecure-requests");
	const value = directives.join("; ");
	return (req, res, next) => {
		res.setHeader("Content-Security-Policy", value);
		next();
	};
}

export function securityHeaders() {
	const h = helmet({
		contentSecurityPolicy: false,
		hsts: false,
		// the emoji picker data and avatars are same-origin; nothing is embedded cross-origin
		crossOriginEmbedderPolicy: false,
	});
	if (!config.isProd) return h;
	const hsts = helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true });
	return (req, res, next) => h(req, res, (err) => (err ? next(err) : hsts(req, res, next)));
}

export function corsPolicy() {
	return cors({
		origin: (origin, callback) => {
			// same-origin requests and non-browser tools send no Origin
			if (!origin) return callback(null, true);
			return callback(null, config.allowedOrigins.has(origin) ? origin : false);
		},
		credentials: true,
		allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Requested-With", "X-Socket-Id"],
	});
}

// Endpoints used before a session exists, or that must always work.
const CSRF_EXEMPT = new Set([
	"/api/auth/login",
	"/api/auth/register",
	"/api/auth/check-availability",
	"/api/auth/send-code",
	"/api/auth/verify-code",
	"/api/auth/request-password-reset",
	"/api/auth/reset-password-with-token",
	// logging out has to work even with a broken CSRF cookie; it can only
	// end the session it is sent with
	"/api/auth/logout",
]);
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfProtection(req, res, next) {
	if (!UNSAFE.has(req.method) || CSRF_EXEMPT.has(req.path)) return next();
	const payload = readToken(tokenFromRequest(req));
	// not signed in: the route's own auth check answers with 401
	if (!payload) return next();
	const sent = req.get("x-csrf-token") || req.get("x-xsrf-token");
	if (!safeEqual(sent, csrfFor(payload.sid))) return res.status(403).json({ error: "Invalid CSRF token" });
	next();
}
