import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import push from "../utils/push.js";
import { generateDEK, encryptMessage, wrapDEK } from "../utils/encryption.js";
import { parseIntSafe, MAX_MESSAGE_LENGTH } from "../utils/validators.js";
import { audienceOf, canSee } from "../utils/privacy.js";
import { isCapsuleLocked, decryptAux, decryptBody } from "../utils/messageView.js";

const ACTIVE_KEY_ID = process.env.ACTIVE_KEY_ID || "v1";

// Exported map of userId -> Set<socketId> so other modules (jobs, routes)
// can efficiently target sockets without iterating over all connections.
export const userSockets = new Map();
// Module-level reference to the Socket.IO server instance.
let ioInstance = null;

// ─── Caches (module level so HTTP routes can invalidate them) ────────────────
const membershipCache = new Map(); // `${convId}:${userId}` => { res, ts }
const MEMBERSHIP_CACHE_TTL_MS = parseInt(process.env.MEMBERSHIP_CACHE_TTL_MS || "30000", 10);
const MEMBERSHIP_CACHE_MAX = parseInt(process.env.MEMBERSHIP_CACHE_MAX || "10000", 10);
// Contact rows of a conversation: who has it in their list, muted, blocked…
const recipientsCache = new Map(); // convId => { data, ts }
const RECIPIENTS_CACHE_TTL_MS = parseInt(process.env.RECIPIENTS_CACHE_TTL_MS || "30000", 10);
const RECIPIENTS_CACHE_MAX = parseInt(process.env.RECIPIENTS_CACHE_MAX || "5000", 10);
// Members of a conversation (including people who removed the contact)
const membersCache = new Map(); // convId => { data, ts }

function _cacheSet(map, key, value, max) {
	try {
		if (map.size >= max) {
			const oldest = map.keys().next().value;
			if (oldest !== undefined) map.delete(oldest);
		}
	} catch (e) {
		/* ignore eviction errors */
	}
	map.set(key, value);
}

async function isMemberCached(convId, userId) {
	const key = `${convId}:${userId}`;
	const now = Date.now();
	const cached = membershipCache.get(key);
	if (cached && now - cached.ts < MEMBERSHIP_CACHE_TTL_MS) return cached.res;
	try {
		const member = await prisma.conversationMember.findFirst({ where: { conversationId: convId, userId } });
		const res = !!member;
		_cacheSet(membershipCache, key, { res, ts: now }, MEMBERSHIP_CACHE_MAX);
		return res;
	} catch (e) {
		console.error("membership check failed", e);
		return false;
	}
}

export async function getRecipientsCached(convId, fresh = false) {
	const now = Date.now();
	const cached = recipientsCache.get(convId);
	if (!fresh && cached && now - cached.ts < RECIPIENTS_CACHE_TTL_MS) return cached.data;
	try {
		const rows = await prisma.contact.findMany({
			where: { conversationId: convId },
			select: { id: true, ownerId: true, contactId: true, isMuted: true, isBlocked: true, nickname: true, isSaved: true },
		});
		_cacheSet(recipientsCache, convId, { data: rows, ts: now }, RECIPIENTS_CACHE_MAX);
		return rows;
	} catch (e) {
		console.error("failed to fetch recipients for conv", convId, e);
		return [];
	}
}

export async function getMembersCached(convId, fresh = false) {
	const now = Date.now();
	const cached = membersCache.get(convId);
	if (!fresh && cached && now - cached.ts < RECIPIENTS_CACHE_TTL_MS) return cached.data;
	try {
		const rows = await prisma.conversationMember.findMany({
			where: { conversationId: convId },
			select: { userId: true, user: { select: { isDeleted: true } } },
		});
		const seen = new Set();
		const data = [];
		for (const r of rows) {
			if (seen.has(r.userId)) continue;
			seen.add(r.userId);
			data.push({ userId: r.userId, isDeleted: !!r.user?.isDeleted });
		}
		_cacheSet(membersCache, convId, { data, ts: now }, RECIPIENTS_CACHE_MAX);
		return data;
	} catch (e) {
		console.error("failed to fetch members for conv", convId, e);
		return [];
	}
}

/** Call after contact rows or members of a conversation change. */
export function invalidateConversationCache(convId) {
	const id = Number(convId);
	if (!Number.isInteger(id)) return;
	recipientsCache.delete(id);
	membersCache.delete(id);
	const prefix = `${id}:`;
	for (const key of membershipCache.keys()) {
		if (key.startsWith(prefix)) membershipCache.delete(key);
	}
}

export function invalidateAllCaches() {
	recipientsCache.clear();
	membersCache.clear();
	membershipCache.clear();
}

// ─── Socket helpers ──────────────────────────────────────────────────────────
export function getSocketById(id) {
	try {
		return ioInstance?.sockets?.sockets?.get(id) || null;
	} catch (e) {
		return null;
	}
}

export function emitToRoom(room, event, payload) {
	try {
		if (!ioInstance) return;
		ioInstance.to(room).emit(event, payload);
	} catch (e) {
		// ignore emit errors in helper
	}
}

export function socketsOfUser(userId) {
	const out = [];
	const ids = userSockets.get(userId);
	if (!ids) return out;
	for (const sid of ids) {
		const s = getSocketById(sid);
		if (s) out.push(s);
	}
	return out;
}

/** True when the user has the app open and visible on at least one device. */
export function hasVisibleSocket(userId) {
	return socketsOfUser(userId).some((s) => !s.data?.hidden);
}

/** True when the user is looking at this conversation right now. */
export function isUserViewing(userId, convId) {
	return socketsOfUser(userId).some(
		(s) => !s.data?.hidden && s.joinedConversations && s.joinedConversations.has(convId),
	);
}

export function emitToUser(userId, event, payload, { exceptSocketId = null } = {}) {
	for (const s of socketsOfUser(userId)) {
		if (exceptSocketId && s.id === exceptSocketId) continue;
		try {
			s.emit(event, payload);
		} catch (e) {
			/* ignore per-socket errors */
		}
	}
}

/**
 * Sends an event to every connected device of every member of a
 * conversation. `perUser(userId)` can return a different payload per member,
 * or undefined to skip that member.
 */
export async function deliverToConversation(convId, event, payload, { exceptSocketId = null, perUser = null } = {}) {
	const members = await getMembersCached(convId);
	for (const { userId } of members) {
		const p = perUser ? perUser(userId) : payload;
		if (p === undefined) continue;
		emitToUser(userId, event, p, { exceptSocketId });
	}
}

/** Signs a user out everywhere in real time (password change, account deletion). */
export function disconnectUserSockets(userId, { exceptSocketId = null } = {}) {
	for (const s of socketsOfUser(userId)) {
		if (exceptSocketId && s.id === exceptSocketId) continue;
		try {
			s.emit("session:ended");
			s.disconnect(true);
		} catch (e) {
			/* ignore */
		}
	}
}

/** Exact unread counters for every contact row of a conversation. */
export async function recomputeUnread(convId) {
	try {
		const rows = await prisma.contact.findMany({ where: { conversationId: convId }, select: { id: true, ownerId: true } });
		for (const r of rows) {
			const count = await prisma.message.count({
				where: { conversationId: convId, senderId: { not: r.ownerId }, isSeen: false, isDeleted: false },
			});
			await prisma.contact.update({ where: { id: r.id }, data: { unreadCount: count } });
		}
	} catch (e) {
		console.error("recomputeUnread failed", convId, e && e.message ? e.message : e);
	}
}

/**
 * Tells everyone who has `userId` as a contact about their online state,
 * honouring the "online status" privacy setting and blocks. With
 * `notifyHidden`, people who may not see it are told the user is offline
 * (used when the setting changes while they are looking).
 */
export async function broadcastPresence(userId, { online, lastSeen = null, notifyHidden = false } = {}) {
	try {
		const me = await prisma.user.findUnique({ where: { id: userId }, select: { privacyOnline: true, isDeleted: true } });
		if (!me) return;
		const owners = [
			...new Set(
				(await prisma.contact.findMany({ where: { contactId: userId, ownerId: { not: userId } }, select: { ownerId: true } })).map(
					(r) => r.ownerId,
				),
			),
		];
		if (owners.length === 0) return;
		const rel = await audienceOf(userId, owners);
		for (const ownerId of owners) {
			const allowed = !me.isDeleted && canSee(me.privacyOnline, rel.get(ownerId));
			if (allowed) {
				if (online) emitToUser(ownerId, "user:online", { userId });
				else emitToUser(ownerId, "user:offline", { userId, lastSeen, privacyOnline: me.privacyOnline });
			} else if (notifyHidden) {
				emitToUser(ownerId, "user:offline", { userId, lastSeen: null, privacyOnline: "nobody" });
			}
		}
	} catch (e) {
		console.error("broadcastPresence failed", e && e.message ? e.message : e);
	}
}

/**
 * Pushes a profile change (name, username, bio, picture) to everyone who has
 * the user as a contact, each according to the picture privacy setting.
 */
export async function broadcastUserUpdate(userId) {
	try {
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, name: true, username: true, bio: true, profilePics: true, privacyProfile: true, isDeleted: true },
		});
		if (!user) return;
		const base = { id: user.id, name: user.name, username: user.username, bio: user.bio || "", isDeleted: !!user.isDeleted };
		// own devices always get the full profile
		if (!user.isDeleted) emitToUser(userId, "user:updated", { ...base, profilePics: user.profilePics || [] });
		const owners = [
			...new Set(
				(await prisma.contact.findMany({ where: { contactId: userId, ownerId: { not: userId } }, select: { ownerId: true } })).map(
					(r) => r.ownerId,
				),
			),
		];
		if (owners.length === 0) return;
		const rel = await audienceOf(userId, owners);
		for (const ownerId of owners) {
			const pics = !user.isDeleted && canSee(user.privacyProfile, rel.get(ownerId)) ? user.profilePics || [] : [];
			emitToUser(ownerId, "user:updated", { ...base, profilePics: pics });
		}
	} catch (e) {
		console.error("broadcastUserUpdate failed", e && e.message ? e.message : e);
	}
}

// Recreates the contact row of someone who removed the sender from their
// contacts, so new messages reach them instead of silently disappearing.
const _restoring = new Map(); // `${convId}:${ownerId}` => Promise
async function restoreContactRow(convId, ownerId, contactId) {
	const key = `${convId}:${ownerId}`;
	if (_restoring.has(key)) return _restoring.get(key);
	const p = (async () => {
		try {
			const existing = await prisma.contact.findFirst({ where: { ownerId, conversationId: convId } });
			if (!existing) {
				await prisma.contact.create({ data: { ownerId, contactId, conversationId: convId } });
			}
		} catch (e) {
			console.error("restoreContactRow failed", e && e.message ? e.message : e);
		} finally {
			_restoring.delete(key);
		}
	})();
	_restoring.set(key, p);
	return p;
}

// Block state of a 1:1 conversation, from the cached contact rows.
function _blockState(rows, userId) {
	const own = rows.find((r) => r.ownerId === userId);
	return {
		blockedByMe: !!(own && own.isBlocked),
		blockedByOther: rows.some((r) => r.ownerId !== userId && r.isBlocked),
	};
}

// ─── Message actions (shared by the socket handlers and the REST routes) ──
// `actor` is { userId, socketId }: the device that acted gets its answer
// through the callback / HTTP response, not as an event.
export async function sendMessageAs(actor, data) {
	const { conversationId, text, replyToName, replyToText, forwardedFrom, forwardedText } = data;
	const isOneTime = data.isOneTime === true;
	const isTimeCapsule = data.isTimeCapsule === true;
	const scheduledForRaw = data.scheduledFor || null;
	let scheduledForToStore = null;

	const convId = parseIntSafe(conversationId);
	if (!convId) return { error: "Invalid conversationId" };

	// Basic message validation / DoS prevention
	if (!text || typeof text !== "string" || !text.trim() || text.trim().length > MAX_MESSAGE_LENGTH) {
		return { error: "Invalid data" };
	}
	if (isOneTime && isTimeCapsule) return { error: "Invalid data" };

	let replyToId = null;
	if (data.replyToId !== undefined && data.replyToId !== null && data.replyToId !== "") {
		replyToId = parseIntSafe(data.replyToId);
		if (!replyToId || replyToId < 1) return { error: "Invalid replyToId" };
	}

	try {
		if (!(await isMemberCached(convId, actor.userId))) {
			return { error: "Forbidden" };
		}

		// Validate time-capsule constraints (if requested).
		// We operate at minute precision: truncate both the provided time
		// and "now" to minute boundaries (seconds=0) so seconds are ignored.
		if (isTimeCapsule) {
			if (!scheduledForRaw) return { error: "scheduledFor required" };
			const sfRawDate = new Date(scheduledForRaw);
			if (isNaN(sfRawDate.getTime())) return { error: "scheduledFor invalid" };
			const truncateToMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000);
			const scheduledTrunc = truncateToMinute(sfRawDate);
			const nowTrunc = truncateToMinute(new Date());
			const minTime = new Date(nowTrunc.getTime() + 5 * 60 * 1000); // +5 minutes (minute-precision)
			const maxTime = new Date(nowTrunc.getTime() + 365 * 24 * 60 * 60 * 1000); // +1 year
			if (scheduledTrunc < minTime || scheduledTrunc > maxTime) {
				return { error: "scheduledFor out of range" };
			}
			// Use the truncated time for storage so seconds are ignored.
			scheduledForToStore = scheduledTrunc;
		}

		const members = await getMembersCached(convId);
		const others = members.filter((m) => m.userId !== actor.userId);
		const isSelfConversation = others.length === 0;
		let recipientRows = [];
		if (!isSelfConversation) {
			if (others.some((m) => m.isDeleted)) {
				return { error: "This account no longer exists" };
			}
			let rows = await getRecipientsCached(convId);
			const { blockedByMe, blockedByOther } = _blockState(rows, actor.userId);
			if (blockedByMe) return { error: "Unblock this contact to send messages" };
			if (blockedByOther) return { error: "Message could not be delivered" };
			const missing = others.filter((m) => !rows.some((r) => r.ownerId === m.userId));
			if (missing.length > 0) {
				await Promise.all(missing.map((m) => restoreContactRow(convId, m.userId, actor.userId)));
				rows = await getRecipientsCached(convId, true);
			}
			recipientRows = rows.filter((r) => r.ownerId !== actor.userId);
		}

		let replyToSenderId = null;
		if (replyToId) {
			const target = await prisma.message.findUnique({
				where: { id: replyToId },
				select: { conversationId: true, senderId: true },
			});
			if (!target || target.conversationId !== convId) {
				return { error: "Invalid replyToId" };
			}
			replyToSenderId = target.senderId;
		}

		// Encrypt message before persisting. Do NOT store plaintext.
		const plaintext = text.trim();
		const dek = generateDEK();
		const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);
		const keyId = ACTIVE_KEY_ID;
		const wrappedDek = wrapDEK(dek, keyId);

		// encrypt replyToText and forwardedText (store as JSON string) using same DEK
		const replyToTextPlain = typeof replyToText === "string" && replyToText.trim() ? replyToText.trim().slice(0, MAX_MESSAGE_LENGTH) : null;
		const forwardedTextPlain = typeof forwardedText === "string" && forwardedText.trim() ? forwardedText.trim().slice(0, MAX_MESSAGE_LENGTH) : null;
		let replyToTextEncrypted = null;
		let forwardedTextEncrypted = null;
		if (replyToTextPlain) {
			const r = encryptMessage(replyToTextPlain, dek);
			replyToTextEncrypted = JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
		}
		if (forwardedTextPlain) {
			const f = encryptMessage(forwardedTextPlain, dek);
			forwardedTextEncrypted = JSON.stringify({ c: f.ciphertext, iv: f.iv, t: f.authTag });
		}

		const message = await prisma.message.create({
			data: {
				conversationId: convId,
				senderId: actor.userId,
				text: null,
				isOneTime,
				isTimeCapsule,
				...(isTimeCapsule && scheduledForToStore ? { scheduledFor: scheduledForToStore } : {}),
				ciphertext,
				iv,
				auth_tag: authTag,
				wrapped_dek: wrappedDek,
				key_id: keyId,
				...(replyToId && { replyToId }),
				...(replyToName && typeof replyToName === "string" && { replyToName: replyToName.trim().slice(0, 100) }),
				...(replyToTextEncrypted && { replyToText: replyToTextEncrypted }),
				...(forwardedTextEncrypted && { forwardedText: forwardedTextEncrypted }),
				...(forwardedFrom && typeof forwardedFrom === "string" && { forwardedFrom: forwardedFrom.trim().slice(0, 100) }),
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

		await prisma.conversation.update({
			where: { id: convId },
			data: { lastMessageAt: message.createdAt },
		});

		// Sanitized payload (never ciphertext or wrapped keys)
		const safe = {
			id: message.id,
			conversationId: message.conversationId,
			sender: message.sender,
			senderId: message.senderId,
			text: plaintext,
			isSeen: message.isSeen,
			isEdited: message.isEdited,
			isPinned: message.isPinned,
			isDeleted: message.isDeleted,
			isOneTime: message.isOneTime,
			replyToId: message.replyToId,
			replyToName: message.replyToName,
			replyToSenderId,
			replyToText: replyToTextPlain,
			forwardedText: forwardedTextPlain,
			forwardedFrom: message.forwardedFrom,
			createdAt: message.createdAt,
			isTimeCapsule: message.isTimeCapsule || false,
			scheduledFor: message.scheduledFor ? message.scheduledFor.toISOString() : null,
			openedAt: message.openedAt ? message.openedAt.toISOString() : null,
			isLocked: false,
		};

		// Receivers must not see a capsule's text before it opens
		const isLocked = isCapsuleLocked(message);
		const recipientSafe = isLocked
			? { ...safe, text: null, replyToText: null, forwardedText: null, isLocked: true }
			: safe;

		if (isSelfConversation) {
			await deliverToConversation(convId, "message:new", safe, { exceptSocketId: actor.socketId });
			return { success: true, message: safe };
		}

		// Unread counters for people who are not looking at this chat right now
		const toUpdateIds = recipientRows.filter((r) => !isUserViewing(r.ownerId, convId)).map((r) => r.id);
		if (toUpdateIds.length > 0) {
			// awaited, so a "seen" that follows right after cannot be overtaken
			await prisma.contact
				.updateMany({
					where: { id: { in: toUpdateIds } },
					data: { unreadCount: { increment: 1 } },
				})
				.catch((e) => console.error("update unread failed", e));
		}

		// Every device of every member gets it once; the sender's other
		// devices get the unmasked copy.
		await deliverToConversation(convId, "message:new", null, {
			exceptSocketId: actor.socketId,
			perUser: (uid) => (uid === actor.userId ? safe : recipientSafe),
		});

		// Web push for people who do not have the app open
		try {
			const senderName = message.sender?.name || "New message";
			const pushed = new Set();
			for (const r of recipientRows) {
				const uid = r.ownerId;
				if (pushed.has(uid) || r.isMuted || hasVisibleSocket(uid)) continue;
				pushed.add(uid);
				push.sendNotificationToUser(uid, {
					title: r.nickname || senderName,
					body: isLocked ? "Sent you a time capsule 🔒" : isOneTime ? "Sent you a one-time message" : plaintext.slice(0, 120),
					data: { conversationId: convId, url: `/chat/main.html?conversationId=${convId}` },
					tag: `conversation-${convId}`,
				}).catch(() => {
					/* push error suppressed */
				});
			}
		} catch (e) {
			// push notify failed (suppressed)
		}

		return { success: true, message: safe };
	} catch (err) {
		console.error(err);
		return { error: "Server error" };
	}
}

export async function editMessageAs(actor, { messageId, text } = {}) {
	const msgId = parseIntSafe(messageId);
	if (!msgId) return { error: "Invalid messageId" };
	if (!text || typeof text !== "string" || !text.trim() || text.trim().length > MAX_MESSAGE_LENGTH) {
		return { error: "Invalid data" };
	}
	try {
		const message = await prisma.message.findUnique({
			where: { id: msgId },
		});

		if (!message || message.senderId !== actor.userId) {
			return { error: "Forbidden" };
		}
		if (message.isDeleted) {
			return { error: "Cannot edit a deleted message" };
		}
		if (message.isTimeCapsule && !message.openedAt) {
			return { error: "Cannot edit a sealed time capsule" };
		}
		if (message.isOneTime) {
			return { error: "One-time messages cannot be edited" };
		}

		// Encrypt edited text and update encrypted columns
		const plaintext = text.trim();
		const dek = generateDEK();
		const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);
		const keyId = ACTIVE_KEY_ID;
		const wrappedDek = wrapDEK(dek, keyId);

		// The quoted texts are encrypted with the message key, so they have to
		// move to the new key too (otherwise they could no longer be read).
		const oldDek = message.replyToText || message.forwardedText ? decryptBody(message).dek : null;
		const reEncrypt = (value) => {
			if (!value) return value;
			const plain = decryptAux(value, oldDek, message.id);
			if (plain === null || plain === undefined) return null;
			const r = encryptMessage(plain, dek);
			return JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
		};

		await prisma.message.update({
			where: { id: msgId },
			data: {
				text: null,
				ciphertext,
				iv,
				auth_tag: authTag,
				wrapped_dek: wrappedDek,
				key_id: keyId,
				isEdited: true,
				replyToText: reEncrypt(message.replyToText),
				forwardedText: reEncrypt(message.forwardedText),
			},
		});

		await deliverToConversation(
			message.conversationId,
			"message:edited",
			{ messageId: msgId, conversationId: message.conversationId, text: plaintext, isEdited: true },
			{ exceptSocketId: actor.socketId },
		);

		return { success: true };
	} catch (err) {
		console.error(err);
		return { error: "Server error" };
	}
}

export async function deleteMessageAs(actor, { messageId } = {}) {
	const msgId = parseIntSafe(messageId);
	if (!msgId) return { error: "Invalid messageId" };

	try {
		const message = await prisma.message.findUnique({
			where: { id: msgId },
		});

		if (!message || message.senderId !== actor.userId) {
			return { error: "Forbidden" };
		}
		if (message.isDeleted) return { success: true };

		await prisma.message.update({
			where: { id: msgId },
			data: {
				isDeleted: true,
				isPinned: false,
				...(message.isOneTime
					? { ciphertext: null, iv: null, auth_tag: null, wrapped_dek: null, text: null }
					: {}),
			},
		});

		// An unseen message was counted as unread for the other side
		if (!message.isSeen) await recomputeUnread(message.conversationId);

		// The device that deleted it already updated itself. Sender and seen
		// state let the other side fix its unread counter even when the
		// message was never loaded there.
		await deliverToConversation(
			message.conversationId,
			"message:deleted",
			{ messageId: msgId, conversationId: message.conversationId, senderId: message.senderId, isSeen: !!message.isSeen },
			{ exceptSocketId: actor.socketId },
		);

		return { success: true };
	} catch (err) {
		console.error(err);
		return { error: "Server error" };
	}
}

export async function togglePinAs(actor, { messageId } = {}) {
	const msgId = parseIntSafe(messageId);
	if (!msgId) return { error: "Invalid messageId" };
	try {
		const message = await prisma.message.findUnique({
			where: { id: msgId },
		});
		if (!message || message.isDeleted) return { error: "Not found" };

		if (!(await isMemberCached(message.conversationId, actor.userId))) return { error: "Forbidden" };

		if (!message.isPinned) {
			const pinnedCount = await prisma.message.count({
				where: { conversationId: message.conversationId, isPinned: true, isDeleted: false },
			});
			if (pinnedCount >= 20) {
				return { error: "Pin limit reached (20). Unpin something first." };
			}
		}

		const updated = await prisma.message.update({
			where: { id: msgId },
			data: { isPinned: !message.isPinned },
		});

		await deliverToConversation(
			message.conversationId,
			"message:pinned",
			{ messageId: msgId, conversationId: message.conversationId, isPinned: updated.isPinned },
			{ exceptSocketId: actor.socketId },
		);

		return { success: true, isPinned: updated.isPinned };
	} catch (err) {
		console.error(err);
		return { error: "Server error" };
	}
}

export function initSocket(httpServer) {
	const defaultOrigins = [
		"http://localhost:3000",
		"http://127.0.0.1:3000",
		"https://rivo.ir",
		"https://www.rivo.ir",
		"https://chat.rivo.ir",
	];
	const allowedOrigins = new Set(
		(process.env.ALLOWED_ORIGINS
			? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
			: defaultOrigins)
	);
	// Configure ping settings so the server detects sudden network
	// failures (e.g., phone powered off) more quickly than the default.
	const pingInterval = parseInt(process.env.SOCKET_PING_INTERVAL || "5000", 10);
	const pingTimeout = parseInt(process.env.SOCKET_PING_TIMEOUT || "5000", 10);

	const io = new Server(httpServer, {
		cors: {
			origin: (origin, cb) => {
				if (!origin) return cb(null, true);
				cb(null, allowedOrigins.has(origin) ? origin : false);
			},
			credentials: true,
		},
		pingInterval,
		pingTimeout,
	});
	ioInstance = io;

	// Map<userId, Timeout> used to debounce marking users offline
	const offlineTimers = new Map();
	const OFFLINE_GRACE_MS = parseInt(process.env.OFFLINE_GRACE_MS || "7000", 10);

	// Connection attempts limiter by IP to prevent handshake floods
	const connectionAttempts = new Map(); // Map<ip, Array<timestamp>>
	const CONNECTION_ATTEMPT_WINDOW_MS = parseInt(process.env.SOCKET_CONN_ATTEMPT_WINDOW_MS || "60000", 10);
	const CONNECTION_ATTEMPT_MAX = parseInt(process.env.SOCKET_CONN_ATTEMPT_MAX || "30", 10);
	// Maximum number of timestamps to keep per-IP to avoid unbounded memory growth
	const CONNECTION_ATTEMPT_STORE_MAX = parseInt(process.env.SOCKET_CONN_ATTEMPT_STORE_MAX || "100", 10);
	// Maximum number of distinct IP keys to keep to avoid unbounded Map growth
	const CONNECTION_ATTEMPT_MAP_MAX = parseInt(process.env.SOCKET_CONN_ATTEMPT_MAP_MAX || "5000", 10);

	// Simple per-user rate limiter: Map<userId, Array<timestamp>>
	const sendRate = new Map();
	const RATE_LIMIT_WINDOW_MS = parseInt(process.env.SOCKET_RATE_WINDOW_MS || "10000", 10); // 10s
	const RATE_LIMIT_MAX = parseInt(process.env.SOCKET_RATE_MAX || "20", 10); // max messages per window

	// Retried sends carry the same clientMessageId; answer them with the
	// message that was already stored instead of storing it twice.
	const recentSends = new Map(); // `${userId}:${clientMessageId}` => { ts, promise }
	const RECENT_SEND_TTL_MS = 10 * 60 * 1000;
	const RECENT_SEND_MAX = 50000;

	function checkRate(userId, max = RATE_LIMIT_MAX) {
		try {
			const now = Date.now();
			const arr = sendRate.get(userId) || [];
			const recent = arr.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
			recent.push(now);
			sendRate.set(userId, recent);
			return recent.length <= max;
		} catch (e) {
			console.error("rate limit check failed", e);
			return true;
		}
	}

	// Periodic cleanup of in-memory state to avoid memory growth
	setInterval(() => {
		const now = Date.now();
		for (const [ip, arr] of connectionAttempts.entries()) {
			let recent = arr.filter((t) => now - t < CONNECTION_ATTEMPT_WINDOW_MS);
			if (recent.length > CONNECTION_ATTEMPT_STORE_MAX) recent = recent.slice(-CONNECTION_ATTEMPT_STORE_MAX);
			if (recent.length === 0) connectionAttempts.delete(ip);
			else connectionAttempts.set(ip, recent);
		}

		// If too many distinct IPs are being tracked (e.g., rotating scanners),
		// evict the oldest entries to keep memory bounded.
		while (connectionAttempts.size > CONNECTION_ATTEMPT_MAP_MAX) {
			const oldest = connectionAttempts.keys().next().value;
			if (!oldest) break;
			connectionAttempts.delete(oldest);
		}

		// sendRate should also be cleaned up periodically so inactive users do not
		// keep unbounded history entries in memory forever.
		for (const [uid, arr] of sendRate.entries()) {
			const recent = arr.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
			if (recent.length === 0 && !userSockets.has(uid)) sendRate.delete(uid);
			else if (recent.length !== arr.length) sendRate.set(uid, recent);
		}

		for (const [key, entry] of recentSends.entries()) {
			if (now - entry.ts > RECENT_SEND_TTL_MS) recentSends.delete(key);
		}
	}, Math.max(10000, Math.floor(CONNECTION_ATTEMPT_WINDOW_MS / 4))).unref?.();

	function _getClientIpFromSocket(sock) {
		try {
			// Only honor X-Forwarded-For when the deploy explicitly enables
			// trusted proxy support. This prevents clients from spoofing IPs
			// by setting the header when not behind a reverse proxy.
			const enableTrustProxy = process.env.ENABLE_TRUST_PROXY === '1' && process.env.NODE_ENV === 'production';
			if (enableTrustProxy) {
				const fwd = sock.handshake.headers && sock.handshake.headers['x-forwarded-for'];
				if (fwd) return String(fwd).split(',')[0].trim();
			}
			return sock.handshake.address || '';
		} catch (e) {
			return '';
		}
	}

	// ─── Auth & connection-rate middleware ───────────────────────────────────
	io.use(async (socket, next) => {
		// Prevent handshake floods by IP
		try {
			const ip = _getClientIpFromSocket(socket) || '';
			const now = Date.now();
			const arr = connectionAttempts.get(ip) || [];
			const minTs = now - CONNECTION_ATTEMPT_WINDOW_MS;
			let recent = arr.filter((t) => t > minTs);
			recent.push(now);
			// Cap stored timestamps per-IP to avoid unbounded arrays
			if (recent.length > CONNECTION_ATTEMPT_STORE_MAX) recent = recent.slice(-CONNECTION_ATTEMPT_STORE_MAX);
			connectionAttempts.set(ip, recent);

			// Cap total number of distinct IPs tracked to avoid memory exhaustion
			while (connectionAttempts.size > CONNECTION_ATTEMPT_MAP_MAX) {
				const oldest = connectionAttempts.keys().next().value;
				if (!oldest) break;
				connectionAttempts.delete(oldest);
			}
			if (recent.length > CONNECTION_ATTEMPT_MAX) {
				console.warn('socket connection rate limited ip=', ip);
				return next(new Error('RateLimit'));
			}
		} catch (e) {
			// Do not fail auth on rate-check errors
		}

		// Enforce cookie-only JWT for socket auth. Expect `token` cookie in handshake headers.
		const cookieHeader = socket.handshake.headers?.cookie || "";
		// (?:^|;\s*) so that e.g. "csrfToken=…" is never read as the auth token
		const token = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)?.[1];

		if (!token) {
			return next(new Error("Unauthorized"));
		}

		try {
			const payload = jwt.verify(token, process.env.JWT_SECRET);
			const userId = payload.userId;

			// Apply the same account-state checks as the HTTP middleware so sockets
			// cannot bypass deleted-user protections or stale-token checks.
			try {
				const u = await prisma.user.findUnique({
					where: { id: userId },
					select: { passwordChangedAt: true, isDeleted: true },
				});
				if (!u || u.isDeleted) {
					return next(new Error("Invalid token"));
				}
				if (u.passwordChangedAt) {
					const pwdChangedAtSeconds = Math.floor(new Date(u.passwordChangedAt).getTime() / 1000);
					const tokenIat = payload.iat || 0;
					if (pwdChangedAtSeconds > tokenIat) {
						return next(new Error("Invalid token"));
					}
				}
			} catch (e) {
				console.error("Socket auth check failed", e);
				return next(new Error("ServiceUnavailable"));
			}

			socket.userId = userId;
			// The client reports whether the app is visible; hidden tabs and
			// backgrounded phones still get push notifications.
			socket.data.hidden = socket.handshake.auth?.visible === false;
			// Ensure per-user rate state exists (do not overwrite existing history)
			if (!sendRate.has(userId)) sendRate.set(userId, []);
			next();
		} catch (err) {
			if (err && err.name === "TokenExpiredError") {
				return next(new Error("TokenExpired"));
			}
			return next(new Error("Invalid token"));
		}
	});

	// ─── Connection ───────────────────────────────────────────────────────────
	io.on("connection", (socket) => {
		// Do not auto-join conversation rooms on connect. Clients should
		// explicitly join a conversation when the user opens that chat.
		socket.joinedConversations = new Set();

		// Per-conversation typing timestamps to throttle typing events
		socket._lastTyping = new Map();
		async function _isMember(convId) {
			return await isMemberCached(convId, socket.userId);
		}

		// track this socket under the user's connected sockets (synchronously,
		// so events that arrive right after the handshake can find it)
		const us = userSockets.get(socket.userId) || new Set();
		us.add(socket.id);
		userSockets.set(socket.userId, us);

		// If there was a pending offline timer for this user, clear it.
		const wasPendingOffline = offlineTimers.has(socket.userId);
		if (wasPendingOffline) {
			clearTimeout(offlineTimers.get(socket.userId));
			offlineTimers.delete(socket.userId);
		}

		// Not awaited: every event handler below must be registered right away,
		// otherwise events the client sends immediately after connecting (such
		// as re-joining the open chat) would be lost.
		(async () => {
			try {
				await prisma.user.update({
					where: { id: socket.userId },
					data: { isOnline: true },
				});
				// Emit online events only to users who have this user as a contact
				// (and may see it)
				await broadcastPresence(socket.userId, { online: true });
			} catch (err) {
				console.error("Connection error", err);
			}
		})();

		socket.on("presence:visibility", (payload) => {
			socket.data.hidden = payload?.visible === false;
		});

		// ─── Send message ──────────────────────────────────────────────────────
		socket.on("message:send", async (data, callback) => {
			const reply = typeof callback === "function" ? callback : () => {};
			if (!data || typeof data !== "object") return reply({ error: "Invalid data" });
			const actor = { userId: socket.userId, socketId: socket.id };

			const clientMessageId =
				typeof data.clientMessageId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(data.clientMessageId)
					? data.clientMessageId
					: null;
			if (!clientMessageId) {
				if (!checkRate(socket.userId)) return reply({ error: "Rate limit exceeded" });
				return reply(await sendMessageAs(actor, data));
			}

			// A retry of a message that is already stored (or still being
			// stored) gets the same answer instead of a second copy.
			const key = `${socket.userId}:${clientMessageId}`;
			const existing = recentSends.get(key);
			if (existing) return reply(await existing.promise);

			if (!checkRate(socket.userId)) return reply({ error: "Rate limit exceeded" });
			const promise = sendMessageAs(actor, data);
			if (recentSends.size >= RECENT_SEND_MAX) {
				const oldest = recentSends.keys().next().value;
				if (oldest !== undefined) recentSends.delete(oldest);
			}
			recentSends.set(key, { ts: Date.now(), promise });
			const result = await promise;
			// failed attempts may be retried for real
			if (!result || result.error) recentSends.delete(key);
			return reply(result);
		});

		// ─── Edit / delete / pin ───────────────────────────────────────────────
		socket.on("message:edit", async (data, callback) => {
			const reply = typeof callback === "function" ? callback : () => {};
			if (!checkRate(socket.userId)) return reply({ error: "Rate limit exceeded" });
			reply(await editMessageAs({ userId: socket.userId, socketId: socket.id }, data || {}));
		});

		socket.on("message:delete", async (data, callback) => {
			const reply = typeof callback === "function" ? callback : () => {};
			if (!checkRate(socket.userId)) return reply({ error: "Rate limit exceeded" });
			reply(await deleteMessageAs({ userId: socket.userId, socketId: socket.id }, data || {}));
		});

		socket.on("message:pin", async (data, callback) => {
			const reply = typeof callback === "function" ? callback : () => {};
			if (!checkRate(socket.userId)) return reply({ error: "Rate limit exceeded" });
			reply(await togglePinAs({ userId: socket.userId, socketId: socket.id }, data || {}));
		});

		// ─── Add/toggle reaction ───────────────────────────────────────────────
		socket.on("reaction:add", async (data, callback) => {
			const reply = typeof callback === "function" ? callback : () => {};
			const { messageId, emoji } = data || {};
			try {
				if (!checkRate(socket.userId)) return reply({ error: "Rate limit exceeded" });
				if (!messageId || !emoji || typeof emoji !== "string" || emoji.length > 10) {
					return reply({ error: "Invalid data" });
				}

				const msgId = parseIntSafe(messageId);
				if (!msgId) return reply({ error: "Invalid messageId" });

				const message = await prisma.message.findUnique({
					where: { id: msgId },
					select: { id: true, conversationId: true, senderId: true, isDeleted: true },
				});
				if (!message || message.isDeleted) return reply({ error: "Message not found" });

				if (!(await _isMember(message.conversationId))) return reply({ error: "Forbidden" });

				const rows = await getRecipientsCached(message.conversationId);
				const { blockedByMe, blockedByOther } = _blockState(rows, socket.userId);
				if (blockedByMe || blockedByOther) return reply({ error: "Forbidden" });

				// upsert: one reaction per user per message
				const existing = await prisma.messageReaction.findUnique({
					where: { messageId_userId: { messageId: msgId, userId: socket.userId } },
				});

				let action;

				if (existing && existing.emoji === emoji) {
					// same emoji → remove (toggle off)
					await prisma.messageReaction.delete({
						where: { messageId_userId: { messageId: msgId, userId: socket.userId } },
					});
					action = "removed";
				} else {
					// different emoji or new → upsert
					await prisma.messageReaction.upsert({
						where: { messageId_userId: { messageId: msgId, userId: socket.userId } },
						create: { messageId: msgId, userId: socket.userId, emoji },
						update: { emoji },
					});
					action = existing ? "changed" : "added";
				}

				// fetch updated reactions for this message
				const allReactions = await prisma.messageReaction.findMany({
					where: { messageId: msgId },
					select: { userId: true, emoji: true },
				});

				const payload = {
					messageId: msgId,
					conversationId: message.conversationId,
					reactions: allReactions,
					actorId: socket.userId,
					emoji,
					action,
				};

				// everyone in the conversation, including the sender's own devices
				await deliverToConversation(message.conversationId, "reaction:updated", payload);

				// Tell the author of the message when they are not in the app
				try {
					const authorId = message.senderId;
					const authorRow = rows.find((r) => r.ownerId === authorId);
					if (action !== "removed" && authorId !== socket.userId && !(authorRow && authorRow.isMuted) && !hasVisibleSocket(authorId)) {
						let actorName = 'Someone';
						try {
							const actor = await prisma.user.findUnique({ where: { id: socket.userId }, select: { name: true } });
							if (actor?.name) actorName = actor.name;
						} catch (e) {
							/* ignore */
						}
						push.sendNotificationToUser(authorId, {
							title: (authorRow && authorRow.nickname) || actorName,
							body: `Reacted ${emoji} to your message`,
							data: {
								conversationId: message.conversationId,
								url: `/chat/main.html?conversationId=${message.conversationId}`,
							},
							tag: `conversation-${message.conversationId}`,
						}).catch(() => { /* suppress push errors */ });
					}
				} catch (e) {
					console.error('reaction:push error', e);
				}

				reply({ success: true, action, reactions: allReactions });
			} catch (err) {
				console.error("reaction:add error", err);
				reply({ error: "Server error" });
			}
		});

		// ─── Typing ────────────────────────────────────────────────────────────
		function _relayTyping(event, data) {
			const convId = parseIntSafe(data?.conversationId);
			if (!convId) return;
			(async () => {
				try {
					// throttle typing events per-socket per-conversation to avoid spam
					const THROTTLE_MS = parseInt(process.env.TYPING_THROTTLE_MS || "500", 10);
					const now = Date.now();
					const key = `${convId}:${event}`;
					const last = socket._lastTyping.get(key) || 0;
					if (now - last < THROTTLE_MS) return;
					socket._lastTyping.set(key, now);
					if (!(await _isMember(convId))) return;
					const rows = await getRecipientsCached(convId);
					const { blockedByMe, blockedByOther } = _blockState(rows, socket.userId);
					if (blockedByMe || blockedByOther) return;
					const payload = { userId: socket.userId, conversationId: convId };
					await deliverToConversation(convId, event, null, {
						perUser: (uid) => (uid === socket.userId ? undefined : payload),
					});
				} catch (e) {
					console.error(`${event} relay failed`, e);
				}
			})();
		}
		socket.on("typing:start", (data) => _relayTyping("typing:start", data));
		socket.on("typing:stop", (data) => _relayTyping("typing:stop", data));

		// ─── One-time messages ─────────────────────────────────────────────────
		// One-time messages this user has seen are removed once they leave the
		// conversation (closing it, or disconnecting).
		async function _cleanupSeenOneTime(convId) {
			try {
				const seenOneTime = await prisma.message.findMany({
					where: {
						conversationId: convId,
						isOneTime: true,
						isSeen: true,
						isDeleted: false,
						senderId: { not: socket.userId },
					},
					select: { id: true },
				});
				if (seenOneTime.length === 0) return;
				const ids = seenOneTime.map((m) => m.id);
				await prisma.message.updateMany({
					where: { id: { in: ids } },
					data: { isDeleted: true, isPinned: false, ciphertext: null, iv: null, auth_tag: null, wrapped_dek: null, text: null },
				});
				// Notify all members of the conversation (sender needs to see it disappear too)
				await deliverToConversation(convId, "message:onetime-deleted", { conversationId: convId, messageIds: ids });
			} catch (e) {
				console.error("one-time message cleanup failed", e);
			}
		}

		// ─── Disconnect ────────────────────────────────────────────────────────
		socket.on("disconnect", async () => {
			const lastSeen = new Date();
			try {
				// remove this socket from the user's socket set immediately so
				// we can determine whether other connections remain
				const sset = userSockets.get(socket.userId);
				if (sset) {
					sset.delete(socket.id);
					if (sset.size === 0) userSockets.delete(socket.userId);
				}

				const remaining = userSockets.get(socket.userId);
				if ((!remaining || remaining.size === 0) && !offlineTimers.has(socket.userId)) {
					// Schedule a debounced offline update to avoid flapping on
					// transient disconnects (e.g., mobile network handoffs).
					const timer = setTimeout(async () => {
						try {
							const still = userSockets.get(socket.userId);
							if (!still || still.size === 0) {
								await prisma.user.update({
									where: { id: socket.userId },
									data: { isOnline: false, lastSeen },
								});
								await broadcastPresence(socket.userId, { online: false, lastSeen });
							}
						} catch (e) {
							console.error('deferred disconnect update failed', e);
						} finally {
							offlineTimers.delete(socket.userId);
						}
					}, OFFLINE_GRACE_MS);
					offlineTimers.set(socket.userId, timer);
				}
			} catch (e) {
				console.error('disconnect handler error', e);
			} finally {
				// cleanup per-user rate tracking if no sockets remain for this user
				try {
					const remaining = userSockets.get(socket.userId);
					if (!remaining || remaining.size === 0) sendRate.delete(socket.userId);
				} catch (e) {
					// ignore
				}

				// Clear per-socket typing state to free memory
				try {
					socket._lastTyping?.clear?.();
				} catch (e) {
					/* ignore */
				}

				// One-time message cleanup on disconnect (ensure seen one-time messages
				// are deleted even when the client did not explicitly leave the convo)
				if (socket.joinedConversations && socket.joinedConversations.size > 0) {
					for (const cid of socket.joinedConversations) {
						_cleanupSeenOneTime(cid);
					}
				}
			}
		});

		// ─── Message seen ───────────────────────────────────────────────────────
		socket.on("message:seen", async (data, callback) => {
			const reply = typeof callback === "function" ? callback : () => {};
			const convId = parseIntSafe(data?.conversationId);
			if (!convId) return reply({ success: true, marked: [] });
			try {
				if (!(await _isMember(convId))) return reply({ error: "Forbidden" });

				// Only the device that has the conversation open and visible may
				// mark messages as seen (other tabs or a phone in a pocket must not)
				if (!socket.joinedConversations || !socket.joinedConversations.has(convId) || socket.data.hidden) {
					return reply({ success: true, marked: [] });
				}

				// Batch-process unseen message ids to avoid large memory spikes
				const BATCH_SIZE = parseInt(process.env.MESSAGE_SEEN_BATCH_SIZE || "1000", 10);
				const MAX_COLLECT = parseInt(process.env.MESSAGE_SEEN_MAX_COLLECT || "10000", 10);
				let totalMarked = [];
				const MAX_ITERATIONS = parseInt(process.env.MESSAGE_SEEN_MAX_ITERATIONS || "50", 10);
				let _iterations = 0;
				while (true) {
					_iterations += 1;
					if (_iterations > MAX_ITERATIONS) {
						console.warn(`message:seen loop exceeded max iterations for conv=${convId} user=${socket.userId}`);
						break;
					}
					const toMark = await prisma.message.findMany({
						where: {
							conversationId: convId,
							senderId: { not: socket.userId },
							isSeen: false,
						},
						select: { id: true },
						take: BATCH_SIZE,
					});

					if (!toMark || toMark.length === 0) break;

					const ids = toMark.map((m) => m.id);
					await prisma.message.updateMany({ where: { id: { in: ids } }, data: { isSeen: true } });

					// emit per-batch so clients can update progressively (the
					// sender's devices, and this user's other devices)
					await deliverToConversation(
						convId,
						"message:seen",
						{ conversationId: convId, messageIds: ids, seenBy: socket.userId },
						{ exceptSocketId: socket.id },
					);

					totalMarked.push(...ids);
					if (totalMarked.length >= MAX_COLLECT) {
						console.warn(`message:seen truncated at ${MAX_COLLECT} ids for conv=${convId} user=${socket.userId}`);
						break;
					}

					if (toMark.length < BATCH_SIZE) break;
				}

				try {
					await prisma.contact.updateMany({ where: { conversationId: convId, ownerId: socket.userId }, data: { unreadCount: 0 } });
				} catch (e) {
					console.error('update unread failed', e);
				}

				if (totalMarked.length > 0) {
					reply({ success: true, marked: totalMarked.length <= MAX_COLLECT ? totalMarked : undefined, markedCount: totalMarked.length });
				} else {
					reply({ success: true, marked: [] });
				}
			} catch (err) {
				console.error("message:seen handler error", err);
				reply({ error: "Server error" });
			}
		});

		socket.on("conversation:join", async (data) => {
			const convId = parseIntSafe(data?.conversationId);
			if (!convId) return;
			try {
				if (!(await _isMember(convId))) return;
				socket.join(`conversation:${convId}`);
				socket.joinedConversations = socket.joinedConversations || new Set();
				socket.joinedConversations.add(convId);
			} catch (e) {
				console.error("conversation:join error", e);
			}
		});

		// Allow clients to explicitly leave a conversation room when they close it.
		socket.on("conversation:leave", async (data) => {
			const convId = parseIntSafe(data?.conversationId);
			if (!convId) return;
			try {
				if (!socket.joinedConversations || !socket.joinedConversations.has(convId)) return;
				socket.leave(`conversation:${convId}`);
				socket.joinedConversations.delete(convId);
				await _cleanupSeenOneTime(convId);
			} catch (e) {
				console.error("conversation:leave error", e);
			}
		});
	});

	// Backwards compatibility: attempt to set globalThis if possible.
	try {
		globalThis.__rivo_io = io;
	} catch (e) {
		// ignore if environment doesn't allow globalThis assignment
	}

	return io;
}
