// Turning stored (encrypted) messages into what a given user may see.
// Used by every route and socket handler that returns messages, so the
// decryption and time-capsule rules live in one place.
import prisma from "../prisma.js";
import { unwrapDEK, decryptMessage } from "./encryption.js";

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
			console.error("decrypt failed for message", m.id, e && e.message ? e.message : e);
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
	let parsed = null;
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
			console.error("failed to decrypt quoted text", msgId, e && e.message ? e.message : e);
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
		console.error("loadReplySenders failed", e && e.message ? e.message : e);
	}
	return map;
}

/** The message as `viewerId` may see it (never includes ciphertext or keys). */
export function serializeMessage(m, viewerId, { now = new Date(), replySenders = null } = {}) {
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
		isDeleted: !!m.isDeleted,
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
		reactions: Array.isArray(m.reactions) ? m.reactions : [],
		createdAt: m.createdAt,
	};
	if (m.sender) out.sender = m.sender;
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
		createdAt: m.createdAt,
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
