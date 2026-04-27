import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// ─── Get all conversations of current user ────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		const conversations = await prisma.conversation.findMany({
			where: {
				members: {
					some: { userId: req.userId },
				},
			},
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
				},
			},
			orderBy: { lastMessageAt: "desc" },
		});

		return res.json(conversations);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Get single conversation with messages ────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
	const conversationId = parseInt(req.params.id);

	try {
		const member = await prisma.conversationMember.findFirst({
			where: {
				conversationId,
				userId: req.userId,
			},
		});

		if (!member) {
			return res.status(403).json({ error: "Forbidden" });
		}

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
				messages: {
					where: { isDeleted: false },
					orderBy: { createdAt: "asc" },
					include: {
						sender: {
							select: {
								id: true,
								name: true,
								username: true,
								profilePics: true,
							},
						},
					},
				},
			},
		});

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

        await prisma.message.updateMany({
            where: { conversationId },
            data: { isDeleted: true },
        });

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;
