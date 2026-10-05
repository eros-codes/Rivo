// Contact rows as their owner sees them (privacy applied, latest message
// preview), used by the contacts routes and by the live `contact:upsert` event.
import prisma from "../prisma.js";
import { applyPrivacy, relationsFor } from "../utils/privacy.js";
import { previewMessage } from "../utils/messageView.js";
import { emitToUser } from "../realtime/registry.js";
import { log } from "../utils/logger.js";

export const CONTACT_USER_SELECT = {
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

export const CONTACT_INCLUDE = {
	contact: { select: CONTACT_USER_SELECT },
	conversation: {
		select: {
			id: true,
			createdAt: true,
			lastMessageAt: true,
			messages: {
				where: { isDeleted: false },
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 1,
			},
		},
	},
};

// Saved Messages first, then pinned, then the latest conversations. `id` last
// as a unique tie-breaker, so offset pages never skip or repeat a row.
export const CONTACT_ORDER = [
	{ isSaved: "desc" },
	{ isPinned: "desc" },
	{ pinOrder: "asc" },
	{ conversation: { lastMessageAt: "desc" } },
	{ id: "desc" },
];

/** Rows (with CONTACT_INCLUDE) → what their owner may see. */
export async function serializeContacts(rows, viewerId) {
	const others = rows.map((r) => r.contact?.id).filter((id) => Number.isInteger(id) && id !== viewerId);
	const rel = await relationsFor(viewerId, others);
	const now = new Date();
	return rows.map((r) => {
		const isSelf = r.contact?.id === viewerId;
		const contact = r.contact
			? applyPrivacy(r.contact, isSelf ? { hasViewer: true, blockedViewer: false } : rel.get(r.contact.id))
			: null;
		let lastMessage = null;
		try {
			const m = r.conversation?.messages?.[0];
			if (m) lastMessage = previewMessage(m, viewerId, now);
		} catch (e) {
			log.error("contact preview failed", r.id, e?.message || e);
		}
		return {
			id: r.id,
			ownerId: r.ownerId,
			contactId: r.contactId,
			conversationId: r.conversationId,
			nickname: r.nickname,
			isPinned: r.isPinned,
			pinOrder: r.pinOrder,
			isMuted: r.isMuted,
			isBlocked: r.isBlocked,
			isArchived: r.isArchived,
			isSaved: r.isSaved,
			unreadCount: r.unreadCount,
			contact,
			lastMessage,
			// the shape older clients read
			conversation: r.conversation
				? {
						id: r.conversation.id,
						createdAt: r.conversation.createdAt,
						lastMessageAt: r.conversation.lastMessageAt,
						messages: lastMessage ? [lastMessage] : [],
					}
				: null,
		};
	});
}

export async function contactRowFor(ownerId, contactRowId) {
	const row = await prisma.contact.findFirst({ where: { id: contactRowId, ownerId }, include: CONTACT_INCLUDE });
	if (!row) return null;
	const [out] = await serializeContacts([row], ownerId);
	return out;
}

/** Tells the owner's devices about a new or changed contact row. */
export async function emitContactUpsert(ownerId, contactRowId, { exceptSocketId = null } = {}) {
	try {
		const row = await contactRowFor(ownerId, contactRowId);
		if (row) emitToUser(ownerId, "contact:upsert", row, { exceptSocketId });
	} catch (e) {
		log.error("contact:upsert failed", e?.message || e);
	}
}

/** Every user has a Saved Messages chat (accounts made before it existed get one). */
export async function ensureSavedContact(userId) {
	const count = await prisma.contact.count({ where: { ownerId: userId, isSaved: true } });
	if (count > 0) return false;
	await prisma.$transaction(async (tx) => {
		const conv = await tx.conversation.create({ data: { members: { create: [{ userId }] } } });
		await tx.contact.create({ data: { ownerId: userId, contactId: userId, conversationId: conv.id, isSaved: true } });
	});
	return true;
}
