import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { isNonEmptyString, parseIntSafe, MAX_MESSAGE_LENGTH } from "../utils/validators.js";
import { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage } from "../utils/encryption.js";

const router = Router();

// ─── Search messages ───────────────────────────────────────────────────────
router.get("/search", requireAuth, async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (!q || q.length < 2) {
        return res.json({ results: [] });
    }

    const MAX_RESULTS = 50;
    const MAX_SCAN = 1000;

    try {
        const memberships = await prisma.conversationMember.findMany({
            where: { userId: req.userId },
            select: { conversationId: true },
        });

        const convIds = memberships.map((m) => m.conversationId);
        if (convIds.length === 0) return res.json({ results: [] });

        const rows = await prisma.message.findMany({
            where: {
                conversationId: { in: convIds },
                isDeleted: false,
            },
            orderBy: { createdAt: "desc" },
            take: MAX_SCAN,
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
            },
        });

        const results = [];
        for (const m of rows) {
            if (results.length >= MAX_RESULTS) break;

            let plaintext = m.text || "";
            if (!plaintext && m.ciphertext && m.wrapped_dek) {
                try {
                    const dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
                    plaintext = decryptMessage(m.ciphertext, m.iv, m.auth_tag, dek);
                } catch {
                    continue;
                }
            }

            if (!plaintext.toLowerCase().includes(q)) continue;

            results.push({
                messageId: m.id,
                conversationId: m.conversationId,
                senderId: m.senderId,
                text: plaintext,
                createdAt: m.createdAt,
                isEdited: m.isEdited,
                isPinned: m.isPinned,
                isSeen: m.isSeen,
            });
        }

        return res.json({ results });
    } catch (err) {
        console.error("Search error:", err);
        return res.status(500).json({ error: "Search failed" });
    }
});

// ─── Get messages of a conversation ──────────────────────────────────────────
router.get("/:conversationId", requireAuth, async (req, res) => {
	const conversationId = parseIntSafe(req.params.conversationId);
	if (!conversationId) return res.status(400).json({ error: "Invalid conversationId" });
	// pagination params
	const MAX_FETCH_LIMIT = parseInt(process.env.MAX_FETCH_LIMIT || "100", 10);
	const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_FETCH_LIMIT || "50", 10);
	let limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
	if (limit < 1) limit = 1;
	if (limit > MAX_FETCH_LIMIT) limit = MAX_FETCH_LIMIT;
	const before = req.query.before ? new Date(req.query.before) : null;
	const beforeId = req.query.beforeId ? parseIntSafe(req.query.beforeId) : null;

	try {
		// check that user is member of this conversation
		const member = await prisma.conversationMember.findFirst({
			where: {
				conversationId,
				userId: req.userId,
			},
		});

		if (!member) {
			return res.status(403).json({ error: "Forbidden" });
		}

		// Build a where clause that supports a createdAt + id tie-breaker so
		// ordering is deterministic when multiple messages share the same timestamp.
		let where = {
			conversationId,
			isDeleted: false,
		};

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

		// fetch newest messages first then reverse so client receives ascending order
		const msgs = await prisma.message.findMany({
			where,
			orderBy: [ { createdAt: "desc" }, { id: "desc" } ],
			take: limit,
			include: {
				sender: {
					select: {
						id: true,
						name: true,
						username: true,
						profilePics: true,
					},
				},
				reactions: {
					select: { userId: true, emoji: true },
				},
			},
		});

		// decrypt messages synchronously (page size limited) and return sanitized objects
		const reversed = msgs.reverse();
		const decrypted = reversed.map((m) => {
			try {
				let text = "";
				let replyToTextPlain = null;
				let forwardedTextPlain = null;
				let dek = null;

				if (m.ciphertext) {
					try {
						dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
						text = decryptMessage(m.ciphertext, m.iv, m.auth_tag, dek);
					} catch (e) {
						console.error("decrypt failed for message", m.id, e.message);
						text = "Message unavailable";
					}
				} else if (m.text) {
					text = m.text;
				} else {
					text = "Message unavailable";
				}

				// replyToText: may be stored as encrypted JSON {c,iv,t} or legacy plaintext
				if (m.replyToText) {
					try {
						const parsed = JSON.parse(m.replyToText);
						if (parsed && parsed.c && parsed.iv && parsed.t) {
							if (dek) {
								try {
									replyToTextPlain = decryptMessage(parsed.c, parsed.iv, parsed.t, dek);
								} catch (e) {
									console.error("failed to decrypt replyToText", m.id, e.message);
									replyToTextPlain = "Message unavailable";
								}
							} else {
								replyToTextPlain = "Message unavailable";
							}
						} else {
							replyToTextPlain = m.replyToText;
						}
					} catch (e) {
						replyToTextPlain = m.replyToText;
					}
				}

				// forwardedText: same logic
				if (m.forwardedText) {
					try {
						const parsed = JSON.parse(m.forwardedText);
						if (parsed && parsed.c && parsed.iv && parsed.t) {
							if (dek) {
								try {
									forwardedTextPlain = decryptMessage(parsed.c, parsed.iv, parsed.t, dek);
								} catch (e) {
									console.error("failed to decrypt forwardedText", m.id, e.message);
									forwardedTextPlain = "Message unavailable";
								}
							} else {
								forwardedTextPlain = "Message unavailable";
							}
						} else {
							forwardedTextPlain = m.forwardedText;
						}
					} catch (e) {
						forwardedTextPlain = m.forwardedText;
					}
				}

				return {
					id: m.id,
					conversationId: m.conversationId,
					sender: m.sender,
					senderId: m.senderId,
					text,
					isSeen: m.isSeen,
					isEdited: m.isEdited,
					isPinned: m.isPinned,
					isDeleted: m.isDeleted,
					replyToId: m.replyToId,
					replyToName: m.replyToName,
					replyToText: replyToTextPlain,
					forwardedText: forwardedTextPlain,
					forwardedFrom: m.forwardedFrom,
					reactions: m.reactions || [],
					createdAt: m.createdAt,
				};
			} catch (err) {
				console.error(err);
				return { id: m.id, conversationId: m.conversationId, sender: m.sender, senderId: m.senderId, text: "Message unavailable", createdAt: m.createdAt };
			}
		});

		return res.json(decrypted);
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
				conversationId: convId,
				userId: req.userId,
			},
		});

		if (!member) {
			return res.status(403).json({ error: "Forbidden" });
		}

		// Encrypt message before persisting. Do NOT store plaintext.
		const dek = generateDEK();
		const { ciphertext, iv, authTag } = encryptMessage(text.trim(), dek);
		const keyId = "v1"; // KEK version (change when rotating)
		const wrappedDek = wrapDEK(dek, keyId);

		// Optionally encrypt replyToText and forwardedText using same DEK
		let replyToTextEncrypted = null;
		let forwardedTextEncrypted = null;
		if (replyToText && typeof replyToText === 'string' && replyToText.trim()) {
			const r = encryptMessage(replyToText.trim(), dek);
			replyToTextEncrypted = JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
		}
		if (forwardedText && typeof forwardedText === 'string' && forwardedText.trim()) {
			const f = encryptMessage(forwardedText.trim(), dek);
			forwardedTextEncrypted = JSON.stringify({ c: f.ciphertext, iv: f.iv, t: f.authTag });
		}

		const message = await prisma.message.create({
			data: {
				conversationId: convId,
				senderId: req.userId,
				// keep legacy text column null during migration
				text: null,
				ciphertext,
				iv,
				auth_tag: authTag,
				wrapped_dek: wrappedDek,
				key_id: keyId,
				...(replyToId && { replyToId }),
				...(replyToName && { replyToName }),
				...(replyToTextEncrypted && { replyToText: replyToTextEncrypted }),
				...(forwardedTextEncrypted && { forwardedText: forwardedTextEncrypted }),
				...(forwardedFrom && { forwardedFrom }),
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
			where: { id: convId },
			data: { lastMessageAt: message.createdAt },
		});

		// do not return ciphertext/wrapped keys to the client; include plaintexts in response
		const safe = {
			id: message.id,
			conversationId: message.conversationId,
			sender: message.sender,
			senderId: message.senderId,
			text: text.trim(),
			replyToText: replyToText || null,
			forwardedText: forwardedText || null,
			isSeen: message.isSeen,
			isEdited: message.isEdited,
			isPinned: message.isPinned,
			isDeleted: message.isDeleted,
			replyToId: message.replyToId,
			replyToName: message.replyToName,
			forwardedFrom: message.forwardedFrom,
			createdAt: message.createdAt,
		};

		return res.status(201).json(safe);
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

		// Encrypt new text and update encrypted fields
		const dek = generateDEK();
		const { ciphertext, iv, authTag } = encryptMessage(text.trim(), dek);
		const keyId = "v1";
		const wrappedDek = wrapDEK(dek, keyId);

		const updated = await prisma.message.update({
			where: { id: messageId },
			data: {
				// clear legacy plaintext
				text: null,
				ciphertext,
				iv,
				auth_tag: authTag,
				wrapped_dek: wrappedDek,
				key_id: keyId,
				isEdited: true,
			},
		});

		// do not return wrapped keys/ciphertext to the client
		const safe = {
			id: updated.id,
			conversationId: updated.conversationId,
			senderId: updated.senderId,
			isEdited: updated.isEdited,
			isPinned: updated.isPinned,
			isDeleted: updated.isDeleted,
			createdAt: updated.createdAt,
		};

		return res.json(safe);
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