// The devices signed in to the account (Settings → Devices).
import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { listSessions, revokeOtherSessions, revokeSession } from "../auth/sessions.ts";
import { log } from "../utils/logger.ts";
import { iso } from "../utils/wire.ts";
import { SessionParam } from "../../shared/schemas/account.ts";
import { parse } from "../http/validate.ts";
import { reply } from "../http/reply.ts";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
	try {
		const rows = await listSessions(req.userId);
		const sessions = rows
			.map((s) => ({
				id: s.id,
				current: s.id === req.sessionId,
				createdAt: iso(s.createdAt),
				lastSeenAt: iso(s.lastSeenAt),
				userAgent: s.userAgent || "",
			}))
			// this device first
			.sort((a, b) => Number(b.current) - Number(a.current));
		return void reply(res, "GET /api/sessions", { sessions });
	} catch (e) {
		log.error("listing sessions failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.post("/revoke-others", requireAuth, async (req, res) => {
	try {
		const revoked = await revokeOtherSessions(req.userId, req.sessionId);
		return void reply(res, "POST /api/sessions/revoke-others", { success: true, revoked });
	} catch (e) {
		log.error("revoking sessions failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.delete("/:id", requireAuth, async (req, res) => {
	const params = parse(res, SessionParam, req.params);
	if (!params) return;
	const { id } = params;
	if (id === req.sessionId) return void res.status(400).json({ error: "Use log out to end this device's session" });
	try {
		const own = (await listSessions(req.userId)).some((s) => s.id === id);
		if (!own) return void res.status(404).json({ error: "Session not found" });
		await revokeSession(id);
		return void reply(res, "DELETE /api/sessions/:id", { success: true });
	} catch (e) {
		log.error("revoking a session failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
