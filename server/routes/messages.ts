import { Router, type Request, type Response } from "express";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { DeleteMessages, EditMessage, ForwardMessages, MessageParam, SearchMessages, SendMessage } from "../../shared/schemas/messages.ts";
import { MESSAGE_SEARCH_MIN } from "../../shared/limits.ts";
import { parse } from "../http/validate.ts";
import { decryptBody, isCapsuleLocked } from "../utils/messageView.ts";
import {
	deleteMessagesAs,
	editMessageAs,
	type Actor,
	forwardMessagesAs,
	sendMessageAs,
	statusFor,
	togglePinAs,
} from "../services/messages.ts";
import { batchCost, RATE_LIMITED, spendBudget } from "../services/actionLimit.ts";
import { log } from "../utils/logger.ts";
import { iso, isoOrNull } from "../utils/wire.ts";
import type { SearchHit } from "../../shared/api.ts";
import { reply } from "../http/reply.ts";

const router = Router();

// A REST call does not come from a socket; X-Socket-Id names the device's
// socket so it is not sent its own change as an event.
const actorOf = (req: Request): Actor => {
	const v = req.get("x-socket-id");
	return { userId: req.userId, socketId: typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null };
};

// Searching decrypts many messages on the server, so each user gets a limited
// number of searches per minute (typing already waits between keys).
const SEARCH_WINDOW_MS = 60_000;
const searchLog = new Map<number, number[]>();
function searchAllowed(userId: number): boolean {
	const now = Date.now();
	const recent = (searchLog.get(userId) || []).filter((t) => now - t < SEARCH_WINDOW_MS);
	const ok = recent.length < config.rate.search.perMinute;
	if (ok) recent.push(now);
	searchLog.set(userId, recent);
	return ok;
}
setInterval(() => {
	const now = Date.now();
	for (const [uid, times] of searchLog) if (!times.some((t) => now - t < SEARCH_WINDOW_MS)) searchLog.delete(uid);
}, SEARCH_WINDOW_MS).unref?.();

/** A batch of messages for the search, newest first, older than `cursor`. */
function searchBatch(convIds: number[], cursor: number | null, take: number) {
	return prisma.message.findMany({
		where: { conversationId: { in: convIds }, isDeleted: false, ...(cursor ? { id: { lt: cursor } } : {}) },
		orderBy: { id: "desc" },
		take,
		select: {
			id: true,
			conversationId: true,
			senderId: true,
			ciphertext: true,
			iv: true,
			auth_tag: true,
			wrapped_dek: true,
			key_id: true,
			createdAt: true,
			isEdited: true,
			isPinned: true,
			isSeen: true,
			isOneTime: true,
			isTimeCapsule: true,
			scheduledFor: true,
			openedAt: true,
		},
	});
}

// ─── Search ───────────────────────────────────────────────────────────────
router.get("/search", requireAuth, async (req, res) => {
	const query = parse(res, SearchMessages, req.query);
	if (!query) return;
	const { q } = query;
	if (q.length < MESSAGE_SEARCH_MIN) return void reply(res, "GET /api/messages/search", { results: [], truncated: false });
	if (!searchAllowed(req.userId)) return void res.status(429).json({ error: "Too many searches. Please wait a moment." });

	const MAX_RESULTS = 50;
	const BATCH = 1000;
	try {
		// only chats this user still has in their list
		const rows = await prisma.contact.findMany({ where: { ownerId: req.userId }, select: { conversationId: true } });
		const convIds = [...new Set(rows.map((r) => r.conversationId))];
		if (convIds.length === 0) return void reply(res, "GET /api/messages/search", { results: [], truncated: false });

		const results: SearchHit[] = [];
		const now = new Date();
		let scanned = 0;
		let cursor: number | null = null;
		// messages are encrypted: they are decrypted and matched here, newest first
		while (results.length < MAX_RESULTS && scanned < config.rate.search.maxScan) {
			const batch = await searchBatch(convIds, cursor, BATCH);
			if (batch.length === 0) break;
			scanned += batch.length;
			// (the batch is not empty here)
			cursor = batch[batch.length - 1]?.id ?? null;
			for (const m of batch) {
				if (results.length >= MAX_RESULTS) break;
				const mine = m.senderId === req.userId;
				// locked capsules and other people's one-time messages stay hidden
				if (!mine && (isCapsuleLocked(m, now) || m.isOneTime)) continue;
				const body = decryptBody(m);
				if (!body.ok || !body.text.toLowerCase().includes(q)) continue;
				results.push({
					id: m.id,
					messageId: m.id,
					conversationId: m.conversationId,
					senderId: m.senderId,
					text: body.text,
					createdAt: iso(m.createdAt),
					isEdited: m.isEdited,
					isPinned: m.isPinned,
					isSeen: m.isSeen,
					isOneTime: m.isOneTime,
					isTimeCapsule: m.isTimeCapsule,
					isLocked: false,
					scheduledFor: isoOrNull(m.scheduledFor),
					openedAt: isoOrNull(m.openedAt),
				});
			}
			if (batch.length < BATCH) break;
		}
		return void reply(res, "GET /api/messages/search", { results, truncated: scanned >= config.rate.search.maxScan });
	} catch (e) {
		log.error("search failed", e);
		return void res.status(500).json({ error: "Search failed" });
	}
});

// ─── Actions (same rules, budget and delivery as over the socket) ─────────
const overBudget = (req: Request, res: Response, cost = 1): boolean => {
	if (spendBudget(req.userId, cost)) return false;
	res.status(429).json(RATE_LIMITED);
	return true;
};

// how many items a batch request names (its cost is counted before it is checked)
const sizeOf = (list: unknown): number => (Array.isArray(list) ? list.length : 1);

router.post("/", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const body = parse(res, SendMessage, req.body);
	if (!body) return;
	const result = await sendMessageAs(actorOf(req), body);
	if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
	return void reply(res, "POST /api/messages", result.message, result.duplicate ? 200 : 201);
});

router.post("/forward", requireAuth, async (req, res) => {
	if (overBudget(req, res, batchCost(sizeOf(req.body?.items), 5))) return;
	const body = parse(res, ForwardMessages, req.body);
	if (!body) return;
	const result = await forwardMessagesAs(actorOf(req), body);
	// (a partly done forward has messages and an error: it is answered in full)
	if (!("messages" in result)) return void res.status(statusFor(result)).json({ error: result.error });
	return void reply(res, "POST /api/messages/forward", result);
});

// Several of the user's messages at once. Also used with `keepalive` when the
// page is closed during the undo window, so the deletion is not lost.
router.post("/delete", requireAuth, async (req, res) => {
	if (overBudget(req, res, batchCost(sizeOf(req.body?.messageIds), 10))) return;
	const body = parse(res, DeleteMessages, req.body);
	if (!body) return;
	const result = await deleteMessagesAs(actorOf(req), body);
	if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
	return void reply(res, "POST /api/messages/delete", result);
});

router.patch("/:id", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const edit = parse(res, EditMessage, { messageId: req.params.id, text: req.body?.text });
	if (!edit) return;
	const result = await editMessageAs(actorOf(req), edit);
	if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
	return void reply(res, "PATCH /api/messages/:id", result);
});

router.delete("/:id", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const params = parse(res, MessageParam, req.params);
	if (!params) return;
	const result = await deleteMessagesAs(actorOf(req), { messageIds: [params.id] });
	if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
	return void reply(res, "DELETE /api/messages/:id", { success: true });
});

router.post("/:id/pin", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const params = parse(res, MessageParam, req.params);
	if (!params) return;
	const result = await togglePinAs(actorOf(req), { messageId: params.id });
	if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
	return void reply(res, "POST /api/messages/:id/pin", { isPinned: result.isPinned });
});

export default router;
