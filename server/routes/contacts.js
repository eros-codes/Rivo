import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// ─── Get all contacts ─────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		const contacts = await prisma.contact.findMany({
			where: { ownerId: req.userId },
			include: {
				contact: {
					select: {
						id: true,
						name: true,
						username: true,
						profilePics: true,
						isOnline: true,
						lastSeen: true,
						email: true,
						privacyOnline: true,
						privacyEmail: true,
						privacyProfile: true,
					},
				},
				conversation: {
					include: {
						messages: {
							where: { isDeleted: false },
							orderBy: { createdAt: "desc" },
							take: 1,
						},
					},
				},
			},
			orderBy: [
				{ isPinned: "desc" },
				{ pinOrder: "asc" },
				{ conversation: { lastMessageAt: "desc" } },
			],
		});

		// Apply simple privacy filters based on the contact's privacy fields
		const sanitized = contacts.map((c) => {
			const cc = { ...c };
			if (cc.contact) {
				const p = cc.contact;
				if (p.privacyOnline === "nobody") {
					cc.contact.isOnline = false;
					cc.contact.lastSeen = null;
				}
				if (p.privacyEmail === "nobody") {
					cc.contact.email = null;
				}
				if (p.privacyProfile === "nobody") {
					cc.contact.profilePics = [];
				}
				// strip privacy fields from response
				delete cc.contact.privacyOnline;
				delete cc.contact.privacyEmail;
				delete cc.contact.privacyProfile;
			}
			return cc;
		});

		return res.json(sanitized);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Add contact ──────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
	const { username, name } = req.body;

	if (!username) {
		return res.status(400).json({ error: "Username is required" });
	}

	if (name !== undefined && typeof name !== "string") {
		return res.status(400).json({ error: "Name must be a string" });
	}

	try {
		const targetUser = await prisma.user.findUnique({
			where: { username },
		});

		if (!targetUser) {
			return res.status(404).json({ error: "User not found" });
		}

		if (targetUser.id === req.userId) {
			return res.status(400).json({ error: "You cannot add yourself" });
		}

		const existing = await prisma.contact.findFirst({
			where: {
				ownerId: req.userId,
				contactId: targetUser.id,
			},
		});

		if (existing) {
			return res.status(409).json({ error: "Contact already exists" });
		}

		// conversation مشترک بساز
		const conversation = await prisma.conversation.create({
			data: {
				members: {
					create: [{ userId: req.userId }, { userId: targetUser.id }],
				},
			},
		});

		// contact برای هر دو طرف بساز
		const [contact] = await prisma.$transaction([
			prisma.contact.create({
				data: {
					ownerId: req.userId,
					contactId: targetUser.id,
					conversationId: conversation.id,
					nickname: name || null,
				},
				include: {
					contact: {
						select: {
							id: true,
							name: true,
							username: true,
							profilePics: true,
							bio: true,
							isOnline: true,
							lastSeen: true,
							privacyOnline: true,
							privacyEmail: true,
							privacyProfile: true,
						},
					},
				},
			}),
			prisma.contact.create({
				data: {
					ownerId: targetUser.id,
					contactId: req.userId,
					conversationId: conversation.id,
				},
			}),
		]);

		return res.status(201).json(contact);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Update contact (pin, mute, block, nickname) ──────────────────────────────
router.patch("/:id", requireAuth, async (req, res) => {
	const contactId = parseInt(req.params.id);
	// Prevent clients from setting server-controlled fields
	const { isPinned, pinOrder, isMuted, isBlocked, nickname } = req.body;

	try {
		const contact = await prisma.contact.findFirst({
			where: {
				id: contactId,
				ownerId: req.userId,
			},
		});

		if (!contact) {
			return res.status(404).json({ error: "Contact not found" });
		}

		const updated = await prisma.contact.update({
			where: { id: contactId },
			data: {
				...(isPinned !== undefined && { isPinned }),
				...(pinOrder !== undefined && { pinOrder }),
				...(isMuted !== undefined && { isMuted }),
				...(isBlocked !== undefined && { isBlocked }),
				...(nickname !== undefined && { nickname }),
			},
		});

		return res.json(updated);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete contact ───────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
	const contactId = parseInt(req.params.id);

	try {
		const contact = await prisma.contact.findFirst({
			where: {
				id: contactId,
				ownerId: req.userId,
			},
		});

		if (!contact) {
			return res.status(404).json({ error: "Contact not found" });
		}

		await prisma.contact.delete({ where: { id: contactId } });

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;