import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { parseIntSafe } from "../utils/validators.js";
import { deliverToConversation } from "../socket/index.js";
import { applyPrivacy, relationsFor } from "../utils/privacy.js";
import { loadReplySenders, previewMessage, serializeMessage } from "../utils/messageView.js";

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

// Member profiles as the viewer may see them
async function sanitizeMembers(conversations, viewerId) {
	const ids = [];
	for (const c of conversations) for (const m of c.members || []) if (m.user) ids.push(m.user.id);
	const rel = await relationsFor(viewerId, ids);
	for (const c of conversations) {
		c.members = (c.members || []).map((m) => ({
			...m,
			user: m.user
				? m.user.id === viewerId
					? applyPrivacy(m.user, { hasViewer: true, blockedViewer: false })
					: applyPrivacy(m.user, rel.get(m.user.id))
				: m.user,
		}));
	}
}

// ─── Get all conversations of current user ────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		// Pagination: limit the number of conversations returned to avoid OOM/DoS
		const MAX_TAKE = parseInt(process.env.MAX_CONVERSATIONS_TAKE || "100", 10);
		const DEFAULT_TAKE = parseInt(process.env.DEFAULT_CONVERSATIONS_TAKE || "50", 10);
		let take = parseInt(req.query.take, 10) || DEFAULT_TAKE;
		if (take < 1) take = 1;
		if (take > MAX_TAKE) take = MAX_TAKE;

		const before = req.query.before ? new Date(req.query.before) : null;
		if (before && isNaN(before.getTime())) return res.status(400).json({ error: "Invalid before date" });
		const beforeId = req.query.beforeId ? parseIntSafe(req.query.beforeId) : null;

		const where = {
			members: { some: { userId: req.userId } },
		};
		if (before) {
			where.AND = [
				{
					OR: [
						{ lastMessageAt: { lt: before } },
						{
							AND: [
								{ lastMessageAt: before },
								{ id: { lt: beforeId || Number.MAX_SAFE_INTEGER } },
							],
						},
					],
				},
			];
		}

		const conversations = await prisma.conversation.findMany({
			where,
			take,
			orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
			include: {
				members: {
					include: {
						user: { select: MEMBER_USER_SELECT },
					},
				},
				messages: {
					where: { isDeleted: false },
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					take: 1,
				},
			},
		});

		await sanitizeMembers(conversations, req.userId);
		const now = new Date();
		for (const c of conversations) {
			c.messages = (c.messages || []).map((m) => previewMessage(m, req.userId, now));
		}

		return res.json(conversations);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Get single conversation with messages ────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
	const conversationId = parseIntSafe(req.params.id);
	if (!conversationId) return res.status(400).json({ error: "Invalid conversation id" });

	try {
		const member = await prisma.conversationMember.findFirst({
			where: {
				conversationId,
				userId: req.userId,
			},
		});

		if (!member) return res.status(403).json({ error: "Forbidden" });

		// Pagination: default and limits
		const MAX_FETCH_LIMIT = parseInt(process.env.MAX_FETCH_LIMIT || "100", 10);
		const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_FETCH_LIMIT || "50", 10);
		let limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
		if (limit < 1) limit = 1;
		if (limit > MAX_FETCH_LIMIT) limit = MAX_FETCH_LIMIT;

		const before = req.query.before ? new Date(req.query.before) : null;
		if (before && isNaN(before.getTime())) return res.status(400).json({ error: "Invalid before date" });
		const beforeId = req.query.beforeId ? parseIntSafe(req.query.beforeId) : null;

		const conversation = await prisma.conversation.findUnique({
			where: { id: conversationId },
			include: {
				members: {
					include: {
						user: { select: MEMBER_USER_SELECT },
					},
				},
			},
		});

		if (!conversation) return res.status(404).json({ error: "Conversation not found" });

		// Build messages where clause with deterministic tie-breaker
		let where = { conversationId, isDeleted: false };
		if (before && beforeId) {
			where = {
				...where,
				AND: [
					{
						OR: [
							{ createdAt: { lt: before } },
							{
								AND: [
									{ createdAt: before },
									{ id: { lt: beforeId } },
								],
							},
						],
					},
				],
			};
		} else if (before) {
			where = { ...where, createdAt: { lt: before } };
		}

		const msgs = await prisma.message.findMany({
			where,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit,
			include: {
				sender: {
					select: { id: true, name: true, username: true },
				},
				reactions: {
					select: { userId: true, emoji: true },
				},
			},
		});

		await sanitizeMembers([conversation], req.userId);
		// Return ascending order, decrypted for this viewer (never ciphertext or keys)
		const ascending = msgs.reverse();
		const replySenders = await loadReplySenders(ascending);
		const now = new Date();
		conversation.messages = ascending.map((m) => serializeMessage(m, req.userId, { now, replySenders }));

		return res.json(conversation);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete all messages in a conversation (for both people) ──────────────────
router.delete("/:id/messages", requireAuth, async (req, res) => {
	const conversationId = parseIntSafe(req.params.id);
	if (!conversationId) return res.status(400).json({ error: "Invalid conversation id" });

	try {
		const member = await prisma.conversationMember.findFirst({
			where: { conversationId, userId: req.userId },
		});

		if (!member) return res.status(403).json({ error: "Forbidden" });

		// Fetch messages that will be affected so we can emit deletion events
		const msgs = await prisma.message.findMany({ where: { conversationId, isDeleted: false }, select: { id: true } });
		const ids = msgs.map((m) => m.id);

		if (ids.length === 0) {
			return res.json({ success: true });
		}

		// Mark those messages deleted
		await prisma.message.updateMany({ where: { id: { in: ids } }, data: { isDeleted: true, isPinned: false } });

		// Nothing is left to be unread for anyone in this conversation
		try {
			await prisma.contact.updateMany({ where: { conversationId }, data: { unreadCount: 0 } });
		} catch (e) {
			console.error('reset unread on bulk delete failed', e);
		}

		// Every device of both people (including this user's other devices)
		try {
			await deliverToConversation(conversationId, "messages:bulk-deleted", { conversationId, messageIds: ids });
		} catch (e) {
			console.error('broadcast deleted messages failed', e);
		}

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;
