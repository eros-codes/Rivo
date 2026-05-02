import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
	// Prefer cookie named `token` (cookie-parser populates req.cookies), fallback to Authorization header.
	const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];

	if (!token) {
		return res.status(401).json({ error: "Unauthorized" });
	}

	try {
		const payload = jwt.verify(token, process.env.JWT_SECRET);
		req.userId = payload.userId;
		next();
	} catch (err) {
		return res.status(401).json({ error: "Invalid token" });
	}
}