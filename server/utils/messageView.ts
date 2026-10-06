// Turning stored (encrypted) messages into what a given user may see.
// Used by every route and socket handler that returns messages, so the
// decryption and time-capsule rules live in one place.
import prisma, { type Message } from "../prisma.ts";
import { unwrapDEK, decryptMessage, openText } from "./encryption.ts";
import { log } from "./logger.ts";
import { messageOf } from "./errors.ts";
import { iso, isoOrNull } from "./wire.ts";
import type { LiveMessage, MessagePreview, Tombstone } from "../../shared/api.ts";

/** A stored message, with its reactions when they were loaded. */
export type StoredMessage = Message & { reactions?: { userId: number; emoji: string }[] };
type CapsuleFields = Pick<Message, "isTimeCapsule" | "openedAt" | "scheduledFor">;
type BodyFields = Pick<Message, "id" | "ciphertext" | "iv" | "auth_tag" | "wrapped_dek" | "key_id">;
/** The decrypted body; `dek` decrypts the message's quote and forwarded text. */
export interface Body {
	text: string;
	dek: Buffer | null;
	ok: boolean;
}

const UNAVAILABLE = "Message unavailable";

/** A time capsule is locked until it is opened or its time has passed. */
export function isCapsuleLocked(m: CapsuleFields | null | undefined, now = new Date()): boolean {
	return !!(m && m.isTimeCapsule && !m.openedAt && m.scheduledFor && new Date(m.scheduledFor) > now);
}

/** Decrypts the message body ("Message unavailable" when it cannot be read, e.g. a deleted message). */
export function decryptBody(m: BodyFields | null | undefined): Body {
	if (!m || !m.ciphertext || !m.wrapped_dek) return { text: UNAVAILABLE, dek: null, ok: false };
	try {
		const dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
		// (a row without iv / tag fails here, like any other damaged row)
		return { text: decryptMessage(m.ciphertext, m.iv ?? "", m.auth_tag ?? "", dek), dek, ok: true };
	} catch (e) {
		log.error("decrypt failed for message", m.id, messageOf(e) || e);
		return { text: UNAVAILABLE, dek: null, ok: false };
	}
}

/** replyToText / forwardedText: sealed with the message's own key (sealText). */
export function decryptAux(value: string | null | undefined, dek: Buffer | null, msgId: number): string | null {
	if (!value) return null;
	if (!dek) return UNAVAILABLE;
	try {
		return openText(value, dek);
	} catch (e) {
		log.error("failed to decrypt quoted text", msgId, messageOf(e) || e);
		return UNAVAILABLE;
	}
}

/**
 * Who wrote the messages that `msgs` reply to, so clients can label quotes
 * correctly ("You" or the contact) instead of trusting a stored name.
 * @returns {Promise<Map<number, number>>} replyToId -> senderId
 */
export async function loadReplySenders(msgs: readonly (Pick<Message, "replyToId"> | null | undefined)[] | null | undefined): Promise<Map<number, number>> {
	const ids = [...new Set((msgs || []).map((m) => m && m.replyToId).filter((id): id is number => Number.isInteger(id)))];
	const map = new Map<number, number>();
	if (ids.length === 0) return map;
	try {
		const rows = await prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true, senderId: true } });
		for (const r of rows) map.set(r.id, r.senderId);
	} catch (e) {
		log.error("loadReplySenders failed", messageOf(e) || e);
	}
	return map;
}

/** The message as `viewerId` may see it (never includes ciphertext or keys). */
export interface SerializeOptions {
	now?: Date;
	/** replyToId → who wrote the message replied to (loadReplySenders) */
	replySenders?: ReadonlyMap<number, number | null> | null;
}

export function serializeMessage(m: StoredMessage, viewerId: number | null, { now = new Date(), replySenders = null }: SerializeOptions = {}): LiveMessage | Tombstone {
	if (m.isDeleted) return tombstone(m, viewerId);
	const isSender = m.senderId === viewerId;
	const hidden = isCapsuleLocked(m, now) && !isSender;
	let text: string | null = null;
	let replyToText: string | null = null;
	let forwardedText: string | null = null;
	if (!hidden) {
		const body = decryptBody(m);
		text = body.text;
		replyToText = decryptAux(m.replyToText, body.dek, m.id);
		forwardedText = decryptAux(m.forwardedText, body.dek, m.id);
	}
	const out: LiveMessage = {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		text,
		isSeen: !!m.isSeen,
		isEdited: !!m.isEdited,
		isPinned: !!m.isPinned,
		isDeleted: false,
		isOneTime: !!m.isOneTime,
		isTimeCapsule: !!m.isTimeCapsule,
		scheduledFor: isoOrNull(m.scheduledFor),
		openedAt: isoOrNull(m.openedAt),
		isLocked: hidden,
		replyToId: m.replyToId ?? null,
		replyToName: m.replyToName ?? null,
		replyToSenderId: m.replyToId != null && replySenders ? replySenders.get(m.replyToId) ?? null : null,
		replyToText,
		forwardedText,
		forwardedFrom: m.forwardedFrom ?? null,
		reactions: Array.isArray(m.reactions) ? m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })) : [],
		createdAt: iso(m.createdAt),
		updatedAt: iso(m.updatedAt || m.createdAt),
	};
	// the id the sending device gave it (lets that device match its pending copy)
	if (isSender && m.clientId) out.clientId = m.clientId;
	return out;
}

/** A message whose row could not be turned into a view: its place in the chat, without text. */
export function unavailableMessage(m: StoredMessage): LiveMessage {
	return {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		text: UNAVAILABLE,
		isSeen: !!m.isSeen,
		isEdited: false,
		isPinned: false,
		isDeleted: false,
		isOneTime: false,
		isTimeCapsule: false,
		scheduledFor: null,
		openedAt: null,
		isLocked: false,
		replyToId: null,
		replyToName: null,
		replyToSenderId: null,
		replyToText: null,
		forwardedText: null,
		forwardedFrom: null,
		reactions: [],
		createdAt: iso(m.createdAt),
		updatedAt: iso(m.updatedAt || m.createdAt),
	};
}

/**
 * What is left of a deleted message: enough for a client to remove it. The
 * sender also gets its clientId back: a device re-sending a message that was
 * deleted in the meantime can then let go of its pending copy.
 */
export function tombstone(m: Pick<Message, "id" | "conversationId" | "senderId" | "createdAt" | "updatedAt" | "clientId">, viewerId: number | null = null): Tombstone {
	const out: Tombstone = {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		isDeleted: true,
		createdAt: iso(m.createdAt),
		updatedAt: iso(m.updatedAt || m.createdAt),
	};
	if (viewerId !== null && m.senderId === viewerId && m.clientId) out.clientId = m.clientId;
	return out;
}

/**
 * Short form used for chat-list previews. Locked capsules and one-time
 * messages are never revealed to the recipient here.
 */
export function previewMessage(m: Message, viewerId: number, now = new Date()): MessagePreview {
	const isSender = m.senderId === viewerId;
	const locked = isCapsuleLocked(m, now) && !isSender;
	const masked = locked || (!!m.isOneTime && !isSender);
	return {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		text: masked ? null : decryptBody(m).text,
		createdAt: iso(m.createdAt),
		isDeleted: !!m.isDeleted,
		isEdited: !!m.isEdited,
		isPinned: !!m.isPinned,
		isSeen: !!m.isSeen,
		isOneTime: !!m.isOneTime,
		isTimeCapsule: !!m.isTimeCapsule,
		isLocked: locked,
		scheduledFor: isoOrNull(m.scheduledFor),
		openedAt: isoOrNull(m.openedAt),
	};
}
