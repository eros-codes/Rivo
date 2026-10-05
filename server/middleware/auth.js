// Requests of signed-in users: the session cookie must name a valid session.
import { clearSessionCookies, loadSession, readToken, tokenFromRequest, touchSession } from "../auth/sessions.js";
import { addLogContext, log } from "../utils/logger.js";

export async function requireAuth(req, res, next) {
	const payload = readToken(tokenFromRequest(req));
	if (!payload) return res.status(401).json({ error: "Unauthorized" });

	let session;
	try {
		session = await loadSession(payload);
	} catch (e) {
		// a database problem is not "signed out": say what happened
		log.error("session lookup failed", e);
		return res.status(503).json({ error: "Service unavailable" });
	}
	if (!session) {
		clearSessionCookies(res);
		return res.status(401).json({ error: "Session ended" });
	}

	req.userId = session.userId;
	req.sessionId = session.id;
	addLogContext({ userId: session.userId });
	touchSession(session, payload, res);
	next();
}
