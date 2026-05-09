import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

// Simple short-lived in-memory cache to reduce per-request DB lookups
// for `passwordChangedAt`. TTL is conservative (30s) to strike a balance
// between performance and the need to detect password changes.
const PWD_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const pwdChangedCache = new Map(); // userId -> { pwdAtSeconds, ts }

async function getPwdChangedAtSeconds(userId) {
	const cached = pwdChangedCache.get(userId);
	const now = Date.now();
	if (cached && now - cached.ts < PWD_CACHE_TTL_MS) return cached.pwdAtSeconds;

	// fetch from DB and update cache
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordChangedAt: true } });
	const pwdAtSeconds = user?.passwordChangedAt ? Math.floor(new Date(user.passwordChangedAt).getTime() / 1000) : 0;
	pwdChangedCache.set(userId, { pwdAtSeconds, ts: now });
	return pwdAtSeconds;
}

export async function requireAuth(req, res, next) {
	// Enforce cookie-only JWT for authentication. Cookie-parser populates `req.cookies`.
	const token = req.cookies?.token;

	if (!token) {
		return res.status(401).json({ error: "Unauthorized" });
	}

	try {
		const payload = jwt.verify(token, process.env.JWT_SECRET);
		const userId = payload.userId;

		// If the token contains a `pwdAt` snapshot we still consult the
		// server-side `passwordChangedAt` but the cache will reduce DB hits.
		// On DB/cache fetch failure we fail-closed and return 503 so we do
		// not accidentally accept tokens we cannot validate.
		let serverPwdAtSeconds;
		try {
			serverPwdAtSeconds = await getPwdChangedAtSeconds(userId);
		} catch (e) {
			console.error("Auth passwordChangedAt read failed", e);
			return res.status(503).json({ error: "Service unavailable" });
		}

		const tokenIat = payload.iat || 0;

		// If server-side password change time is newer than token issue, reject.
		if (serverPwdAtSeconds && serverPwdAtSeconds > tokenIat) {
			return res.status(401).json({ error: "Invalid token" });
		}

		req.userId = userId;
		next();
	} catch (err) {
		if (err && err.name === "TokenExpiredError") {
			return res.status(401).json({ error: "Token expired" });
		}
		return res.status(401).json({ error: "Invalid token" });
	}
}

export function clearPwdChangedCache(userId) {
	try {
		pwdChangedCache.delete(userId);
	} catch (e) {
		// no-op
	}
}