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

		// Fetch messages that will be affected so we can emit deletion events
		// and adjust unread counters for recipients. Only consider messages
		// that are currently not deleted.
		const msgs = await prisma.message.findMany({ where: { conversationId, isDeleted: false }, select: { id: true, isSeen: true } });
		const ids = msgs.map((m) => m.id);

		if (ids.length === 0) {
			return res.json({ success: true });
		}

		// Mark those messages deleted
		await prisma.message.updateMany({ where: { id: { in: ids } }, data: { isDeleted: true } });

		// If any of the deleted messages were unseen, decrement recipients' unread counts
		const unseenCount = msgs.filter((m) => !m.isSeen).length;
		try {
			if (unseenCount > 0) {
				const recipientContacts = await prisma.contact.findMany({ where: { conversationId, ownerId: { not: req.userId } }, select: { id: true, unreadCount: true } });
				for (const rc of recipientContacts) {
					const dec = Math.min(rc.unreadCount || 0, unseenCount);
					if (dec > 0) {
						try {
							await prisma.contact.update({ where: { id: rc.id }, data: { unreadCount: { decrement: dec } } });
						} catch (e) {
							/* ignore individual update failures */
						}
					}
				}
			}
		} catch (e) {
			console.error('adjust unread on bulk delete failed', e);
		}

		// Broadcast deletion events so connected clients can update their UI
		try {
			const io = globalThis.__rivo_io;
			if (io) {
				// Notify room first
				for (const mid of ids) {
					io.to(`conversation:${conversationId}`).emit('message:deleted', { messageId: mid });
				}

				// Also deliver the delete event directly to connected sockets of recipients
				const recipientContacts = await prisma.contact.findMany({ where: { conversationId }, select: { ownerId: true } });
				const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId).filter((id) => id !== req.userId)));
				for (const uid of recipientUserIds) {
					try {
						for (const s of io.sockets.sockets.values()) {
							try {
								if (s && s.userId === uid) {
									// Skip sockets already in the room (they already received the room emit)
									try {
										if (s.rooms && s.rooms.has(`conversation:${conversationId}`)) continue;
									} catch (e) { /* ignore room-check failures */ }
									for (const mid of ids) {
										try { s.emit('message:deleted', { messageId: mid }); } catch (e) { /* ignore per-socket errors */ }
									}
								}
							} catch (e) { /* ignore per-socket */ }
						}
					} catch (e) { /* ignore per-user failures */ }
				}
			}
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
