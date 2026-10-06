// Security headers, CORS and CSRF.
import type { RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "../config.ts";
import { csrfFor, readToken, safeEqual, tokenFromRequest } from "../auth/sessions.ts";

// One policy for development and production, so a violation shows up while
// developing instead of after a deploy. Only https-specific parts differ.
export function contentSecurityPolicy(): RequestHandler {
	const directives = [
		"default-src 'self'",
		"base-uri 'self'",
		"script-src 'self'",
		"script-src-attr 'none'",
		// (emoji-picker-element injects styles; every font is served from here)
		"style-src 'self' 'unsafe-inline'",
		"font-src 'self' data:",
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
	return (_req, res, next) => {
		res.setHeader("Content-Security-Policy", value);
		next();
	};
}

/**
 * Helmet's headers. The Content-Security-Policy is set above (one policy for
 * development and production); HSTS only over https, in production.
 * (Cross-Origin-Embedder-Policy stays off, as is Helmet's default: nothing
 * here is embedded from another origin.)
 */
export function securityHeaders(): RequestHandler {
	return helmet({
		contentSecurityPolicy: false,
		strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
	});
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

export const csrfProtection: RequestHandler = (req, res, next) => {
	if (!UNSAFE.has(req.method) || CSRF_EXEMPT.has(req.path)) return next();
	const payload = readToken(tokenFromRequest(req));
	// not signed in: the route's own auth check answers with 401
	if (!payload) return next();
	const sent = req.get("x-csrf-token") || req.get("x-xsrf-token");
	if (!safeEqual(sent, csrfFor(payload.sid))) return void res.status(403).json({ error: "Invalid CSRF token" });
	next();
};
