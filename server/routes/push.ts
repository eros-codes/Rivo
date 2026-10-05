import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import push from "../utils/push.ts";

const router = Router();

// The public VAPID key browsers subscribe with
router.get("/publicKey", (_req, res) => {
	const key = push.getPublicKey();
	if (!key) return void res.status(503).json({ error: "Notifications are not configured" });
	res.setHeader("Cache-Control", "no-cache");
	return void res.json({ publicKey: key });
});

// This device's subscription (tied to its session: signing it out stops it)
router.post("/subscribe", requireAuth, async (req, res) => {
	const sub = req.body;
	if (!sub || !push.isPushEndpoint(sub.endpoint)) return void res.status(400).json({ error: "Invalid subscription" });
	try {
		const ok = await push.addSubscription(req.userId, sub, req.sessionId);
		if (!ok) return void res.status(400).json({ error: "Invalid subscription" });
		return void res.json({ success: true });
	} catch {
		return void res.status(500).json({ error: "Server error" });
	}
});

router.post("/unsubscribe", requireAuth, async (req, res) => {
	const { endpoint } = req.body || {};
	if (typeof endpoint !== "string" || !endpoint) return void res.status(400).json({ error: "Missing endpoint" });
	try {
		await push.removeSubscriptionByEndpoint(req.userId, endpoint);
		return void res.json({ success: true });
	} catch {
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
