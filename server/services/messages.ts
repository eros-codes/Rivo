// Message actions, shared by the socket handlers and the REST routes.
// `actor` is { userId, socketId }: the device that acted gets its answer
// through the ack / HTTP response, every other device gets an event.
import type { Message } from "@prisma/client";
import prisma from "../prisma.ts";
import push from "../utils/push.ts";
import { config } from "../config.ts";
import { generateDEK, encryptMessage, sealText, wrapDEK } from "../utils/encryption.ts";
import type { DeleteMessagesData, EditMessageData, ForwardMessagesData, MarkSeenData, ReactData, SendMessageData } from "../../shared/schemas/messages.ts";
import { CAPSULE_MAX_DELAY_MS, CAPSULE_MIN_DELAY_MS } from "../../shared/limits.ts";
import { decryptAux, decryptBody, isCapsuleLocked, serializeMessage, type StoredMessage } from "../utils/messageView.ts";
import { blockState, getMembersCached, getRecipientsCached, isMember, invalidateConversation, type Recipient } from "./caches.ts";
import { deliverToConversation, emitToUser, hasVisibleSocket, isUserViewing } from "../realtime/registry.ts";
import { emitContactUpsert } from "./contacts.ts";
import { log } from "../utils/logger.ts";
import { iso } from "../utils/wire.ts";
import type { Deleted, Edited, Forwarded, Pinned, Reacted, Seen } from "../../shared/api.ts";
import { codeOf, messageOf } from "../utils/errors.ts";

/** Who acts: the user, and the device when it came over the socket (it gets the answer, not the event). */
export interface Actor {
	userId: number;
	socketId?: string | null;
}
/** An action that was refused or failed: what to tell the user. */
export interface Fail {
	error: string;
}
/** What an action answers: done (and what it did), or why not. The socket
 * acks and the REST answers of shared/ are checked against these. */
export type Result<T = object> = Fail | ({ success: true } & T);
/** A message as one user sees it. */
export type MessageView = ReturnType<typeof serializeMessage>;

const ACTIVE_KEY_ID = process.env.ACTIVE_KEY_ID || "v1";
const MAX_LEN = config.messages.maxLength;

export const ERR = {
	invalid: "Invalid data",
	forbidden: "Forbidden",
	notFound: "Message not found",
	server: "Server error",
	gone: "This account no longer exists",
	blockedByMe: "Unblock this contact to send messages",
	blockedByOther: "Message could not be delivered",
};

/** HTTP status for an action's error. */
export function statusFor(result: Fail): number {
	const e = String(result?.error || "");
	if (!e) return 200;
	if (e === ERR.server) return 500;
	if (e === ERR.notFound || e === "Not found") return 404;
	if (e === ERR.forbidden || e === ERR.blockedByOther || e === ERR.blockedByMe) return 403;
	if (e === ERR.gone) return 410;
	if (e === "Rate limit exceeded") return 429;
	return 400;
}

// What a deleted message keeps: its place in the chat, never its content.
export const DELETED = {
	isDeleted: true,
	isPinned: false,
	ciphertext: null,
	iv: null,
	auth_tag: null,
	wrapped_dek: null,
	replyToText: null,
	forwardedText: null,
};

function cleanText(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_LEN) : null;
}

// Someone who removed the sender from their contacts gets the contact back
// when a new message arrives, so it does not disappear silently.
const _restoring = new Map<string, Promise<number | null>>();
function restoreContactRow(convId: number, ownerId: number, contactId: number): Promise<number | null> {
	const key = `${convId}:${ownerId}`;
	const pending = _restoring.get(key);
	if (pending) return pending;
	const p = (async () => {
		try {
			const existing = await prisma.contact.findFirst({ where: { ownerId, conversationId: convId }, select: { id: true } });
			if (existing) return null;
			// back in their list, but not as someone they chose (privacy)
			const row = await prisma.contact.create({ data: { ownerId, contactId, conversationId: convId, addedByOwner: false }, select: { id: true } });
			invalidateConversation(convId);
			return row.id;
		} catch (e) {
			// (P2002: they have this person in their list already, on another chat)
			if (codeOf(e) === "P2002") log.warn("contact row not restored: the owner already has one for this person", { convId, ownerId });
			else log.error("restoring a contact row failed", e);
			return null;
		} finally {
			_restoring.delete(key);
		}
	})();
	_restoring.set(key, p);
	return p;
}

/** The error for acting in a chat where either person has blocked the other, or null. */
async function blockedError(convId: number, userId: number): Promise<string | null> {
	const { blockedByMe, blockedByOther } = blockState(await getRecipientsCached(convId), userId);
	if (blockedByMe) return ERR.blockedByMe;
	if (blockedByOther) return ERR.blockedByOther;
	return null;
}

/** Truncates to whole minutes (capsules are scheduled with minute precision). */
const toMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60000) * 60000);

/** A send, already checked against SendMessage (shared/schemas/messages.ts). */
export type SendInput = SendMessageData;

/** A checked send: everything needed to store it. */
interface Prepared {
	convId: number;
	text: string;
	clientId: string | null;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	scheduledFor: Date | null;
	replyToId: number | null;
	replyToSenderId: number | null;
	replyToName: string | null;
	replyToText: string | null;
	forwardedFrom: string | null;
	forwardedText: string | null;
	isSelf: boolean;
	recipientRows: Recipient[];
}

/**
 * The rest of a send's checks (the ones that need the database or the
 * clock) and everything needed to store it, or { error }.
 */
async function prepareSend(actor: Actor, data: SendInput): Promise<Prepared | Fail> {
	const { conversationId: convId, forwardOf, isOneTime, isTimeCapsule, clientId, replyToId } = data;
	// (a forward's text and author come from the message it copies)
	let text = data.text;

	let scheduledFor: Date | null = null;
	if (isTimeCapsule && data.scheduledFor) {
		const at = toMinute(data.scheduledFor);
		const now = toMinute(new Date()).getTime();
		if (at.getTime() < now + CAPSULE_MIN_DELAY_MS || at.getTime() > now + CAPSULE_MAX_DELAY_MS) return { error: "scheduledFor out of range" };
		scheduledFor = at;
	}

	if (!(await isMember(convId, actor.userId))) return { error: ERR.forbidden };

	const members = await getMembersCached(convId);
	const others = members.filter((m) => m.userId !== actor.userId);
	const isSelf = others.length === 0;
	let recipientRows: Recipient[] = [];
	if (!isSelf) {
		if (others.some((m) => m.isDeleted)) return { error: ERR.gone };
		let rows = await getRecipientsCached(convId);
		const { blockedByMe, blockedByOther } = blockState(rows, actor.userId);
		if (blockedByMe) return { error: ERR.blockedByMe };
		if (blockedByOther) return { error: ERR.blockedByOther };
		const missing = others.filter((m) => !rows.some((r) => r.ownerId === m.userId));
		if (missing.length > 0) {
			const restored = await Promise.all(missing.map((m) => restoreContactRow(convId, m.userId, actor.userId)));
			rows = await getRecipientsCached(convId, true);
			// their list gets the chat back right away
			missing.forEach((m, i) => restored[i] && emitContactUpsert(m.userId, restored[i]));
		}
		recipientRows = rows.filter((r) => r.ownerId !== actor.userId);
		// writing to someone makes them one of this user's contacts (for the
		// "Contacts" privacy setting), even if they were only added by them
		const own = rows.find((r) => r.ownerId === actor.userId);
		if (own && own.addedByOwner === false) {
			await prisma.contact.update({ where: { id: own.id }, data: { addedByOwner: true } });
			invalidateConversation(convId);
		}
	}

	let forwardedFrom: string | null = null;
	if (forwardOf) {
		const src = await prisma.message.findUnique({ where: { id: forwardOf }, include: { sender: { select: { name: true } } } });
		// someone else's one-time message or sealed capsule is not theirs to pass on
		const unavailable =
			!src || src.isDeleted || (src.senderId !== actor.userId && (src.isOneTime || isCapsuleLocked(src))) || !(await isMember(src.conversationId, actor.userId));
		const body = unavailable ? null : decryptBody(src);
		if (!src || !body?.ok || !body.text.trim()) return { error: "This message can't be forwarded" };
		text = body.text.trim().slice(0, MAX_LEN);
		// a forward of a forward still names the original author
		forwardedFrom = (src.forwardedFrom || src.sender?.name || "Unknown").slice(0, 100);
	}

	// The quote is taken from the message itself, never from the client (a
	// made-up quote would show as something the other person said).
	let replyToSenderId: number | null = null;
	let replyToName: string | null = null;
	let replyToText: string | null = null;
	if (replyToId) {
		const target = await prisma.message.findUnique({ where: { id: replyToId }, include: { sender: { select: { name: true } } } });
		if (!target || target.conversationId !== convId) return { error: "Invalid replyToId" };
		replyToSenderId = target.senderId;
		replyToName = target.sender?.name?.slice(0, 100) || null;
		// nothing is quoted from a deleted message, a one-time message (it must
		// not outlive being read) or someone's still sealed time capsule
		const hidden = target.isDeleted || target.isOneTime || (isCapsuleLocked(target) && target.senderId !== actor.userId);
		if (!hidden) {
			const body = decryptBody(target);
			if (body.ok) replyToText = cleanText(body.text);
		}
	}

	return {
		convId,
		text,
		clientId,
		isOneTime,
		isTimeCapsule,
		scheduledFor,
		replyToId,
		replyToSenderId,
		replyToName,
		replyToText,
		forwardedFrom,
		forwardedText: forwardedFrom ? text : null,
		isSelf,
		recipientRows,
	};
}

function serializeFor(message: StoredMessage, viewerId: number, replyToSenderId: number | null): MessageView {
	const replySenders = message.replyToId ? new Map([[message.replyToId, replyToSenderId]]) : null;
	return serializeMessage(message, viewerId, { replySenders });
}

async function existingByClientId(senderId: number, clientId: string | null) {
	if (!clientId) return null;
	return prisma.message.findUnique({
		where: { senderId_clientId: { senderId, clientId } },
		include: { reactions: { select: { userId: true, emoji: true } } },
	});
}

/** Stores, delivers and notifies one message. */
/** What a send answers. */
export type SendResult = Fail | { success: true; duplicate?: true; message: MessageView };

async function storeAndDeliver(actor: Actor, p: Prepared): Promise<SendResult> {
	// a retry of a message that is already stored gets the stored one back
	const before = await existingByClientId(actor.userId, p.clientId);
	if (before) return { success: true, duplicate: true, message: serializeFor(before, actor.userId, p.replyToSenderId) };

	const dek = generateDEK();
	const body = encryptMessage(p.text, dek);
	let created: Message;
	try {
		created = await prisma.message.create({
			data: {
				conversationId: p.convId,
				senderId: actor.userId,
				ciphertext: body.ciphertext,
				iv: body.iv,
				auth_tag: body.authTag,
				wrapped_dek: wrapDEK(dek, ACTIVE_KEY_ID),
				key_id: ACTIVE_KEY_ID,
				clientId: p.clientId,
				isOneTime: p.isOneTime,
				isTimeCapsule: p.isTimeCapsule,
				scheduledFor: p.scheduledFor,
				replyToId: p.replyToId,
				replyToName: p.replyToName,
				replyToText: p.replyToText ? sealText(p.replyToText, dek) : null,
				forwardedFrom: p.forwardedFrom,
				forwardedText: p.forwardedText ? sealText(p.forwardedText, dek) : null,
			},
		});
	} catch (e) {
		if (codeOf(e) === "P2002" && p.clientId) {
			// the same message arrived twice at the same moment
			const existing = await existingByClientId(actor.userId, p.clientId);
			if (existing) return { success: true, duplicate: true, message: serializeFor(existing, actor.userId, p.replyToSenderId) };
		}
		throw e;
	}
	const message = Object.assign(created, { reactions: [] as { userId: number; emoji: string }[] });

	await prisma.conversation.update({ where: { id: p.convId }, data: { lastMessageAt: message.createdAt } });

	const own = serializeFor(message, actor.userId, p.replyToSenderId);

	if (!p.isSelf) {
		// unread counters of people who are not looking at the chat right now;
		// awaited, so a "seen" right after cannot be overtaken
		const unreadIds = p.recipientRows.filter((r) => !isUserViewing(r.ownerId, p.convId)).map((r) => r.id);
		if (unreadIds.length > 0) {
			await prisma.contact
				.updateMany({ where: { id: { in: unreadIds } }, data: { unreadCount: { increment: 1 } } })
				.catch((e: unknown) => log.error("unread update failed", messageOf(e) || e));
		}
	}

	await deliverToConversation(p.convId, "message:new", null, {
		exceptSocketId: actor.socketId ?? null,
		perUser: (uid) => {
			const view = uid === actor.userId ? own : serializeFor(message, uid, p.replyToSenderId);
			// (a message that was just stored is never deleted; the type cannot know)
			return view.isDeleted ? undefined : view;
		},
	});

	if (!p.isSelf) notifyRecipients(actor, p, message);
	return { success: true, message: own };
}

function notifyRecipients(actor: Actor, p: Prepared, message: Message): void {
	(async () => {
		const sender = await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
		const locked = isCapsuleLocked(message);
		const pushed = new Set<number>();
		for (const r of p.recipientRows) {
			const uid = r.ownerId;
			if (pushed.has(uid) || r.isMuted || hasVisibleSocket(uid)) continue;
			pushed.add(uid);
			push
				.sendNotificationToUser(uid, {
					title: r.nickname || sender?.name || "New message",
					body: locked ? "Sent you a time capsule 🔒" : p.isOneTime ? "Sent you a one-time message" : p.text.slice(0, 120),
					data: { conversationId: p.convId, url: `/chat/?conversationId=${p.convId}` },
					tag: `conversation-${p.convId}`,
				})
				.catch(() => {});
		}
	})().catch((e: unknown) => log.error("push notify failed", messageOf(e) || e));
}

export async function sendMessageAs(actor: Actor, data: SendInput): Promise<SendResult> {
	try {
		const p = await prepareSend(actor, data);
		if ("error" in p) return p;
		return await storeAndDeliver(actor, p);
	} catch (e) {
		log.error("send failed", e);
		return { error: ERR.server };
	}
}

/**
 * Several forwarded messages in one go (selection forward). Stops at the first
 * refusal that applies to the whole chat (blocked, deleted account).
 */
export async function forwardMessagesAs(
	actor: Actor,
	{ conversationId, items }: ForwardMessagesData,
): Promise<Result<Forwarded> | ({ success: true; error: string } & Forwarded)> {
	const messages: MessageView[] = [];
	const failed: { clientId: string | null; error: string }[] = [];
	for (const item of items) {
		const clientId = item.clientId ?? null;
		const result = await sendMessageAs(actor, {
			conversationId,
			forwardOf: item.forwardOf,
			clientId,
			text: "",
			isOneTime: false,
			isTimeCapsule: false,
			replyToId: null,
			scheduledFor: null,
		});
		if ("error" in result) {
			if ([ERR.forbidden, ERR.gone, ERR.blockedByMe, ERR.blockedByOther].includes(result.error)) {
				return messages.length ? { success: true, messages, failed: items.length - messages.length, error: result.error } : result;
			}
			failed.push({ clientId, error: result.error });
			continue;
		}
		messages.push(result.message);
	}
	return { success: true, messages, failed: failed.length, failures: failed };
}

export async function editMessageAs(actor: Actor, { messageId: msgId, text: plain }: EditMessageData): Promise<Result<Edited>> {
	try {
		const message = await prisma.message.findUnique({ where: { id: msgId } });
		if (!message || message.senderId !== actor.userId) return { error: ERR.forbidden };
		if (message.isDeleted) return { error: "Cannot edit a deleted message" };
		if (message.isTimeCapsule && !message.openedAt) return { error: "Cannot edit a sealed time capsule" };
		if (message.isOneTime) return { error: "One-time messages cannot be edited" };
		if (message.forwardedFrom) return { error: "Forwarded messages cannot be edited" };
		// an edit reaches the other person like a message does
		const blocked = await blockedError(message.conversationId, actor.userId);
		if (blocked) return { error: blocked };

		const dek = generateDEK();
		const body = encryptMessage(plain, dek);
		// quoted texts are sealed with the message key: they move to the new key
		const oldDek = message.replyToText || message.forwardedText ? decryptBody(message).dek : null;
		const reseal = (value: string | null): string | null => {
			if (!value) return value;
			const old = decryptAux(value, oldDek, message.id);
			return old === null || old === undefined ? null : sealText(old, dek);
		};
		const updated = await prisma.message.update({
			where: { id: msgId },
			data: {
				ciphertext: body.ciphertext,
				iv: body.iv,
				auth_tag: body.authTag,
				wrapped_dek: wrapDEK(dek, ACTIVE_KEY_ID),
				key_id: ACTIVE_KEY_ID,
				isEdited: true,
				replyToText: reseal(message.replyToText),
				forwardedText: reseal(message.forwardedText),
				updatedAt: new Date(),
			},
		});
		await deliverToConversation(
			message.conversationId,
			"message:edited",
			{ messageId: msgId, conversationId: message.conversationId, text: plain, isEdited: true, updatedAt: iso(updated.updatedAt) },
			{ exceptSocketId: actor.socketId ?? null },
		);
		return { success: true, text: plain, updatedAt: iso(updated.updatedAt) };
	} catch (e) {
		log.error("edit failed", e);
		return { error: ERR.server };
	}
}

/** Exact unread counters of every contact row of a conversation. */
export async function recomputeUnread(convId: number): Promise<void> {
	try {
		const rows = await prisma.contact.findMany({ where: { conversationId: convId }, select: { id: true, ownerId: true, unreadCount: true } });
		for (const r of rows) {
			const count = await prisma.message.count({
				where: { conversationId: convId, senderId: { not: r.ownerId }, isSeen: false, isDeleted: false },
			});
			if (count !== r.unreadCount) await prisma.contact.update({ where: { id: r.id }, data: { unreadCount: count } });
		}
	} catch (e) {
		log.error("recomputeUnread failed", convId, messageOf(e) || e);
	}
}

/** Deletes the sender's own messages (one or many, of one conversation each). */
export async function deleteMessagesAs(actor: Actor, { messageIds: ids }: DeleteMessagesData): Promise<Result<Deleted>> {
	try {
		const rows = await prisma.message.findMany({ where: { id: { in: ids } } });
		if (rows.length !== ids.length || rows.some((m) => m.senderId !== actor.userId)) return { error: ERR.forbidden };
		const live = rows.filter((m) => !m.isDeleted);
		if (live.length === 0) return { success: true, deleted: ids };
		const now = new Date();
		// a deleted message keeps no content
		await prisma.message.updateMany({ where: { id: { in: live.map((m) => m.id) } }, data: { ...DELETED, updatedAt: now } });

		const byConv = new Map<number, Message[]>();
		for (const m of live) {
			const list = byConv.get(m.conversationId) || [];
			list.push(m);
			byConv.set(m.conversationId, list);
		}
		for (const [convId, list] of byConv) {
			// an unseen message was counted as unread for the other side
			if (list.some((m) => !m.isSeen)) await recomputeUnread(convId);
			for (const m of list) {
				await deliverToConversation(
					convId,
					"message:deleted",
					{ messageId: m.id, conversationId: convId, senderId: m.senderId, isSeen: !!m.isSeen, updatedAt: iso(now) },
					{ exceptSocketId: actor.socketId ?? null },
				);
			}
		}
		return { success: true, deleted: ids };
	} catch (e) {
		log.error("delete failed", e);
		return { error: ERR.server };
	}
}

export async function togglePinAs(actor: Actor, { messageId: msgId }: { messageId: number }): Promise<Result<Pinned>> {
	try {
		const message = await prisma.message.findUnique({ where: { id: msgId } });
		if (!message || message.isDeleted) return { error: "Not found" };
		if (!(await isMember(message.conversationId, actor.userId))) return { error: ERR.forbidden };
		// someone else's sealed capsule cannot be pinned (its text is hidden)
		if (isCapsuleLocked(message) && message.senderId !== actor.userId) return { error: ERR.forbidden };
		const blocked = await blockedError(message.conversationId, actor.userId);
		if (blocked) return { error: blocked };
		if (!message.isPinned) {
			const pinned = await prisma.message.count({ where: { conversationId: message.conversationId, isPinned: true, isDeleted: false } });
			if (pinned >= config.messages.pinLimit) return { error: `Pin limit reached (${config.messages.pinLimit}). Unpin something first.` };
		}
		const updated = await prisma.message.update({ where: { id: msgId }, data: { isPinned: !message.isPinned, updatedAt: new Date() } });
		await deliverToConversation(
			message.conversationId,
			"message:pinned",
			{ messageId: msgId, conversationId: message.conversationId, isPinned: updated.isPinned, updatedAt: iso(updated.updatedAt) },
			{ exceptSocketId: actor.socketId ?? null },
		);
		return { success: true, isPinned: updated.isPinned };
	} catch (e) {
		log.error("pin failed", e);
		return { error: ERR.server };
	}
}

export async function reactAs(actor: Actor, { messageId: msgId, emoji }: ReactData): Promise<Result<Reacted>> {
	try {
		const message = await prisma.message.findUnique({
			where: { id: msgId },
			select: { id: true, conversationId: true, senderId: true, isDeleted: true, isTimeCapsule: true, openedAt: true, scheduledFor: true },
		});
		if (!message || message.isDeleted) return { error: ERR.notFound };
		if (!(await isMember(message.conversationId, actor.userId))) return { error: ERR.forbidden };
		const rows = await getRecipientsCached(message.conversationId);
		const { blockedByMe, blockedByOther } = blockState(rows, actor.userId);
		if (blockedByMe || blockedByOther) return { error: ERR.forbidden };

		const key = { messageId_userId: { messageId: msgId, userId: actor.userId } };
		const existing = await prisma.messageReaction.findUnique({ where: key });
		let action: Reacted["action"];
		if (existing && existing.emoji === emoji) {
			await prisma.messageReaction.delete({ where: key });
			action = "removed";
		} else {
			await prisma.messageReaction.upsert({ where: key, create: { messageId: msgId, userId: actor.userId, emoji }, update: { emoji } });
			action = existing ? "changed" : "added";
		}
		const updated = await prisma.message.update({ where: { id: msgId }, data: { updatedAt: new Date() }, select: { updatedAt: true } });
		const reactions = await prisma.messageReaction.findMany({
			where: { messageId: msgId },
			orderBy: { id: "asc" },
			select: { userId: true, emoji: true },
		});
		// everyone in the chat, the reacting user's own devices included
		await deliverToConversation(message.conversationId, "reaction:updated", {
			messageId: msgId,
			conversationId: message.conversationId,
			reactions,
			actorId: actor.userId,
			emoji,
			action,
			updatedAt: iso(updated.updatedAt),
		});

		// the author hears about it when the app is not open
		const authorId = message.senderId;
		const authorRow = rows.find((r) => r.ownerId === authorId);
		if (action !== "removed" && authorId !== actor.userId && !authorRow?.isMuted && !hasVisibleSocket(authorId)) {
			prisma.user
				.findUnique({ where: { id: actor.userId }, select: { name: true } })
				.then((u) =>
					push.sendNotificationToUser(authorId, {
						title: authorRow?.nickname || u?.name || "Someone",
						body: `Reacted ${emoji} to your message`,
						data: { conversationId: message.conversationId, url: `/chat/?conversationId=${message.conversationId}` },
						tag: `conversation-${message.conversationId}`,
					}),
				)
				.catch(() => {});
		}
		return { success: true, action, reactions };
	} catch (e) {
		log.error("reaction failed", e);
		return { error: ERR.server };
	}
}

/**
 * Marks the other person's messages as read, up to `upToId` (the newest
 * message this device has shown), and sets the reader's unread counter.
 */
export async function markSeenAs(actor: Actor, { conversationId: convId, upToId: limit }: MarkSeenData): Promise<Result<Seen>> {
	try {
		if (!(await isMember(convId, actor.userId))) return { error: ERR.forbidden };
		const where = {
			conversationId: convId,
			senderId: { not: actor.userId },
			isSeen: false,
			isDeleted: false,
			...(limit ? { id: { lte: limit } } : {}),
		};
		const marked: number[] = [];
		const BATCH = 1000;
		for (let i = 0; i < 50; i++) {
			const batch = await prisma.message.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: BATCH });
			if (batch.length === 0) break;
			const ids = batch.map((m) => m.id);
			const now = new Date();
			await prisma.message.updateMany({ where: { id: { in: ids } }, data: { isSeen: true, updatedAt: now } });
			// the sender's devices and the reader's other devices
			await deliverToConversation(convId, "message:seen", { conversationId: convId, messageIds: ids, seenBy: actor.userId }, { exceptSocketId: actor.socketId ?? null });
			marked.push(...ids);
			if (batch.length < BATCH) break;
		}
		const remaining = await prisma.message.count({
			where: { conversationId: convId, senderId: { not: actor.userId }, isSeen: false, isDeleted: false },
		});
		await prisma.contact.updateMany({ where: { conversationId: convId, ownerId: actor.userId }, data: { unreadCount: remaining } });
		return { success: true, marked, unreadCount: remaining };
	} catch (e) {
		log.error("seen failed", e);
		return { error: ERR.server };
	}
}

/**
 * One-time messages this user has seen are removed once they leave the chat
 * (closing it or disconnecting); both sides see them disappear.
 */
export async function cleanupSeenOneTime(userId: number, convId: number): Promise<void> {
	try {
		const seen = await prisma.message.findMany({
			where: { conversationId: convId, isOneTime: true, isSeen: true, isDeleted: false, senderId: { not: userId } },
			select: { id: true },
		});
		if (seen.length === 0) return;
		const ids = seen.map((m) => m.id);
		await prisma.message.updateMany({ where: { id: { in: ids } }, data: { ...DELETED, updatedAt: new Date() } });
		await deliverToConversation(convId, "message:onetime-deleted", { conversationId: convId, messageIds: ids });
	} catch (e) {
		log.error("one-time cleanup failed", messageOf(e) || e);
	}
}

/** Clears a whole conversation for both people. */
export async function clearConversation(userId: number, convId: number, { upToId = null }: { upToId?: number | null } = {}): Promise<Result<{ upToId: number | null }>> {
	// someone who was blocked cannot wipe the other person's copy of the chat
	const others = (await getRecipientsCached(convId)).filter((r) => r.ownerId !== userId);
	if (others.some((r) => r.isBlocked)) return { error: ERR.forbidden };
	const where = { conversationId: convId, isDeleted: false, ...(upToId ? { id: { lte: upToId } } : {}) };
	// (one statement however long the chat is: no list of ids)
	const newest = await prisma.message.findFirst({ where, orderBy: { id: "desc" }, select: { id: true } });
	if (!newest) return { success: true, upToId: null };
	await prisma.message.updateMany({ where: { ...where, id: { lte: newest.id } }, data: { ...DELETED, updatedAt: new Date() } });
	// newer messages (if any) stay, and so do their unread counts
	await recomputeUnread(convId);
	await deliverToConversation(convId, "messages:bulk-deleted", { conversationId: convId, upToId: newest.id });
	return { success: true, upToId: newest.id };
}

export { emitToUser };
