// Message actions, shared by the socket handlers and the REST routes.
// `actor` is { userId, socketId }: the device that acted gets its answer
// through the ack / HTTP response, every other device gets an event.
import prisma from "../prisma.js";
import push from "../utils/push.js";
import { config } from "../config.js";
import { generateDEK, encryptMessage, wrapDEK } from "../utils/encryption.js";
import { parseId } from "../utils/validators.js";
import { decryptAux, decryptBody, isCapsuleLocked, serializeMessage } from "../utils/messageView.js";
import { blockState, getMembersCached, getRecipientsCached, isMember, invalidateConversation } from "./caches.js";
import { deliverToConversation, emitToUser, hasVisibleSocket, isUserViewing } from "../realtime/registry.js";
import { emitContactUpsert } from "./contacts.js";
import { log } from "../utils/logger.js";

const ACTIVE_KEY_ID = process.env.ACTIVE_KEY_ID || "v1";
const MAX_LEN = config.messages.maxLength;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
export function statusFor(result) {
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
	text: null,
	ciphertext: null,
	iv: null,
	auth_tag: null,
	wrapped_dek: null,
	replyToText: null,
	forwardedText: null,
};

function sealed(plain, dek) {
	const r = encryptMessage(plain, dek);
	return JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
}

function cleanText(v) {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_LEN) : null;
}

// Someone who removed the sender from their contacts gets the contact back
// when a new message arrives, so it does not disappear silently.
const _restoring = new Map();
function restoreContactRow(convId, ownerId, contactId) {
	const key = `${convId}:${ownerId}`;
	if (_restoring.has(key)) return _restoring.get(key);
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
			if (e?.code === "P2002") log.warn("contact row not restored: the owner already has one for this person", { convId, ownerId });
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
async function blockedError(convId, userId) {
	const { blockedByMe, blockedByOther } = blockState(await getRecipientsCached(convId), userId);
	if (blockedByMe) return ERR.blockedByMe;
	if (blockedByOther) return ERR.blockedByOther;
	return null;
}

/** Truncates to whole minutes (capsules are scheduled with minute precision). */
const toMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000);

/**
 * Validates a send and returns everything needed to store it, or { error }.
 */
async function prepareSend(actor, data) {
	const convId = parseId(data.conversationId);
	if (!convId) return { error: "Invalid conversationId" };
	// a forward names the message it copies; its text and author come from there
	const forwardOf = data.forwardOf === undefined || data.forwardOf === null ? null : parseId(data.forwardOf);
	if (data.forwardOf !== undefined && data.forwardOf !== null && !forwardOf) return { error: "Invalid forwardOf" };
	let text = typeof data.text === "string" ? data.text.trim() : "";
	if (!forwardOf && (!text || text.length > MAX_LEN)) return { error: ERR.invalid };
	const isOneTime = data.isOneTime === true;
	const isTimeCapsule = data.isTimeCapsule === true;
	if (isOneTime && isTimeCapsule) return { error: ERR.invalid };
	if (forwardOf && (isOneTime || isTimeCapsule)) return { error: ERR.invalid };
	const clientId = data.clientId ?? data.clientMessageId ?? null;
	if (clientId !== null && (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId))) return { error: "Invalid clientId" };

	let replyToId = null;
	if (data.replyToId !== undefined && data.replyToId !== null && data.replyToId !== "") {
		replyToId = parseId(data.replyToId);
		if (!replyToId) return { error: "Invalid replyToId" };
	}

	let scheduledFor = null;
	if (isTimeCapsule) {
		if (!data.scheduledFor) return { error: "scheduledFor required" };
		const raw = new Date(data.scheduledFor);
		if (Number.isNaN(raw.getTime())) return { error: "scheduledFor invalid" };
		const at = toMinute(raw);
		const now = toMinute(new Date());
		if (at < new Date(now.getTime() + 5 * 60_000) || at > new Date(now.getTime() + 365 * 24 * 60 * 60_000)) {
			return { error: "scheduledFor out of range" };
		}
		scheduledFor = at;
	}

	if (!(await isMember(convId, actor.userId))) return { error: ERR.forbidden };

	const members = await getMembersCached(convId);
	const others = members.filter((m) => m.userId !== actor.userId);
	const isSelf = others.length === 0;
	let recipientRows = [];
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

	let forwardedFrom = null;
	if (forwardOf) {
		const src = await prisma.message.findUnique({ where: { id: forwardOf }, include: { sender: { select: { name: true } } } });
		// someone else's one-time message or sealed capsule is not theirs to pass on
		const unavailable =
			!src || src.isDeleted || (src.senderId !== actor.userId && (src.isOneTime || isCapsuleLocked(src))) || !(await isMember(src.conversationId, actor.userId));
		const body = unavailable ? null : decryptBody(src);
		if (!body?.ok || !body.text.trim()) return { error: "This message can't be forwarded" };
		text = body.text.trim().slice(0, MAX_LEN);
		// a forward of a forward still names the original author ("You" in
		// older rows meant the one who sent that row)
		forwardedFrom = (src.forwardedFrom && src.forwardedFrom !== "You" ? src.forwardedFrom : src.sender?.name || "Unknown").slice(0, 100);
	}

	// The quote is taken from the message itself, never from the client (a
	// made-up quote would show as something the other person said).
	let replyToSenderId = null;
	let replyToName = null;
	let replyToText = null;
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

function serializeFor(message, viewerId, replyToSenderId) {
	const replySenders = message.replyToId ? new Map([[message.replyToId, replyToSenderId]]) : null;
	return serializeMessage(message, viewerId, { replySenders });
}

async function existingByClientId(senderId, clientId) {
	if (!clientId) return null;
	return prisma.message.findUnique({
		where: { senderId_clientId: { senderId, clientId } },
		include: { reactions: { select: { userId: true, emoji: true } } },
	});
}

/** Stores, delivers and notifies one message. */
async function storeAndDeliver(actor, p) {
	// a retry of a message that is already stored gets the stored one back
	const before = await existingByClientId(actor.userId, p.clientId);
	if (before) return { success: true, duplicate: true, message: serializeFor(before, actor.userId, p.replyToSenderId) };

	const dek = generateDEK();
	const body = encryptMessage(p.text, dek);
	let message;
	try {
		message = await prisma.message.create({
			data: {
				conversationId: p.convId,
				senderId: actor.userId,
				text: null,
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
				replyToText: p.replyToText ? sealed(p.replyToText, dek) : null,
				forwardedFrom: p.forwardedFrom,
				forwardedText: p.forwardedText ? sealed(p.forwardedText, dek) : null,
			},
		});
	} catch (e) {
		if (e?.code === "P2002" && p.clientId) {
			// the same message arrived twice at the same moment
			const existing = await existingByClientId(actor.userId, p.clientId);
			if (existing) return { success: true, duplicate: true, message: serializeFor(existing, actor.userId, p.replyToSenderId) };
		}
		throw e;
	}
	message.reactions = [];

	await prisma.conversation.update({ where: { id: p.convId }, data: { lastMessageAt: message.createdAt } });

	const own = serializeFor(message, actor.userId, p.replyToSenderId);

	if (!p.isSelf) {
		// unread counters of people who are not looking at the chat right now;
		// awaited, so a "seen" right after cannot be overtaken
		const unreadIds = p.recipientRows.filter((r) => !isUserViewing(r.ownerId, p.convId)).map((r) => r.id);
		if (unreadIds.length > 0) {
			await prisma.contact
				.updateMany({ where: { id: { in: unreadIds } }, data: { unreadCount: { increment: 1 } } })
				.catch((e) => log.error("unread update failed", e?.message || e));
		}
	}

	await deliverToConversation(p.convId, "message:new", null, {
		exceptSocketId: actor.socketId,
		perUser: (uid) => (uid === actor.userId ? own : serializeFor(message, uid, p.replyToSenderId)),
	});

	if (!p.isSelf) notifyRecipients(actor, p, message);
	return { success: true, message: own };
}

function notifyRecipients(actor, p, message) {
	(async () => {
		const sender = await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
		const locked = isCapsuleLocked(message);
		const pushed = new Set();
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
	})().catch((e) => log.error("push notify failed", e?.message || e));
}

export async function sendMessageAs(actor, data = {}) {
	try {
		const p = await prepareSend(actor, data);
		if (p.error) return p;
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
export async function forwardMessagesAs(actor, { conversationId, items } = {}) {
	if (!Array.isArray(items) || items.length === 0 || items.length > config.messages.batchMax) return { error: ERR.invalid };
	const messages = [];
	const failed = [];
	for (const item of items) {
		const result = await sendMessageAs(actor, { conversationId, forwardOf: item?.forwardOf ?? null, clientId: item?.clientId });
		if (result.error) {
			if ([ERR.forbidden, ERR.gone, ERR.blockedByMe, ERR.blockedByOther, "Invalid conversationId"].includes(result.error)) {
				return messages.length ? { success: true, messages, failed: items.length - messages.length, error: result.error } : result;
			}
			failed.push({ clientId: item?.clientId ?? null, error: result.error });
			continue;
		}
		messages.push(result.message);
	}
	return { success: true, messages, failed: failed.length, failures: failed };
}

export async function editMessageAs(actor, { messageId, text } = {}) {
	const msgId = parseId(messageId);
	if (!msgId) return { error: "Invalid messageId" };
	const plain = typeof text === "string" ? text.trim() : "";
	if (!plain || plain.length > MAX_LEN) return { error: ERR.invalid };
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
		const reseal = (value) => {
			if (!value) return value;
			const old = decryptAux(value, oldDek, message.id);
			return old === null || old === undefined ? null : sealed(old, dek);
		};
		const updated = await prisma.message.update({
			where: { id: msgId },
			data: {
				text: null,
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
			{ messageId: msgId, conversationId: message.conversationId, text: plain, isEdited: true, updatedAt: updated.updatedAt },
			{ exceptSocketId: actor.socketId },
		);
		return { success: true, text: plain, updatedAt: updated.updatedAt };
	} catch (e) {
		log.error("edit failed", e);
		return { error: ERR.server };
	}
}

/** Exact unread counters of every contact row of a conversation. */
export async function recomputeUnread(convId) {
	try {
		const rows = await prisma.contact.findMany({ where: { conversationId: convId }, select: { id: true, ownerId: true, unreadCount: true } });
		for (const r of rows) {
			const count = await prisma.message.count({
				where: { conversationId: convId, senderId: { not: r.ownerId }, isSeen: false, isDeleted: false },
			});
			if (count !== r.unreadCount) await prisma.contact.update({ where: { id: r.id }, data: { unreadCount: count } });
		}
	} catch (e) {
		log.error("recomputeUnread failed", convId, e?.message || e);
	}
}

/** Deletes the sender's own messages (one or many, of one conversation each). */
export async function deleteMessagesAs(actor, { messageIds } = {}) {
	const ids = Array.isArray(messageIds) ? [...new Set(messageIds.map(parseId).filter(Boolean))] : [];
	if (ids.length === 0 || ids.length > config.messages.batchMax) return { error: ERR.invalid };
	try {
		const rows = await prisma.message.findMany({ where: { id: { in: ids } } });
		if (rows.length !== ids.length || rows.some((m) => m.senderId !== actor.userId)) return { error: ERR.forbidden };
		const live = rows.filter((m) => !m.isDeleted);
		if (live.length === 0) return { success: true, deleted: ids };
		const now = new Date();
		// a deleted message keeps no content
		await prisma.message.updateMany({ where: { id: { in: live.map((m) => m.id) } }, data: { ...DELETED, updatedAt: now } });

		const byConv = new Map();
		for (const m of live) {
			if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
			byConv.get(m.conversationId).push(m);
		}
		for (const [convId, list] of byConv) {
			// an unseen message was counted as unread for the other side
			if (list.some((m) => !m.isSeen)) await recomputeUnread(convId);
			for (const m of list) {
				await deliverToConversation(
					convId,
					"message:deleted",
					{ messageId: m.id, conversationId: convId, senderId: m.senderId, isSeen: !!m.isSeen, updatedAt: now },
					{ exceptSocketId: actor.socketId },
				);
			}
		}
		return { success: true, deleted: ids };
	} catch (e) {
		log.error("delete failed", e);
		return { error: ERR.server };
	}
}

export function deleteMessageAs(actor, { messageId } = {}) {
	return deleteMessagesAs(actor, { messageIds: [messageId] });
}

export async function togglePinAs(actor, { messageId } = {}) {
	const msgId = parseId(messageId);
	if (!msgId) return { error: "Invalid messageId" };
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
			{ messageId: msgId, conversationId: message.conversationId, isPinned: updated.isPinned, updatedAt: updated.updatedAt },
			{ exceptSocketId: actor.socketId },
		);
		return { success: true, isPinned: updated.isPinned };
	} catch (e) {
		log.error("pin failed", e);
		return { error: ERR.server };
	}
}

export async function reactAs(actor, { messageId, emoji } = {}) {
	const msgId = parseId(messageId);
	if (!msgId || typeof emoji !== "string" || !emoji || emoji.length > 16 || /\s/.test(emoji)) return { error: ERR.invalid };
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
		let action;
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
			updatedAt: updated.updatedAt,
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
export async function markSeenAs(actor, { conversationId, upToId } = {}) {
	const convId = parseId(conversationId);
	if (!convId) return { success: true, marked: [] };
	const limit = upToId === undefined || upToId === null ? null : parseId(upToId);
	if (upToId !== undefined && upToId !== null && !limit) return { error: ERR.invalid };
	try {
		if (!(await isMember(convId, actor.userId))) return { error: ERR.forbidden };
		const where = {
			conversationId: convId,
			senderId: { not: actor.userId },
			isSeen: false,
			isDeleted: false,
			...(limit ? { id: { lte: limit } } : {}),
		};
		const marked = [];
		const BATCH = 1000;
		for (let i = 0; i < 50; i++) {
			const batch = await prisma.message.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: BATCH });
			if (batch.length === 0) break;
			const ids = batch.map((m) => m.id);
			const now = new Date();
			await prisma.message.updateMany({ where: { id: { in: ids } }, data: { isSeen: true, updatedAt: now } });
			// the sender's devices and the reader's other devices
			await deliverToConversation(convId, "message:seen", { conversationId: convId, messageIds: ids, seenBy: actor.userId }, { exceptSocketId: actor.socketId });
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
export async function cleanupSeenOneTime(userId, convId) {
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
		log.error("one-time cleanup failed", e?.message || e);
	}
}

/** Clears a whole conversation for both people. */
export async function clearConversation(userId, convId, { upToId = null } = {}) {
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
