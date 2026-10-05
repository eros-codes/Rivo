// The devices signed in to the account (Settings → Devices).
import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { listSessions, revokeOtherSessions, revokeSession } from "../auth/sessions.ts";
import { log } from "../utils/logger.ts";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
	try {
		const rows = await listSessions(req.userId);
		const sessions = rows
			.map((s) => ({
				id: s.id,
				current: s.id === req.sessionId,
				createdAt: s.createdAt,
				lastSeenAt: s.lastSeenAt,
				userAgent: s.userAgent || "",
			}))
			// this device first
			.sort((a, b) => Number(b.current) - Number(a.current));
		return void res.json({ sessions });
	} catch (e) {
		log.error("listing sessions failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.post("/revoke-others", requireAuth, async (req, res) => {
	try {
		const revoked = await revokeOtherSessions(req.userId, req.sessionId);
		return void res.json({ success: true, revoked });
	} catch (e) {
		log.error("revoking sessions failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.delete("/:id", requireAuth, async (req, res) => {
	const id = String(req.params.id || "");
	if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return void res.status(400).json({ error: "Invalid session id" });
	if (id === req.sessionId) return void res.status(400).json({ error: "Use log out to end this device's session" });
	try {
		const own = (await listSessions(req.userId)).some((s) => s.id === id);
		if (!own) return void res.status(404).json({ error: "Session not found" });
		await revokeSession(id);
		return void res.json({ success: true });
	} catch (e) {
		log.error("revoking a session failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
