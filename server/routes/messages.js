import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { isNonEmptyString, parseIntSafe, MAX_MESSAGE_LENGTH } from "../utils/validators.js";

const router = Router();

// ─── Get messages of a conversation ──────────────────────────────────────────
router.get("/:conversationId", requireAuth, async (req, res) => {
	const conversationId = parseInt(req.params.conversationId);

	try {
		// چک کن user عضو این conversation هست
		const member = await prisma.conversationMember.findFirst({
			where: {
				conversationId,
				userId: req.userId,
			},
		});

		if (!member) {
			return res.status(403).json({ error: "Forbidden" });
		}

		const messages = await prisma.message.findMany({
			where: {
				conversationId,
				isDeleted: false,
			},
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
		});

		return res.json(messages);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Send message ─────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
	const {
		conversationId,
		text,
		replyToId,
		replyToName,
		replyToText,
		forwardedFrom,
		forwardedText,
	} = req.body;

	const convId = parseIntSafe(conversationId);
	if (!convId || !isNonEmptyString(text, MAX_MESSAGE_LENGTH)) {
		return res
			.status(400)
			.json({ error: "conversationId and text are required or invalid" });
	}

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

		const message = await prisma.message.create({
			data: {
				conversationId,
				senderId: req.userId,
				text: text.trim(),
				...(replyToId && { replyToId }),
				...(replyToName && { replyToName }),
				...(replyToText && { replyToText }),
				...(forwardedFrom && { forwardedFrom }),
				...(forwardedText && { forwardedText }),
			},
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
		});

		// lastMessageAt conversation رو آپدیت کن
		await prisma.conversation.update({
			where: { id: conversationId },
			data: { lastMessageAt: message.createdAt },
		});

		return res.status(201).json(message);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Edit message ─────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, async (req, res) => {
	const messageId = parseInt(req.params.id);
	const { text } = req.body;

	if (!isNonEmptyString(text, MAX_MESSAGE_LENGTH)) {
		return res.status(400).json({ error: "Text is required" });
	}

	try {
		const message = await prisma.message.findUnique({
			where: { id: messageId },
		});

		if (!message) {
			return res.status(404).json({ error: "Message not found" });
		}

		if (message.senderId !== req.userId) {
			return res.status(403).json({ error: "Forbidden" });
		}

		const updated = await prisma.message.update({
			where: { id: messageId },
			data: {
				text: text.trim(),
				isEdited: true,
			},
		});

		return res.json(updated);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete message ───────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
	const messageId = parseInt(req.params.id);

	try {
		const message = await prisma.message.findUnique({
			where: { id: messageId },
		});

		if (!message) {
			return res.status(404).json({ error: "Message not found" });
		}

		if (message.senderId !== req.userId) {
			return res.status(403).json({ error: "Forbidden" });
		}

		await prisma.message.update({
			where: { id: messageId },
			data: { isDeleted: true },
		});

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Pin message ──────────────────────────────────────────────────────────────
router.post("/:id/pin", requireAuth, async (req, res) => {
	const messageId = parseInt(req.params.id);

	try {
		const message = await prisma.message.findUnique({
			where: { id: messageId },
		});

		if (!message) {
			return res.status(404).json({ error: "Message not found" });
		}

		// چک کن user عضو این conversation هست
		const member = await prisma.conversationMember.findFirst({
			where: {
				conversationId: message.conversationId,
				userId: req.userId,
			},
		});

		if (!member) {
			return res.status(403).json({ error: "Forbidden" });
		}

		const updated = await prisma.message.update({
			where: { id: messageId },
			data: { isPinned: !message.isPinned },
		});

		return res.json({ isPinned: updated.isPinned });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;