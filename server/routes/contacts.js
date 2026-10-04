import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { parseIntSafe } from "../utils/validators.js";
import { applyPrivacy, relationsFor } from "../utils/privacy.js";
import { previewMessage } from "../utils/messageView.js";
import { findUserByUsername } from "../utils/userLookup.js";
import { emitToUser, invalidateConversationCache } from "../socket/index.js";

const router = Router();

const CONTACT_USER_SELECT = {
	id: true,
	name: true,
	username: true,
	bio: true,
	profilePics: true,
	isOnline: true,
	lastSeen: true,
	email: true,
	isDeleted: true,
	privacyOnline: true,
	privacyEmail: true,
	privacyProfile: true,
};

// What the owner of a contact row may see about that contact
async function sanitizeContactRows(rows, viewerId) {
	const others = rows.map((r) => r.contact && r.contact.id).filter((id) => Number.isInteger(id) && id !== viewerId);
	const rel = await relationsFor(viewerId, others);
	return rows.map((r) => {
		const out = { ...r };
		if (out.contact) {
			const isSelf = out.contact.id === viewerId;
			out.contact = isSelf ? applyPrivacy(out.contact, { hasViewer: true, blockedViewer: false }) : applyPrivacy(out.contact, rel.get(out.contact.id));
		}
		return out;
	});
}

// ─── Get all contacts ─────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		// pagination for contacts: prevent returning unbounded contact lists
		const MAX_FETCH_LIMIT = parseInt(process.env.MAX_FETCH_LIMIT || "100", 10);
		const DEFAULT_LIMIT = parseInt(process.env.CONTACTS_DEFAULT_LIMIT || "50", 10);
		let limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
		if (limit < 1) limit = 1;
		if (limit > MAX_FETCH_LIMIT) limit = MAX_FETCH_LIMIT;
		// Cursor-based paging on id is not compatible with this multi-column sort order,
		// so use offset-based pagination for stable contact pagination.
		const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

		const contacts = await prisma.contact.findMany({
			where: { ownerId: req.userId },
			take: limit,
			skip,
			include: {
				contact: { select: CONTACT_USER_SELECT },
				conversation: {
					include: {
						messages: {
							where: { isDeleted: false },
							orderBy: [{ createdAt: "desc" }, { id: "desc" }],
							take: 1,
						},
					},
				},
			},
			// `id` last: without a unique tie-breaker the order of rows with equal
			// keys can change between pages, so offset paging could skip or repeat
			// contacts.
			orderBy: [
				{ isSaved: "desc" },
				{ isPinned: "desc" },
				{ pinOrder: "asc" },
				{ conversation: { lastMessageAt: "desc" } },
				{ id: "desc" },
			],
		});

		const sanitized = await sanitizeContactRows(contacts, req.userId);

		// Readable preview of the latest message. Locked time capsules and
		// one-time messages are never revealed to the recipient here.
		const now = new Date();
		for (const cc of sanitized) {
			try {
				const conv = cc.conversation;
				if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) continue;
				conv.messages = [previewMessage(conv.messages[0], req.userId, now)];
			} catch (e) {
				// do not fail the entire request for one contact
				if (cc.conversation) cc.conversation.messages = [];
			}
		}

		// Auto-create saved messages for existing users, but check the full contact set
		// rather than only the current page so pagination cannot create duplicates.
		if (skip === 0) {
			const savedCount = await prisma.contact.count({ where: { ownerId: req.userId, isSaved: true } });
			if (savedCount === 0) {
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
									where: { isDeleted: false },
									take: 1,
									orderBy: [{ createdAt: "desc" }, { id: "desc" }],
								},
							},
						},
					},
				});
				if (refetched) {
					if (refetched.conversation) {
						refetched.conversation.messages = (refetched.conversation.messages || []).map((m) => previewMessage(m, req.userId, now));
					}
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
							isDeleted: false,
						},
						conversationId: refetched.conversationId,
						isSaved: true,
					});
				}
			}
		}

		return res.json(sanitized);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// One add at a time per pair of people (the server runs as one process)
const _pairLocks = new Map(); // "smallerId:largerId" => tail of the queue
async function _lockPair(a, b) {
	const key = a < b ? `${a}:${b}` : `${b}:${a}`;
	const prev = _pairLocks.get(key) || Promise.resolve();
	let release;
	const mine = new Promise((resolve) => (release = resolve));
	const tail = prev.then(() => mine);
	_pairLocks.set(key, tail);
	await prev;
	return () => {
		release();
		if (_pairLocks.get(key) === tail) _pairLocks.delete(key);
	};
}

// ─── Add contact ──────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
	const { username, name } = req.body || {};

	if (!username || typeof username !== "string" || !username.trim()) {
		return res.status(400).json({ error: "Username is required" });
	}

	if (name !== undefined && name !== null && typeof name !== "string") {
		return res.status(400).json({ error: "Name must be a string" });
	}
	const nickname = typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : null;

	try {
		const targetUser = await findUserByUsername(username);

		if (!targetUser || targetUser.isDeleted) {
			return res.status(404).json({ error: "User not found" });
		}

		if (targetUser.id === req.userId) {
			return res.status(400).json({ error: "You cannot add yourself" });
		}

		// Two adds between the same two people at the same moment (a double
		// tap, or both adding each other) must not create duplicate contacts
		const release = await _lockPair(req.userId, targetUser.id);
		try {
			const existing = await prisma.contact.findFirst({
				where: {
					ownerId: req.userId,
					contactId: targetUser.id,
					isSaved: false,
				},
			});

			if (existing) {
				return res.status(409).json({ error: "Contact already exists" });
			}

			const include = { contact: { select: CONTACT_USER_SELECT } };

			// If the target user already has us as a contact, reuse their
			// conversation and only create our side.
			const reciprocal = await prisma.contact.findFirst({
				where: {
					ownerId: targetUser.id,
					contactId: req.userId,
					isSaved: false,
				},
			});

			let contact;
			if (reciprocal) {
				contact = await prisma.contact.create({
					data: {
						ownerId: req.userId,
						contactId: targetUser.id,
						conversationId: reciprocal.conversationId,
						nickname,
					},
					include,
				});
			} else {
				// Both people may have removed each other earlier; reuse their
				// conversation so the history comes back instead of starting over.
				const shared = await prisma.conversation.findFirst({
					where: {
						AND: [
							{ members: { some: { userId: req.userId } } },
							{ members: { some: { userId: targetUser.id } } },
							{ members: { every: { userId: { in: [req.userId, targetUser.id] } } } },
						],
					},
					orderBy: { id: "desc" },
					select: { id: true },
				});

				// Create conversation and contacts inside a single transaction so
				// we don't leave an orphaned conversation if one of the contact
				// creations fails.
				contact = await prisma.$transaction(async (tx) => {
					const conversationId = shared
						? shared.id
						: (
								await tx.conversation.create({
									data: {
										members: {
											create: [{ userId: req.userId }, { userId: targetUser.id }],
										},
									},
								})
							).id;

					const c1 = await tx.contact.create({
						data: {
							ownerId: req.userId,
							contactId: targetUser.id,
							conversationId,
							nickname,
						},
						include,
					});

					await tx.contact.create({
						data: {
							ownerId: targetUser.id,
							contactId: req.userId,
							conversationId,
						},
					});

					return c1;
				});
			}

			invalidateConversationCache(contact.conversationId);
			const [safe] = await sanitizeContactRows([contact], req.userId);
			return res.status(201).json(safe);
		} finally {
			release();
		}
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Update contact (pin, mute, block, nickname) ──────────────────────────────
router.patch("/:id", requireAuth, async (req, res) => {
	const contactId = parseIntSafe(req.params.id);
	if (!contactId) return res.status(400).json({ error: "Invalid contact id" });
	// Prevent clients from setting server-controlled fields
	const { isPinned, pinOrder, isMuted, isBlocked, nickname, isArchived } = req.body || {};

	if (nickname !== undefined && nickname !== null && typeof nickname !== "string") {
		return res.status(400).json({ error: "nickname must be a string" });
	}
	// Sanitize nickname to avoid stored-DoS via large nicknames ("" clears it)
	const safeNickname = typeof nickname === 'string' && nickname.trim() ? nickname.trim().slice(0, 100) : null;

	for (const [key, value] of [
		['isPinned', isPinned],
		['isMuted', isMuted],
		['isBlocked', isBlocked],
		['isArchived', isArchived],
	]) {
		if (value !== undefined && typeof value !== 'boolean') {
			return res.status(400).json({ error: `${key} must be a boolean` });
		}
	}
	if (pinOrder !== undefined && pinOrder !== null && (!Number.isInteger(pinOrder) || pinOrder < 0 || pinOrder > 9999)) {
		return res.status(400).json({ error: 'pinOrder must be an integer between 0 and 9999' });
	}

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

		// mute/block decide who gets messages and notifications
		invalidateConversationCache(contact.conversationId);

		return res.json(updated);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete contact ───────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
	const contactId = parseIntSafe(req.params.id);
	if (!contactId) return res.status(400).json({ error: "Invalid contact id" });

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
		if (contact.isSaved) {
			return res.status(400).json({ error: "Saved Messages cannot be deleted" });
		}

		// Only remove this user's own contact record. The reciprocal record
		// belongs to the other user and should not be deleted unilaterally.
		await prisma.$transaction(async (tx) => {
			await tx.contact.delete({ where: { id: contactId } });

			// If the conversation no longer has contacts and never had a
			// message, remove it inside the same transaction.
			const remaining = await tx.contact.findFirst({ where: { conversationId: contact.conversationId } });
			if (!remaining && contact.conversationId) {
				const msgCount = await tx.message.count({ where: { conversationId: contact.conversationId } });
				if (msgCount === 0) {
					// members reference the conversation (ON DELETE RESTRICT), so
					// they have to go first
					await tx.conversationMember.deleteMany({ where: { conversationId: contact.conversationId } });
					await tx.conversation.delete({ where: { id: contact.conversationId } });
				}
			}
		});

		invalidateConversationCache(contact.conversationId);

		// Keep this user's other devices in sync. The other person keeps their
		// own contact (and the chat) unchanged, so they are not notified.
		emitToUser(req.userId, "contact:removed", {
			contactUserId: contact.contactId,
			contactRowId: contact.id,
			conversationId: contact.conversationId,
		});

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;
