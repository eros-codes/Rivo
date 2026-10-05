import { Router, type Request, type Response } from "express";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { parseId } from "../utils/validators.ts";
import { decryptBody, isCapsuleLocked } from "../utils/messageView.ts";
import { isMember } from "../services/caches.ts";
import {
	deleteMessagesAs,
	editMessageAs,
	type Actor,
	forwardMessagesAs,
	sendMessageAs,
	statusFor,
	togglePinAs,
} from "../services/messages.ts";
import { loadPage, pinnedOf } from "./conversations.ts";
import { batchCost, RATE_LIMITED, spendBudget } from "../services/actionLimit.ts";
import { log } from "../utils/logger.ts";

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
			text: true,
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
	const q = String(req.query.q || "").trim().toLowerCase();
	if (q.length < 2) return void res.json({ results: [] });
	if (q.length > 100) return void res.status(400).json({ error: "Query too long" });
	if (!searchAllowed(req.userId)) return void res.status(429).json({ error: "Too many searches. Please wait a moment." });

	const MAX_RESULTS = 50;
	const BATCH = 1000;
	try {
		// only chats this user still has in their list
		const rows = await prisma.contact.findMany({ where: { ownerId: req.userId }, select: { conversationId: true } });
		const convIds = [...new Set(rows.map((r) => r.conversationId))];
		if (convIds.length === 0) return void res.json({ results: [], truncated: false });

		const results: Record<string, unknown>[] = [];
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
					createdAt: m.createdAt,
					isEdited: m.isEdited,
					isPinned: m.isPinned,
					isSeen: m.isSeen,
					isOneTime: m.isOneTime,
					isTimeCapsule: m.isTimeCapsule,
					isLocked: false,
					scheduledFor: m.scheduledFor ? m.scheduledFor.toISOString() : null,
					openedAt: m.openedAt ? m.openedAt.toISOString() : null,
				});
			}
			if (batch.length < BATCH) break;
		}
		return void res.json({ results, truncated: scanned >= config.rate.search.maxScan });
	} catch (e) {
		log.error("search failed", e);
		return void res.status(500).json({ error: "Search failed" });
	}
});

// ─── Older clients: pinned list and pages by conversation id ──────────────
router.get("/:conversationId/pinned", requireAuth, async (req, res) => {
	const convId = parseId(req.params.conversationId);
	if (!convId) return void res.status(400).json({ error: "Invalid conversationId" });
	try {
		if (!(await isMember(convId, req.userId))) return void res.status(403).json({ error: "Not a member" });
		return void res.json({ pinned: await pinnedOf(convId, req.userId) });
	} catch (e) {
		log.error("pinned failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.get("/:conversationId", requireAuth, async (req, res) => {
	const convId = parseId(req.params.conversationId);
	if (!convId) return void res.status(400).json({ error: "Invalid conversationId" });
	const { defaultLimit, maxLimit } = config.pages;
	const limit = Math.min(Math.max(parseId(String(req.query.limit ?? "")) || defaultLimit, 1), maxLimit);
	const before = req.query.before ? new Date(String(req.query.before)) : null;
	if (before && Number.isNaN(before.getTime())) return void res.status(400).json({ error: "Invalid before date" });
	const beforeId = req.query.beforeId ? parseId(String(req.query.beforeId)) : null;
	try {
		if (!(await isMember(convId, req.userId))) return void res.status(403).json({ error: "Forbidden" });
		const { messages } = await loadPage(convId, req.userId, { limit, before, beforeId });
		return void res.json(messages);
	} catch (e) {
		log.error("messages page failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Actions (same rules, budget and delivery as over the socket) ─────────
const overBudget = (req: Request, res: Response, cost = 1): boolean => {
	if (spendBudget(req.userId, cost)) return false;
	res.status(429).json(RATE_LIMITED);
	return true;
};

router.post("/", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const result = await sendMessageAs(actorOf(req), req.body || {});
	if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
	return void res.status(result.duplicate ? 200 : 201).json(result.message);
});

router.post("/forward", requireAuth, async (req, res) => {
	if (overBudget(req, res, batchCost(Array.isArray(req.body?.items) ? req.body.items.length : 1, 5))) return;
	const result = await forwardMessagesAs(actorOf(req), req.body || {});
	// (a partly done forward has messages and an error: it is answered in full)
	if (!("messages" in result)) return void res.status(statusFor(result)).json({ error: result.error });
	return void res.json(result);
});

// Several of the user's messages at once. Also used with `keepalive` when the
// page is closed during the undo window, so the deletion is not lost.
router.post("/delete", requireAuth, async (req, res) => {
	if (overBudget(req, res, batchCost(Array.isArray(req.body?.messageIds) ? req.body.messageIds.length : 1, 10))) return;
	const result = await deleteMessagesAs(actorOf(req), { messageIds: req.body?.messageIds });
	if (result.error) return void res.status(statusFor(result)).json({ error: result.error });
	return void res.json(result);
});

router.patch("/:id", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const result = await editMessageAs(actorOf(req), { messageId: req.params.id, text: req.body?.text });
	if (result.error) return void res.status(statusFor(result)).json({ error: result.error });
	return void res.json(result);
});

router.delete("/:id", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const result = await deleteMessagesAs(actorOf(req), { messageIds: [req.params.id] });
	if (result.error) return void res.status(statusFor(result)).json({ error: result.error });
	return void res.json({ success: true });
});

router.post("/:id/pin", requireAuth, async (req, res) => {
	if (overBudget(req, res)) return;
	const result = await togglePinAs(actorOf(req), { messageId: req.params.id });
	if (result.error) return void res.status(statusFor(result)).json({ error: result.error });
	return void res.json({ isPinned: result.isPinned });
});

export default router;
