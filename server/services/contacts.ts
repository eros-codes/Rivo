// Contact rows as their owner sees them (privacy applied, latest message
// preview), used by the contacts routes and by the live `contact:upsert` event.
import type { Prisma } from "@prisma/client";
import prisma from "../prisma.ts";
import { applyPrivacy, relationsFor } from "../utils/privacy.ts";
import { previewMessage } from "../utils/messageView.ts";
import { emitToUser } from "../realtime/registry.ts";
import { log } from "../utils/logger.ts";
import { messageOf } from "../utils/errors.ts";
import { iso, isoOrNull } from "../utils/wire.ts";
import type { ContactRow, MessagePreview, Person } from "../../shared/api.ts";

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
} satisfies Prisma.UserSelect;

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
} satisfies Prisma.ContactInclude;

/** A contact row as loaded with CONTACT_INCLUDE. */
export type ContactRecord = Prisma.ContactGetPayload<{ include: typeof CONTACT_INCLUDE }>;

// Saved Messages first, then pinned, then the latest conversations. `id` last
// as a unique tie-breaker, so offset pages never skip or repeat a row.
export const CONTACT_ORDER = [
	{ isSaved: "desc" },
	{ isPinned: "desc" },
	{ pinOrder: "asc" },
	{ conversation: { lastMessageAt: "desc" } },
	{ id: "desc" },
] satisfies Prisma.ContactOrderByWithRelationInput[];

/** Rows (with CONTACT_INCLUDE) → what their owner may see. */
export async function serializeContacts(rows: ContactRecord[], viewerId: number): Promise<ContactRow[]> {
	const others = rows.map((r) => r.contact?.id).filter((id): id is number => Number.isInteger(id) && id !== viewerId);
	const rel = await relationsFor(viewerId, others);
	const now = new Date();
	return rows.map((r) => {
		const isSelf = r.contact?.id === viewerId;
		let contact: Person | null = null;
		if (r.contact) {
			const seen = applyPrivacy(r.contact, isSelf ? { hasViewer: true, blockedViewer: false } : rel.get(r.contact.id));
			contact = { ...seen, lastSeen: isoOrNull(seen.lastSeen) };
		}
		let lastMessage: MessagePreview | null = null;
		try {
			const m = r.conversation?.messages?.[0];
			if (m) lastMessage = previewMessage(m, viewerId, now);
		} catch (e) {
			log.error("contact preview failed", r.id, messageOf(e) || e);
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
						createdAt: iso(r.conversation.createdAt),
						lastMessageAt: isoOrNull(r.conversation.lastMessageAt),
						messages: lastMessage ? [lastMessage] : [],
					}
				: null,
		};
	});
}

/** A contact row as its owner sees it (what the API and `contact:upsert` send), or null when it is gone. */
export async function contactRowFor(ownerId: number, contactRowId: number): Promise<ContactRow | null> {
	const row = await prisma.contact.findFirst({ where: { id: contactRowId, ownerId }, include: CONTACT_INCLUDE });
	if (!row) return null;
	const [out] = await serializeContacts([row], ownerId);
	return out ?? null;
}

/** Tells the owner's devices about a new or changed contact row. */
export async function emitContactUpsert(ownerId: number, contactRowId: number, { exceptSocketId = null }: { exceptSocketId?: string | null } = {}): Promise<void> {
	try {
		const row = await contactRowFor(ownerId, contactRowId);
		if (row) emitToUser(ownerId, "contact:upsert", row, { exceptSocketId });
	} catch (e) {
		log.error("contact:upsert failed", messageOf(e) || e);
	}
}

/** Every user has a Saved Messages chat (accounts made before it existed get one). */
export async function ensureSavedContact(userId: number): Promise<boolean> {
	const count = await prisma.contact.count({ where: { ownerId: userId, isSaved: true } });
	if (count > 0) return false;
	await prisma.$transaction(async (tx) => {
		const conv = await tx.conversation.create({ data: { members: { create: [{ userId }] } } });
		await tx.contact.create({ data: { ownerId: userId, contactId: userId, conversationId: conv.id, isSaved: true } });
	});
	return true;
}
