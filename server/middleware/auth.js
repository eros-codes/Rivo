import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

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
		next();
	} catch (err) {
		if (err && err.name === "TokenExpiredError") {
			return res.status(401).json({ error: "Token expired" });
		}
		return res.status(401).json({ error: "Invalid token" });
	}
}