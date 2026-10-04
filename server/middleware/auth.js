import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Sessions slide: after a day, any request renews the 7-day cookie, so people
// who use the app are not signed out every week.
const RENEW_AFTER_SECONDS = 24 * 60 * 60;

function renewSession(req, res, userId, payload) {
	try {
		const nowSec = Math.floor(Date.now() / 1000);
		if (!payload.iat || nowSec - payload.iat < RENEW_AFTER_SECONDS) return;
		const opts = {
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			maxAge: SESSION_MAX_AGE_MS,
		};
		const fresh = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
		res.cookie("token", fresh, { ...opts, httpOnly: true });
		// the CSRF cookie must live as long as the session
		if (req.cookies?.csrfToken) res.cookie("csrfToken", req.cookies.csrfToken, { ...opts, httpOnly: false });
	} catch (e) {
		/* renewal is best-effort */
	}
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

		// Check if the user changed password after token was issued
		try {
			const user = await prisma.user.findUnique({
				where: { id: userId },
				select: { passwordChangedAt: true, isDeleted: true },
			});
			// Soft-delete remains in place so other users' chats do not disappear,
			// but a deleted account must not keep access with an old token.
			if (!user || user.isDeleted) {
				return res.status(401).json({ error: "Invalid token" });
			}
			if (user.passwordChangedAt) {
				const pwdChangedAtSeconds = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
				const tokenIat = payload.iat || 0;
				if (pwdChangedAtSeconds > tokenIat) {
					return res.status(401).json({ error: "Invalid token" });
				}
			}
		} catch (e) {
			console.error("Auth passwordChangedAt check failed", e);
			// Database errors should not be silently translated into "Invalid token".
			// Return a clear 503 in both environments so the real cause stays visible.
			return res.status(503).json({
				error: process.env.NODE_ENV === 'production' ? 'Service unavailable' : `Auth check failed: ${e.message}`,
			});
		}

		req.userId = userId;
		renewSession(req, res, userId, payload);
		next();
	} catch (err) {
		if (err && err.name === "TokenExpiredError") {
			return res.status(401).json({ error: "Token expired" });
		}
		return res.status(401).json({ error: "Invalid token" });
	}
}