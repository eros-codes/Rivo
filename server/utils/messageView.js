// Turning stored (encrypted) messages into what a given user may see.
// Used by every route and socket handler that returns messages, so the
// decryption and time-capsule rules live in one place.
import prisma from "../prisma.js";
import { unwrapDEK, decryptMessage } from "./encryption.js";
import { log } from "./logger.js";

const UNAVAILABLE = "Message unavailable";

function toIso(d) {
	if (!d) return null;
	const date = d instanceof Date ? d : new Date(d);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A time capsule is locked until it is opened or its time has passed. */
export function isCapsuleLocked(m, now = new Date()) {
	return !!(m && m.isTimeCapsule && !m.openedAt && m.scheduledFor && new Date(m.scheduledFor) > now);
}

/**
 * Decrypts the message body.
 * @returns {{ text: string, dek: Buffer|null, ok: boolean }}
 */
export function decryptBody(m) {
	if (m && m.ciphertext && m.wrapped_dek) {
		try {
			const dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
			return { text: decryptMessage(m.ciphertext, m.iv, m.auth_tag, dek), dek, ok: true };
		} catch (e) {
			log.error("decrypt failed for message", m.id, e && e.message ? e.message : e);
			return { text: UNAVAILABLE, dek: null, ok: false };
		}
	}
	// legacy rows stored plaintext
	if (m && typeof m.text === "string" && m.text) return { text: m.text, dek: null, ok: true };
	return { text: UNAVAILABLE, dek: null, ok: false };
}

/** replyToText / forwardedText: encrypted JSON {c, iv, t} or legacy plaintext. */
export function decryptAux(value, dek, msgId) {
	if (!value) return null;
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		return value;
	}
	if (parsed && typeof parsed === "object" && parsed.c && parsed.iv && parsed.t) {
		if (!dek) return UNAVAILABLE;
		try {
			return decryptMessage(parsed.c, parsed.iv, parsed.t, dek);
		} catch (e) {
			log.error("failed to decrypt quoted text", msgId, e && e.message ? e.message : e);
			return UNAVAILABLE;
		}
	}
	return value;
}

/**
 * Who wrote the messages that `msgs` reply to, so clients can label quotes
 * correctly ("You" or the contact) instead of trusting a stored name.
 * @returns {Promise<Map<number, number>>} replyToId -> senderId
 */
export async function loadReplySenders(msgs) {
	const ids = [...new Set((msgs || []).map((m) => m && m.replyToId).filter((id) => Number.isInteger(id)))];
	const map = new Map();
	if (ids.length === 0) return map;
	try {
		const rows = await prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true, senderId: true } });
		for (const r of rows) map.set(r.id, r.senderId);
	} catch (e) {
		log.error("loadReplySenders failed", e && e.message ? e.message : e);
	}
	return map;
}

/** The message as `viewerId` may see it (never includes ciphertext or keys). */
export function serializeMessage(m, viewerId, { now = new Date(), replySenders = null } = {}) {
	if (m.isDeleted) return tombstone(m, viewerId);
	const isSender = m.senderId === viewerId;
	const hidden = isCapsuleLocked(m, now) && !isSender;
	let text = null;
	let replyToText = null;
	let forwardedText = null;
	if (!hidden) {
		const body = decryptBody(m);
		text = body.text;
		replyToText = decryptAux(m.replyToText, body.dek, m.id);
		forwardedText = decryptAux(m.forwardedText, body.dek, m.id);
	}
	const out = {
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
		scheduledFor: toIso(m.scheduledFor),
		openedAt: toIso(m.openedAt),
		isLocked: hidden,
		replyToId: m.replyToId ?? null,
		replyToName: m.replyToName ?? null,
		replyToSenderId: m.replyToId != null && replySenders ? replySenders.get(m.replyToId) ?? null : null,
		replyToText,
		forwardedText,
		forwardedFrom: m.forwardedFrom ?? null,
		reactions: Array.isArray(m.reactions) ? m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })) : [],
		createdAt: toIso(m.createdAt),
		updatedAt: toIso(m.updatedAt || m.createdAt),
	};
	// the id the sending device gave it (lets that device match its pending copy)
	if (isSender && m.clientId) out.clientId = m.clientId;
	return out;
}

/**
 * What is left of a deleted message: enough for a client to remove it. The
 * sender also gets its clientId back: a device re-sending a message that was
 * deleted in the meantime can then let go of its pending copy.
 */
export function tombstone(m, viewerId = null) {
	const out = {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		isDeleted: true,
		createdAt: toIso(m.createdAt),
		updatedAt: toIso(m.updatedAt || m.createdAt),
	};
	if (viewerId !== null && m.senderId === viewerId && m.clientId) out.clientId = m.clientId;
	return out;
}

/**
 * Short form used for chat-list previews. Locked capsules and one-time
 * messages are never revealed to the recipient here.
 */
export function previewMessage(m, viewerId, now = new Date()) {
	const isSender = m.senderId === viewerId;
	const locked = isCapsuleLocked(m, now) && !isSender;
	const masked = locked || (!!m.isOneTime && !isSender);
	return {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		text: masked ? null : decryptBody(m).text,
		createdAt: toIso(m.createdAt),
		isDeleted: !!m.isDeleted,
		isEdited: !!m.isEdited,
		isPinned: !!m.isPinned,
		isSeen: !!m.isSeen,
		isOneTime: !!m.isOneTime,
		isTimeCapsule: !!m.isTimeCapsule,
		isLocked: locked,
		scheduledFor: toIso(m.scheduledFor),
		openedAt: toIso(m.openedAt),
	};
}
