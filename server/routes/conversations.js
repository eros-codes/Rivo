import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { parseIntSafe } from "../utils/validators.js";

const router = Router();

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
						user: {
							select: {
								id: true,
								name: true,
								username: true,
								profilePics: true,
								isOnline: true,
								lastSeen: true,
							},
						},
					},
				},
				messages: {
					where: { isDeleted: false },
					orderBy: { createdAt: "desc" },
					take: 1,
					select: {
						id: true,
						conversationId: true,
						senderId: true,
						text: true,
						isSeen: true,
						isEdited: true,
						isPinned: true,
						isDeleted: true,
						replyToId: true,
						replyToName: true,
						forwardedFrom: true,
						createdAt: true,
						sender: {
							select: { id: true, name: true, username: true, profilePics: true },
						},
					},
				},
			},
		});

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
		const beforeId = req.query.beforeId ? parseIntSafe(req.query.beforeId) : null;

		// Fetch conversation without messages, then fetch messages separately
		const conversation = await prisma.conversation.findUnique({
			where: { id: conversationId },
			include: {
				members: {
					include: {
						user: {
							select: {
								id: true,
								name: true,
								username: true,
								profilePics: true,
								isOnline: true,
								lastSeen: true,
							},
						},
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
					select: { id: true, name: true, username: true, profilePics: true },
				},
			},
		});

		// Return ascending order to the client
		conversation.messages = msgs.reverse();

		return res.json(conversation);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete all messages in a conversation ────────────────────────────────────
router.delete("/:id/messages", requireAuth, async (req, res) => {
    const conversationId = parseInt(req.params.id);

    try {
        const member = await prisma.conversationMember.findFirst({
            where: { conversationId, userId: req.userId },
        });

        if (!member) return res.status(403).json({ error: "Forbidden" });

		// NOTE: Previously this endpoint marked all messages in a conversation
		// as deleted for everyone. That's a global delete which removes the
		// other participant's history. As a safer interim measure, only mark
		// messages authored by the requesting user as deleted. A proper
		// per-user soft-delete requires a schema migration (e.g., a
		// Message.deletedFor array or a ChatDeletion table) which should be
		// implemented separately.
		await prisma.message.updateMany({
			where: { conversationId, senderId: req.userId },
			data: { isDeleted: true },
		});

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;
