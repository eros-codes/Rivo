// Turning stored (encrypted) messages into what a given user may see.
// Used by every route and socket handler that returns messages, so the
// decryption and time-capsule rules live in one place.
import type { Message } from "@prisma/client";
import prisma from "../prisma.ts";
import { unwrapDEK, decryptMessage } from "./encryption.ts";
import { log } from "./logger.ts";
import { messageOf } from "./errors.ts";

/** A stored message, with its reactions when they were loaded. */
export type StoredMessage = Message & { reactions?: { userId: number; emoji: string }[] };
type CapsuleFields = Pick<Message, "isTimeCapsule" | "openedAt" | "scheduledFor">;
type BodyFields = Pick<Message, "id" | "text" | "ciphertext" | "iv" | "auth_tag" | "wrapped_dek" | "key_id">;
/** The decrypted body; `dek` decrypts the message's quote and forwarded text. */
export interface Body {
	text: string;
	dek: Buffer | null;
	ok: boolean;
}

const UNAVAILABLE = "Message unavailable";

function toIso(d: Date | string | null | undefined): string | null {
	if (!d) return null;
	const date = d instanceof Date ? d : new Date(d);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A time capsule is locked until it is opened or its time has passed. */
export function isCapsuleLocked(m: CapsuleFields | null | undefined, now = new Date()): boolean {
	return !!(m && m.isTimeCapsule && !m.openedAt && m.scheduledFor && new Date(m.scheduledFor) > now);
}

/**
 * Decrypts the message body.
 * @returns {{ text: string, dek: Buffer|null, ok: boolean }}
 */
export function decryptBody(m: BodyFields | null | undefined): Body {
	if (m && m.ciphertext && m.wrapped_dek) {
		try {
			const dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
			// (a row without iv / tag fails here, like any other damaged row)
			return { text: decryptMessage(m.ciphertext, m.iv ?? "", m.auth_tag ?? "", dek), dek, ok: true };
		} catch (e) {
			log.error("decrypt failed for message", m.id, messageOf(e) || e);
			return { text: UNAVAILABLE, dek: null, ok: false };
		}
	}
	// legacy rows stored plaintext
	if (m && typeof m.text === "string" && m.text) return { text: m.text, dek: null, ok: true };
	return { text: UNAVAILABLE, dek: null, ok: false };
}

/** replyToText / forwardedText: encrypted JSON {c, iv, t} or legacy plaintext. */
export function decryptAux(value: string | null | undefined, dek: Buffer | null, msgId: number): string | null {
	if (!value) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return value;
	}
	const p = parsed as { c?: unknown; iv?: unknown; t?: unknown } | null;
	if (p && typeof p === "object" && p.c && p.iv && p.t) {
		if (!dek) return UNAVAILABLE;
		try {
			return decryptMessage(String(p.c), String(p.iv), String(p.t), dek);
		} catch (e) {
			log.error("failed to decrypt quoted text", msgId, messageOf(e) || e);
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

/** A live message as one user sees it. */
export interface MessageViewFields {
	id: number;
	conversationId: number;
	senderId: number;
	text: string | null;
	isSeen: boolean;
	isEdited: boolean;
	isPinned: boolean;
	isDeleted: false;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	scheduledFor: string | null;
	openedAt: string | null;
	isLocked: boolean;
	replyToId: number | null;
	replyToName: string | null;
	replyToSenderId: number | null;
	replyToText: string | null;
	forwardedText: string | null;
	forwardedFrom: string | null;
	reactions: { userId: number; emoji: string }[];
	createdAt: string | null;
	updatedAt: string | null;
}

/** The message as `viewerId` may see it (never includes ciphertext or keys). */
export interface SerializeOptions {
	now?: Date;
	/** replyToId → who wrote the message replied to (loadReplySenders) */
	replySenders?: ReadonlyMap<number, number | null> | null;
}

export function serializeMessage(m: StoredMessage, viewerId: number | null, { now = new Date(), replySenders = null }: SerializeOptions = {}) {
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
	const out: MessageViewFields & { clientId?: string } = {
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
export function tombstone(m: Pick<Message, "id" | "conversationId" | "senderId" | "createdAt" | "updatedAt" | "clientId">, viewerId: number | null = null) {
	const out: { id: number; conversationId: number; senderId: number; isDeleted: true; createdAt: string | null; updatedAt: string | null; clientId?: string } = {
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
export function previewMessage(m: Message, viewerId: number, now = new Date()) {
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
