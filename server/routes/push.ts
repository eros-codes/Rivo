import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import push from "../utils/push.ts";
import { PushSubscriptionInput, PushUnsubscribe } from "../../shared/schemas/account.ts";
import { parse } from "../http/validate.ts";
import { reply } from "../http/reply.ts";

const router = Router();

// The public VAPID key browsers subscribe with
router.get("/publicKey", (_req, res) => {
	const key = push.getPublicKey();
	if (!key) return void res.status(503).json({ error: "Notifications are not configured" });
	res.setHeader("Cache-Control", "no-cache");
	return void reply(res, "GET /api/push/publicKey", { publicKey: key });
});

// This device's subscription (tied to its session: signing it out stops it)
router.post("/subscribe", requireAuth, async (req, res) => {
	const sub = parse(res, PushSubscriptionInput, req.body);
	if (!sub) return;
	// only the push services of real browsers (anything else would have the server call any address)
	if (!push.isPushEndpoint(sub.endpoint)) return void res.status(400).json({ error: "Invalid subscription" });
	try {
		const ok = await push.addSubscription(req.userId, sub, req.sessionId);
		if (!ok) return void res.status(400).json({ error: "Invalid subscription" });
		return void reply(res, "POST /api/push/subscribe", { success: true });
	} catch {
		return void res.status(500).json({ error: "Server error" });
	}
});

router.post("/unsubscribe", requireAuth, async (req, res) => {
	const body = parse(res, PushUnsubscribe, req.body);
	if (!body) return;
	const { endpoint } = body;
	try {
		await push.removeSubscriptionByEndpoint(req.userId, endpoint);
		return void reply(res, "POST /api/push/unsubscribe", { success: true });
	} catch {
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
