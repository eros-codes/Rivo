import { Router } from "express";
import prisma from "../prisma.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { parseId } from "../utils/validators.js";
import { applyPrivacy, relationsFor } from "../utils/privacy.js";
import { decryptBody, isCapsuleLocked, loadReplySenders, previewMessage, serializeMessage } from "../utils/messageView.js";
import { isMember } from "../services/caches.js";
import { clearConversation, statusFor } from "../services/messages.js";
import { RATE_LIMITED, spendBudget } from "../services/actionLimit.js";
import { log } from "../utils/logger.js";

const router = Router();

const MEMBER_USER_SELECT = {
	id: true,
	name: true,
	username: true,
	profilePics: true,
	isOnline: true,
	lastSeen: true,
	isDeleted: true,
	privacyOnline: true,
	privacyProfile: true,
};

const MESSAGE_INCLUDE = { reactions: { select: { userId: true, emoji: true }, orderBy: { id: "asc" } } };

async function sanitizeMembers(conversations, viewerId) {
	const ids = conversations.flatMap((c) => (c.members || []).map((m) => m.user?.id)).filter(Number.isInteger);
	const rel = await relationsFor(viewerId, ids);
	for (const c of conversations) {
		c.members = (c.members || []).map((m) => ({
			...m,
			user: m.user ? applyPrivacy(m.user, m.user.id === viewerId ? { hasViewer: true, blockedViewer: false } : rel.get(m.user.id)) : m.user,
		}));
	}
}

/** limit / before / beforeId of a page request, or { error }. */
function pageParams(query) {
	const { defaultLimit, maxLimit } = config.pages;
	const limit = Math.min(Math.max(parseId(String(query.limit ?? "")) || defaultLimit, 1), maxLimit);
	let before = null;
	if (query.before) {
		before = new Date(String(query.before));
		if (Number.isNaN(before.getTime())) return { error: "Invalid before date" };
	}
	const beforeId = query.beforeId ? parseId(String(query.beforeId)) : null;
	if (query.beforeId && !beforeId) return { error: "Invalid beforeId" };
	return { limit, before, beforeId };
}

/** Messages older than (before, beforeId), newest first then reversed. */
export async function loadPage(convId, viewerId, { limit, before, beforeId }) {
	const where = { conversationId: convId, isDeleted: false };
	if (before && beforeId) where.OR = [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }];
	else if (before) where.createdAt = { lt: before };
	const rows = await prisma.message.findMany({
		where,
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		include: MESSAGE_INCLUDE,
	});
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit).reverse();
	const replySenders = await loadReplySenders(page);
	const now = new Date();
	const messages = page.map((m) => {
		try {
			return serializeMessage(m, viewerId, { now, replySenders });
		} catch (e) {
			log.error("serialize failed", m.id, e?.message || e);
			return { id: m.id, conversationId: m.conversationId, senderId: m.senderId, text: "Message unavailable", createdAt: m.createdAt, reactions: [] };
		}
	});
	return { messages, hasMore };
}

async function memberOr403(req, res) {
	const convId = parseId(req.params.id);
	if (!convId) {
		res.status(400).json({ error: "Invalid conversation id" });
		return null;
	}
	if (!(await isMember(convId, req.userId))) {
		res.status(403).json({ error: "Forbidden" });
		return null;
	}
	return convId;
}

// ─── List (latest first) ──────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		const max = parseInt(process.env.MAX_CONVERSATIONS_TAKE || "100", 10);
		const take = Math.min(Math.max(parseId(String(req.query.take ?? "")) || parseInt(process.env.DEFAULT_CONVERSATIONS_TAKE || "50", 10), 1), max);
		const before = req.query.before ? new Date(String(req.query.before)) : null;
		if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: "Invalid before date" });
		const beforeId = req.query.beforeId ? parseId(String(req.query.beforeId)) : null;
		const where = { members: { some: { userId: req.userId } } };
		if (before) where.OR = [{ lastMessageAt: { lt: before } }, { lastMessageAt: before, id: { lt: beforeId || 2147483647 } }];
		const conversations = await prisma.conversation.findMany({
			where,
			take,
			orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
			include: {
				members: { include: { user: { select: MEMBER_USER_SELECT } } },
				messages: { where: { isDeleted: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
			},
		});
		await sanitizeMembers(conversations, req.userId);
		const now = new Date();
		for (const c of conversations) c.messages = c.messages.map((m) => previewMessage(m, req.userId, now));
		return res.json(conversations);
	} catch (e) {
		log.error("GET /conversations failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── A page of messages ───────────────────────────────────────────────────
// { messages (oldest first), hasMore, cursor }: `cursor` is the moment this
// page was read, for /changes later.
router.get("/:id/messages", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const p = pageParams(req.query);
		if (p.error) return res.status(400).json({ error: p.error });
		const cursor = new Date().toISOString();
		const page = await loadPage(convId, req.userId, p);
		return res.json({ ...page, cursor });
	} catch (e) {
		log.error("GET /conversations/:id/messages failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Changes since a moment ───────────────────────────────────────────────
// Every message created or changed after `since` (deleted ones as
// tombstones), oldest change first. Looked up a little earlier than `since`
// so a write that was in flight when the cursor was taken is not missed; the
// client applies changes idempotently. Too many changes → { reset: true }
// and the client loads the chat again.
router.get("/:id/changes", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const since = new Date(String(req.query.since || ""));
		if (Number.isNaN(since.getTime())) return res.status(400).json({ error: "Invalid since" });
		const cursor = new Date().toISOString();
		const { maxChanges, overlapMs } = config.sync;
		const rows = await prisma.message.findMany({
			where: { conversationId: convId, updatedAt: { gt: new Date(since.getTime() - overlapMs) } },
			orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
			take: maxChanges + 1,
			include: MESSAGE_INCLUDE,
		});
		if (rows.length > maxChanges) return res.json({ reset: true, messages: [], cursor });
		const replySenders = await loadReplySenders(rows.filter((m) => !m.isDeleted));
		const now = new Date();
		const messages = rows.map((m) => serializeMessage(m, req.userId, { now, replySenders }));
		return res.json({ reset: false, messages, cursor });
	} catch (e) {
		log.error("GET /conversations/:id/changes failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Pinned messages (oldest first) ───────────────────────────────────────
export async function pinnedOf(convId, viewerId) {
	const pinned = await prisma.message.findMany({
		where: { conversationId: convId, isPinned: true, isDeleted: false },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: {
			id: true,
			text: true,
			ciphertext: true,
			iv: true,
			auth_tag: true,
			wrapped_dek: true,
			key_id: true,
			senderId: true,
			createdAt: true,
			isTimeCapsule: true,
			scheduledFor: true,
			openedAt: true,
		},
	});
	const now = new Date();
	return pinned.map((m) => ({
		id: m.id,
		text: isCapsuleLocked(m, now) && m.senderId !== viewerId ? null : decryptBody(m).text,
		senderId: m.senderId,
		createdAt: m.createdAt,
	}));
}

router.get("/:id/pinned", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		return res.json({ pinned: await pinnedOf(convId, req.userId) });
	} catch (e) {
		log.error("GET /conversations/:id/pinned failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Conversation with its newest messages (older clients) ────────────────
router.get("/:id", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const p = pageParams(req.query);
		if (p.error) return res.status(400).json({ error: p.error });
		const conversation = await prisma.conversation.findUnique({
			where: { id: convId },
			include: { members: { include: { user: { select: MEMBER_USER_SELECT } } } },
		});
		if (!conversation) return res.status(404).json({ error: "Conversation not found" });
		await sanitizeMembers([conversation], req.userId);
		conversation.messages = (await loadPage(convId, req.userId, p)).messages;
		return res.json(conversation);
	} catch (e) {
		log.error("GET /conversations/:id failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Clear the chat (for both people) ─────────────────────────────────────
// `upToId`: the newest message the user saw when they chose to delete. Ones
// that arrived during the Undo window are not theirs to delete unseen.
router.delete("/:id/messages", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		let upToId = null;
		if (req.query.upToId !== undefined) {
			upToId = parseId(String(req.query.upToId));
			if (!upToId) return res.status(400).json({ error: "Invalid upToId" });
		}
		if (!spendBudget(req.userId, 1)) return res.status(429).json(RATE_LIMITED);
		const result = await clearConversation(req.userId, convId, { upToId });
		if (result.error) return res.status(statusFor(result)).json({ error: result.error });
		return res.json({ success: true });
	} catch (e) {
		log.error("DELETE /conversations/:id/messages failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;
