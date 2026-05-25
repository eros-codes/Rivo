import { Router } from "express";
import { unwrapDEK, decryptMessage } from "../utils/encryption.js";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// ─── Get all contacts ─────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		// pagination for contacts: prevent returning unbounded contact lists
		const MAX_FETCH_LIMIT = parseInt(process.env.MAX_FETCH_LIMIT || "100", 10);
		const DEFAULT_LIMIT = parseInt(process.env.CONTACTS_DEFAULT_LIMIT || "50", 10);
		let limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
		if (limit < 1) limit = 1;
		if (limit > MAX_FETCH_LIMIT) limit = MAX_FETCH_LIMIT;
		const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;

		const whereClause = { ownerId: req.userId };
		if (beforeId) whereClause.id = { lt: beforeId };

		const contacts = await prisma.contact.findMany({
			where: whereClause,
			take: limit,
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
				{ isSaved: "desc" },
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

		// Attempt to decrypt the latest message for each contact so the
		// client can display a readable preview in contact lists.
		// If decryption fails, fall back to a generic placeholder.
		for (const cc of sanitized) {
			try {
				const conv = cc.conversation;
				if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) continue;
				const m = conv.messages[0];
				// prefer plaintext if present
				if (m.text) continue;
				if (m.ciphertext && m.wrapped_dek) {
					try {
						const dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
						m.text = decryptMessage(m.ciphertext, m.iv, m.auth_tag, dek);
					} catch (e) {
						m.text = "Message unavailable";
					}
				} else {
					m.text = m.text || "";
				}
			} catch (e) {
				// do not fail the entire request for one contact
			}
		}

		// Strip sensitive encrypted fields from message previews and only
		// return a safe preview object for the client to display.
		for (const cc of sanitized) {
			try {
				const conv = cc.conversation;
				if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) continue;
				const m = conv.messages[0];
				const preview = {
					id: m.id,
					conversationId: m.conversationId,
					senderId: m.senderId,
					text: m.text || null,
					createdAt: m.createdAt,
					isDeleted: m.isDeleted,
					isEdited: m.isEdited,
					isPinned: m.isPinned,
					isSeen: m.isSeen,
				};
				conv.messages = [preview];
			} catch (e) {
				/* ignore preview sanitization errors */
			}
		}

		// Auto-create saved messages for existing users
		const hasSaved = contacts.some((c) => c.isSaved);
		if (!hasSaved) {
			await prisma.$transaction(async (tx) => {
				const savedConv = await tx.conversation.create({
					data: { members: { create: [{ userId: req.userId }] } },
				});
				await tx.contact.create({
					data: {
						ownerId: req.userId,
						contactId: req.userId,
						conversationId: savedConv.id,
						isSaved: true,
					},
				});
			});
			// re-fetch
			const refetched = await prisma.contact.findFirst({
				where: { ownerId: req.userId, isSaved: true },
				include: {
					conversation: {
						select: {
							id: true,
							messages: {
								take: 1,
								orderBy: { createdAt: "desc" },
							},
						},
					},
				},
			});
			if (refetched) {
				sanitized.unshift({
					...refetched,
					contact: {
						id: req.userId,
						name: "Saved Messages",
						username: "",
						profilePics: [],
						bio: "",
						isOnline: true,
						lastSeen: null,
					},
					conversationId: refetched.conversationId,
					isSaved: true,
				});
			}
		}

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

		// If the target user already has us as a contact, reuse their
		// conversation and only create our side. This prevents creating
		// duplicate contact rows for the target user when re-adding.
		const reciprocal = await prisma.contact.findFirst({
			where: {
				ownerId: targetUser.id,
				contactId: req.userId,
			},
		});

		if (reciprocal) {
			const contact = await prisma.contact.create({
				data: {
					ownerId: req.userId,
					contactId: targetUser.id,
					conversationId: reciprocal.conversationId,
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
			});

			return res.status(201).json(contact);
		}

		// Create conversation and contacts inside a single transaction so
		// we don't leave an orphaned conversation if one of the contact
		// creations fails.
		const [contact] = await prisma.$transaction(async (tx) => {
			const conversation = await tx.conversation.create({
				data: {
					members: {
						create: [{ userId: req.userId }, { userId: targetUser.id }],
					},
				},
			});

			const c1 = await tx.contact.create({
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
			});

			await tx.contact.create({
				data: {
					ownerId: targetUser.id,
					contactId: req.userId,
					conversationId: conversation.id,
				},
			});

			return [c1];
		});

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
	const { isPinned, pinOrder, isMuted, isBlocked, nickname, isArchived } = req.body;

	// Sanitize nickname to avoid stored-DoS via large nicknames
	const safeNickname = typeof nickname === 'string' ? nickname.trim().slice(0, 100) : undefined;

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
				...(nickname !== undefined && { nickname: safeNickname }),
				...(isArchived !== undefined && { isArchived }),
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

		// Delete the contact and any reciprocal contact entries for the
		// other user. Use a transaction to avoid partial deletes.
		await prisma.$transaction(async (tx) => {
			await tx.contact.delete({ where: { id: contactId } });
			await tx.contact.deleteMany({
				where: { ownerId: contact.contactId, contactId: req.userId },
			});

			// If the conversation no longer has contacts, remove it inside the
			// same transaction to avoid races where concurrent deletes both
			// attempt to remove the conversation.
			const remaining = await tx.contact.findFirst({ where: { conversationId: contact.conversationId } });
			if (!remaining && contact.conversationId) {
				// Only delete the conversation if there are no messages.
				// Conversations may have messages even after contacts are removed
				// (e.g., message history). Attempting to delete a conversation
				// with existing messages can violate FK constraints and cause
				// a transaction failure. Safely check message count first.
				const msgCount = await tx.message.count({ where: { conversationId: contact.conversationId } });
				if (msgCount === 0) {
					await tx.conversation.delete({ where: { id: contact.conversationId } });
				} else {
					// Keep the conversation to preserve message history.
				}
			}
		});

		// Notify affected connected clients via socket.io so UIs update in real-time.
		try {
			const io = globalThis.__rivo_io;
			if (io) {
				// Emit to sockets belonging to the removed contact (the other user)
				for (const s of io.sockets.sockets.values()) {
					try {
						if (s && s.userId === contact.contactId) {
							s.emit("contact:removed", {
								contactUserId: req.userId,
								conversationId: contact.conversationId,
							});
						}
						// Also inform the requester's other sockets so multiple tabs stay in sync
						if (s && s.userId === req.userId) {
							s.emit("contact:removed", {
								contactUserId: contact.contactId,
								conversationId: contact.conversationId,
							});
						}
					} catch (e) {
						/* ignore per-socket failures */
					}
				}
			}
		} catch (e) {
			console.error("emit contact removed failed", e);
		}

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;