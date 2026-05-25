import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import push from "../utils/push.js";
import { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage } from "../utils/encryption.js";
import { parseIntSafe, MAX_MESSAGE_LENGTH } from "../utils/validators.js";

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

	// Map<conversationId, Set<userId>> of users currently in each conversation room
	const convoOnline = new Map();

	// Map<userId, Set<socketId>> for quick targeting of a user's connected sockets
	const userSockets = new Map();

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

	// In-memory caches to reduce repeated DB calls (best-effort with short TTL)
	const membershipCache = new Map(); // key `${convId}:${userId}` => { res, ts }
	const MEMBERSHIP_CACHE_TTL_MS = parseInt(process.env.MEMBERSHIP_CACHE_TTL_MS || "30000", 10);
	const recipientsCache = new Map(); // key convId => { data: [{id, ownerId}], ts }
	const RECIPIENTS_CACHE_TTL_MS = parseInt(process.env.RECIPIENTS_CACHE_TTL_MS || "30000", 10);

	// Periodic cleanup for connectionAttempts to avoid memory growth
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
	}, Math.max(10000, Math.floor(CONNECTION_ATTEMPT_WINDOW_MS / 4)));

	function _getClientIpFromSocket(sock) {
		try {
			const fwd = sock.handshake.headers && sock.handshake.headers['x-forwarded-for'];
			if (fwd) return String(fwd).split(',')[0].trim();
			return sock.handshake.address || '';
		} catch (e) {
			return '';
		}
	}

	async function isMemberCached(convId, userId) {
		const key = `${convId}:${userId}`;
		const now = Date.now();
		const cached = membershipCache.get(key);
		if (cached && now - cached.ts < MEMBERSHIP_CACHE_TTL_MS) return cached.res;
		try {
			const member = await prisma.conversationMember.findFirst({ where: { conversationId: convId, userId } });
			const res = !!member;
			membershipCache.set(key, { res, ts: now });
			return res;
		} catch (e) {
			console.error('membership check failed', e);
			return false;
		}
	}

	async function getRecipientsCached(convId) {
		const now = Date.now();
		const cached = recipientsCache.get(convId);
		if (cached && now - cached.ts < RECIPIENTS_CACHE_TTL_MS) return cached.data;
		try {
			const rows = await prisma.contact.findMany({ where: { conversationId: convId }, select: { id: true, ownerId: true } });
			recipientsCache.set(convId, { data: rows, ts: now });
			return rows;
		} catch (e) {
			console.error('failed to fetch recipients for conv', convId, e);
			return [];
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
		const token = cookieHeader.match(/token=([^;]+)/)?.[1];

		if (!token) {
			return next(new Error("Unauthorized"));
		}

		try {
			const payload = jwt.verify(token, process.env.JWT_SECRET);
			const userId = payload.userId;

			// Ensure token was issued after any password change
			try {
				const u = await prisma.user.findUnique({ where: { id: userId }, select: { passwordChangedAt: true } });
				if (u?.passwordChangedAt) {
					const pwdChangedAtSeconds = Math.floor(new Date(u.passwordChangedAt).getTime() / 1000);
					const tokenIat = payload.iat || 0;
					if (pwdChangedAtSeconds > tokenIat) {
						return next(new Error("Invalid token"));
					}
				}
			} catch (e) {
				console.error("Socket auth passwordChangedAt check failed", e);
			}

			socket.userId = userId;
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
	io.on("connection", async (socket) => {
		// Do not auto-join conversation rooms on connect. Clients should
		// explicitly join a conversation when the user opens that chat.
		socket.joinedConversations = new Set();

		// Per-conversation typing timestamps to throttle typing events
		socket._lastTyping = new Map();
		async function _isMember(convId) {
			return await isMemberCached(convId, socket.userId);
		}

		try {
			// connection logged (suppressed in production)
			await prisma.user.update({
				where: { id: socket.userId },
				data: { isOnline: true },
			});
			// track this socket under the user's connected sockets
			const us = userSockets.get(socket.userId) || new Set();
			us.add(socket.id);
			userSockets.set(socket.userId, us);

			// If there was a pending offline timer for this user, clear it.
			if (offlineTimers.has(socket.userId)) {
				clearTimeout(offlineTimers.get(socket.userId));
				offlineTimers.delete(socket.userId);
			}
			// per-user rate tracking initialized in auth middleware; nothing else to do here
			socket.broadcast.emit("user:online", { userId: socket.userId });
		} catch (err) {
			console.error("Connection error", err);
			socket.disconnect();
		}



		// ─── Send message ──────────────────────────────────────────────────────
		socket.on("message:send", async (data, callback) => {
			const {
				conversationId,
				text,
				replyToId,
				replyToName,
				replyToText,
				forwardedFrom,
				forwardedText,
			} = data;

			const convId = parseIntSafe(conversationId);
			if (!convId) return callback?.({ error: "Invalid conversationId" });

			// Basic message validation / DoS prevention
			if (!text || typeof text !== "string" || !text.trim() || text.trim().length > MAX_MESSAGE_LENGTH) {
				return callback?.({ error: "Invalid data" });
			}

			try {
				// Rate limiting: per-user sliding window
				try {
					const now = Date.now();
					const arrival = sendRate.get(socket.userId) || [];
					const minTs = now - RATE_LIMIT_WINDOW_MS;
					const recent = arrival.filter((t) => t > minTs);
					recent.push(now);
					sendRate.set(socket.userId, recent);
					if (recent.length > RATE_LIMIT_MAX) {
						return callback?.({ error: "Rate limit exceeded" });
					}
				} catch (e) {
					// rate limiting must not crash handler
					console.error("rate limit check failed", e);
				}

				if (!(await _isMember(convId))) {
					return callback?.({ error: "Forbidden" });
				}

				// Encrypt message before persisting. Do NOT store plaintext.
				const plaintext = text.trim();
				const dek = generateDEK();
				const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);
				const keyId = "v1"; // KEK version
				const wrappedDek = wrapDEK(dek, keyId);

				// encrypt replyToText and forwardedText (store as JSON string) using same DEK
				let replyToTextEncrypted = null;
				let forwardedTextEncrypted = null;
				if (replyToText && typeof replyToText === 'string' && replyToText.trim()) {
					const r = encryptMessage(replyToText.trim(), dek);
					replyToTextEncrypted = JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
				}
				if (forwardedText && typeof forwardedText === 'string' && forwardedText.trim()) {
					const f = encryptMessage(forwardedText.trim(), dek);
					forwardedTextEncrypted = JSON.stringify({ c: f.ciphertext, iv: f.iv, t: f.authTag });
				}

				const message = await prisma.message.create({
					data: {
						conversationId: convId,
						senderId: socket.userId,
						text: null,
						ciphertext,
						iv,
						auth_tag: authTag,
						wrapped_dek: wrappedDek,
						key_id: keyId,
						...(replyToId && { replyToId }),
						...(replyToName && { replyToName }),
						...(replyToTextEncrypted && { replyToText: replyToTextEncrypted }),
						...(forwardedTextEncrypted && { forwardedText: forwardedTextEncrypted }),
						...(forwardedFrom && { forwardedFrom }),
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

				// Build sanitized payload to broadcast (do not send ciphertext/wrapped_dek)
				// Decrypt replyToText (if any) using the same DEK used for this message
				let replyToTextPlain = null;
				if (replyToText && typeof replyToText === 'string' && replyToText.trim()) {
					replyToTextPlain = replyToText.trim();
				} else if (message.replyToText) {
					try {
						const parsed = JSON.parse(message.replyToText);
						if (parsed && parsed.c && parsed.iv && parsed.t) {
							try {
								replyToTextPlain = decryptMessage(parsed.c, parsed.iv, parsed.t, dek);
							} catch (e) {
								console.error('failed to decrypt replyToText', message.id, e && e.message ? e.message : e);
								replyToTextPlain = 'Message unavailable';
							}
						} else {
							replyToTextPlain = message.replyToText;
						}
					} catch (e) {
						replyToTextPlain = message.replyToText;
					}
				}
				// Decrypt forwardedText (if any) using same DEK
				let forwardedTextPlain = null;
				if (forwardedText && typeof forwardedText === 'string' && forwardedText.trim()) {
					forwardedTextPlain = forwardedText.trim();
				} else if (message.forwardedText) {
					try {
						const parsedF = JSON.parse(message.forwardedText);
						if (parsedF && parsedF.c && parsedF.iv && parsedF.t) {
							try {
								forwardedTextPlain = decryptMessage(parsedF.c, parsedF.iv, parsedF.t, dek);
							} catch (e) {
								console.error('failed to decrypt forwardedText', message.id, e && e.message ? e.message : e);
								forwardedTextPlain = 'Message unavailable';
							}
						} else {
							forwardedTextPlain = message.forwardedText;
						}
					} catch (e) {
						forwardedTextPlain = message.forwardedText;
					}
					}

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
					replyToId: message.replyToId,
					replyToName: message.replyToName,
					replyToText: replyToTextPlain,
					forwardedText: forwardedTextPlain,
					forwardedFrom: message.forwardedFrom,
					createdAt: message.createdAt,
				};

				// Self-conversation (Saved Messages) — skip unread increment
				const isSelfConversation =
					(await prisma.conversationMember.count({ where: { conversationId: convId } })) === 1;
				if (isSelfConversation) {
					socket.to(`conversation:${convId}`).emit("message:new", safe);
					return callback?.({ success: true, message: safe });
				}

				const allRecipients = await getRecipientsCached(convId);
				const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);

				// Use in-memory map of users present in conversation to avoid expensive fetchSockets()
				const usersInRoom = convoOnline.get(convId) || new Set();

				const toUpdateIds = recipientContacts
					.filter((c) => !usersInRoom.has(c.ownerId))
					.map((c) => c.id);

				if (toUpdateIds.length > 0) {
					// perform unread count update asynchronously so it doesn't block delivery
					prisma.contact
						.updateMany({
							where: { id: { in: toUpdateIds } },
							data: { unreadCount: { increment: 1 } },
						})
						.catch((e) => console.error("update unread failed", e));
				}

				socket.to(`conversation:${convId}`).emit("message:new", safe);

				// Also deliver the message directly to connected sockets belonging to
				// recipients who are not actively joined to the conversation room
				// (handles case where a user was just added to contacts server-side).
				try {
					const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
					for (const uid of recipientUserIds) {
						if (usersInRoom.has(uid)) continue;
						const sidSet = userSockets.get(uid) || new Set();
						for (const sid of sidSet) {
							const s = io.sockets.sockets.get(sid);
							if (s) {
								s.emit("message:new", safe);
							}
						}
					}
					// Also trigger web-push for recipients not in the conversation room
					try {
						const recipientUserIdsSet = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
						const offlineTargetIds = recipientUserIdsSet.filter((uid) => {
							// Only consider user offline if not present in room and no active sockets
							const hasSockets = userSockets.has(uid) && userSockets.get(uid).size > 0;
							return !usersInRoom.has(uid) && !hasSockets;
						});
						for (const uid of offlineTargetIds) {
							// fire-and-forget: suppress push errors to avoid noisy logs
							push.sendNotificationToUser(uid, {
								title: message.sender?.name || 'New message',
								body: 'New message',
								data: { conversationId: convId },
							}).catch(() => {
								/* push error suppressed */
							});
						}
					} catch (e) {
						// push notify failed (suppressed)
					}
				} catch (e) {
					console.error("deliver direct message to offline-room sockets failed", e);
				}

				callback?.({ success: true, message: safe });
			} catch (err) {
				console.error(err);
				callback?.({ error: "Server error" });
			}
		});

		// ─── Edit message ──────────────────────────────────────────────────────
		socket.on("message:edit", async (data, callback) => {
			const { messageId, text } = data;
			const msgId = parseIntSafe(messageId);
			if (!msgId) return callback?.({ error: "Invalid messageId" });
			try {
			if (!text || typeof text !== "string" || !text.trim() || text.trim().length > MAX_MESSAGE_LENGTH) {
				return callback?.({ error: "Invalid data" });
			}
				const message = await prisma.message.findUnique({
					where: { id: msgId },
				});

				if (!message || message.senderId !== socket.userId) {
					return callback?.({ error: "Forbidden" });
				}

				// Encrypt edited text and update encrypted columns
				const plaintext = text.trim();
				const dek = generateDEK();
				const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);
				const keyId = "v1";
				const wrappedDek = wrapDEK(dek, keyId);

				const updated = await prisma.message.update({
					where: { id: msgId },
					data: {
						text: null,
						ciphertext,
						iv,
						auth_tag: authTag,
						wrapped_dek: wrappedDek,
						key_id: keyId,
						isEdited: true,
					},
				});

				// Emit edit to room with plaintext only
				socket.to(`conversation:${message.conversationId}`).emit("message:edited", {
					messageId: msgId,
					text: plaintext,
					isEdited: true,
				});

				// Also deliver edited event directly to connected sockets of recipients
				try {
					const allRecipients = await getRecipientsCached(message.conversationId);
					const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
					const usersInRoom = convoOnline.get(message.conversationId) || new Set();
					const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
					for (const uid of recipientUserIds) {
						if (usersInRoom.has(uid)) continue;
						const sidSet = userSockets.get(uid) || new Set();
						for (const sid of sidSet) {
							const s = io.sockets.sockets.get(sid);
							if (s) {
								s.emit('message:edited', { messageId: msgId, text: plaintext, isEdited: true });
							}
						}
					}
				} catch (e) {
					console.error('deliver edit to direct sockets failed', e);
				}

				callback?.({ success: true });
			} catch (err) {
				console.error(err);
				callback?.({ error: "Server error" });
			}
		});

		// ─── Delete message ────────────────────────────────────────────────────
		socket.on("message:delete", async (data, callback) => {
			const { messageId } = data;
			const msgId = parseIntSafe(messageId);
			if (!msgId) return callback?.({ error: "Invalid messageId" });

			try {
				const message = await prisma.message.findUnique({
					where: { id: msgId },
				});

				if (!message || message.senderId !== socket.userId) {
					return callback?.({ error: "Forbidden" });
				}

				await prisma.message.update({
					where: { id: msgId },
					data: { isDeleted: true },
				});

				// If the message was not seen by recipients, decrement their unread counts
				// so contact previews stay in sync. This mirrors the increment logic
				// used when messages are sent.
				try {
					if (!message.isSeen) {
						const allRecipients = await getRecipientsCached(message.conversationId);
						const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
						if (recipientContacts.length > 0) {
							await prisma.contact.updateMany({
								where: { id: { in: recipientContacts.map((c) => c.id) }, unreadCount: { gt: 0 } },
								data: { unreadCount: { decrement: 1 } },
							});
						}
					}
				} catch (e) {
					console.error('decrement unread on delete failed', e);
				}

				// Emit to entire conversation room (include sender's other sockets)
				io.to(`conversation:${message.conversationId}`).emit(
					"message:deleted",
					{
						messageId: msgId,
					},
				);

				// Also deliver delete event directly to connected sockets of recipients
				try {
					const allRecipients = await getRecipientsCached(message.conversationId);
					const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
					const usersInRoom = convoOnline.get(message.conversationId) || new Set();
					const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
					for (const uid of recipientUserIds) {
						if (usersInRoom.has(uid)) continue;
						const sidSet = userSockets.get(uid) || new Set();
						for (const sid of sidSet) {
							const s = io.sockets.sockets.get(sid);
							if (s) {
								s.emit('message:deleted', { messageId: msgId });
							}
						}
					}
				} catch (e) {
					console.error('deliver deleted to direct sockets failed', e);
				}

				callback?.({ success: true });
			} catch (err) {
				console.error(err);
				callback?.({ error: "Server error" });
			}
		});

		// ─── Pin/Unpin message ─────────────────────────────────────────────────
		socket.on("message:pin", async ({ messageId }, callback) => {
			const msgId = parseIntSafe(messageId);
			if (!msgId) return callback?.({ error: "Invalid messageId" });
			try {
				const message = await prisma.message.findUnique({
					where: { id: msgId },
				});
				if (!message) return callback?.({ error: "Not found" });

				if (!(await _isMember(message.conversationId))) return callback?.({ error: "Forbidden" });

				const updated = await prisma.message.update({
					where: { id: msgId },
					data: { isPinned: !message.isPinned },
				});

				socket.to(`conversation:${message.conversationId}`).emit(
					"message:pinned",
					{
						messageId: msgId,
						isPinned: updated.isPinned,
					},
				);

				// Also deliver pinned event directly to connected sockets of recipients
				try {
					const allRecipients = await getRecipientsCached(message.conversationId);
					const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
					const usersInRoom = convoOnline.get(message.conversationId) || new Set();
					const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
					for (const uid of recipientUserIds) {
						if (usersInRoom.has(uid)) continue;
						const sidSet = userSockets.get(uid) || new Set();
						for (const sid of sidSet) {
							const s = io.sockets.sockets.get(sid);
							if (s) {
								s.emit('message:pinned', { messageId: msgId, isPinned: updated.isPinned });
							}
						}
					}
				} catch (e) {
					console.error('deliver pin to direct sockets failed', e);
				}

				callback?.({ success: true, isPinned: updated.isPinned });
			} catch (err) {
				callback?.({ error: "Server error" });
			}
		});

			// ─── Add/toggle reaction ────────────────────────────────────────────────────
			socket.on("reaction:add", async ({ messageId, emoji }, callback) => {
				try {
					if (!messageId || !emoji || typeof emoji !== "string" || emoji.length > 10) {
						return callback?.({ error: "Invalid data" });
					}

					const msgId = parseIntSafe(messageId);
					if (!msgId) return callback?.({ error: "Invalid messageId" });

					const message = await prisma.message.findUnique({
						where: { id: msgId },
						select: { id: true, conversationId: true, senderId: true },
					});
					if (!message) return callback?.({ error: "Message not found" });

					// verify membership
					const member = await prisma.conversationMember.findFirst({
						where: { conversationId: message.conversationId, userId: socket.userId },
					});
					if (!member) return callback?.({ error: "Forbidden" });

					// upsert: one reaction per user per message
					const existing = await prisma.messageReaction.findUnique({
						where: { messageId_userId: { messageId: msgId, userId: socket.userId } },
					});

					let reaction;
					let action;

					if (existing && existing.emoji === emoji) {
						// same emoji → remove (toggle off)
						await prisma.messageReaction.delete({
							where: { messageId_userId: { messageId: msgId, userId: socket.userId } },
						});
						reaction = null;
						action = "removed";
					} else {
						// different emoji or new → upsert
						reaction = await prisma.messageReaction.upsert({
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

					const payload = { messageId: msgId, reactions: allReactions, actorId: socket.userId, emoji, action };

					// broadcast to ALL in conversation (including sender)
					io.to(`conversation:${message.conversationId}`).emit("reaction:updated", payload);

					// Also deliver reaction update to connected sockets that are not joined
					// to the conversation room (matches message delivery behavior).
					try {
						const allRecipients = await getRecipientsCached(message.conversationId);
						const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
						const usersInRoom = convoOnline.get(message.conversationId) || new Set();
						const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
						for (const uid of recipientUserIds) {
							if (usersInRoom.has(uid)) continue;
							const sidSet = userSockets.get(uid) || new Set();
							for (const sid of sidSet) {
								const s = io.sockets.sockets.get(sid);
								if (s) {
									try { s.emit("reaction:updated", payload); } catch (e) { /* ignore per-socket errors */ }
								}
							}
						}
					} catch (e) {
						console.error('deliver reaction to direct sockets failed', e);
					}

					// Logging suppressed in production: reaction event handled

					// Send silent web-push to recipients who are offline / not in-room
					try {
						const allRecipients = await getRecipientsCached(message.conversationId);
						const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
						const usersInRoom = convoOnline.get(message.conversationId) || new Set();
						const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
						const offlineTargetIds = recipientUserIds.filter((uid) => {
							const hasSockets = userSockets.has(uid) && userSockets.get(uid).size > 0;
							return !usersInRoom.has(uid) && !hasSockets;
						});

						if (offlineTargetIds.length > 0) {
							let actorName = 'Someone';
							try {
								const actor = await prisma.user.findUnique({ where: { id: socket.userId }, select: { name: true } });
								if (actor?.name) actorName = actor.name;
							} catch (e) {
								/* ignore */
							}

							for (const uid of offlineTargetIds) {
								push.sendNotificationToUser(uid, {
									title: actorName,
									body: `reacted ${emoji}`,
									data: { conversationId: message.conversationId },
								}).catch(() => { /* suppress push errors */ });
							}
						}
					} catch (e) {
						console.error('reaction:push error', e);
					}

					callback?.({ success: true, action, reactions: allReactions });
				} catch (err) {
					console.error("reaction:add error", err);
					callback?.({ error: "Server error" });
				}
			});

		// ─── Typing ────────────────────────────────────────────────────────────
		socket.on("typing:start", ({ conversationId }) => {
			const convId = parseIntSafe(conversationId);
			if (!convId) return;
			// ensure sender is a member of the conversation before emitting
			(async () => {
				try {
					// throttle typing events per-socket per-conversation to avoid spam
					const THROTTLE_MS = parseInt(process.env.TYPING_THROTTLE_MS || "500", 10);
					const now = Date.now();
					const last = socket._lastTyping.get(convId) || 0;
					if (now - last < THROTTLE_MS) return;
					socket._lastTyping.set(convId, now);
					if (!(await _isMember(convId))) return;
					socket.to(`conversation:${convId}`).emit("typing:start", {
						userId: socket.userId,
						conversationId: convId,
					});

					// also deliver typing start to connected sockets not joined to the room
					try {
						const allRecipients = await getRecipientsCached(convId);
						const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
						const usersInRoom = convoOnline.get(convId) || new Set();
						const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
						for (const uid of recipientUserIds) {
							if (usersInRoom.has(uid)) continue;
							const sidSet = userSockets.get(uid) || new Set();
							for (const sid of sidSet) {
								const s = io.sockets.sockets.get(sid);
								if (s) s.emit('typing:start', { userId: socket.userId, conversationId: convId });
							}
						}
					} catch (e) {
						console.error('deliver typing:start to direct sockets failed', e);
					}
				} catch (e) {
					console.error('typing:start auth check failed', e);
				}
			})();
		});

		socket.on("typing:stop", ({ conversationId }) => {
			const convId = parseIntSafe(conversationId);
			if (!convId) return;
			// ensure sender is a member of the conversation before emitting
			(async () => {
				try {
					// throttle typing stop events to avoid spam
					const THROTTLE_MS = parseInt(process.env.TYPING_THROTTLE_MS || "500", 10);
					const now = Date.now();
					const last = socket._lastTyping.get(convId) || 0;
					if (now - last < THROTTLE_MS) return;
					socket._lastTyping.set(convId, now);
					if (!(await _isMember(convId))) return;
					socket.to(`conversation:${convId}`).emit("typing:stop", {
						userId: socket.userId,
						conversationId: convId,
					});

					// also deliver typing stop to connected sockets not joined to the room
					try {
						const allRecipients = await getRecipientsCached(convId);
						const recipientContacts = allRecipients.filter((c) => c.ownerId !== socket.userId);
						const usersInRoom = convoOnline.get(convId) || new Set();
						const recipientUserIds = Array.from(new Set(recipientContacts.map((c) => c.ownerId)));
						for (const uid of recipientUserIds) {
							if (usersInRoom.has(uid)) continue;
							const sidSet = userSockets.get(uid) || new Set();
							for (const sid of sidSet) {
								const s = io.sockets.sockets.get(sid);
								if (s) s.emit('typing:stop', { userId: socket.userId, conversationId: convId });
							}
						}
					} catch (e) {
						console.error('deliver typing:stop to direct sockets failed', e);
					}
				} catch (e) {
					console.error('typing:stop auth check failed', e);
				}
			})();
		});

		// ─── Disconnect ────────────────────────────────────────────────────────
			socket.on("disconnect", async () => {
				// disconnect logged (suppressed)

			const lastSeen = new Date();
			try {
				// remove this socket from the user's socket set immediately so
				// we can determine whether other connections remain
				try {
					const sset = userSockets.get(socket.userId);
					if (sset) {
						sset.delete(socket.id);
						if (sset.size === 0) userSockets.delete(socket.userId);
						else userSockets.set(socket.userId, sset);
					}
				} catch (e) {
					console.error('userSockets cleanup failed', e);
				}

				const remaining = userSockets.get(socket.userId);
				if (!remaining || remaining.size === 0) {
					// Schedule a debounced offline update to avoid flapping on
					// transient disconnects (e.g., mobile network handoffs).
					if (offlineTimers.has(socket.userId)) {
						// already scheduled
					} else {
						const timer = setTimeout(async () => {
							try {
								const still = userSockets.get(socket.userId);
								if (!still || still.size === 0) {
									const updated = await prisma.user.update({
										where: { id: socket.userId },
										data: {
											isOnline: false,
											lastSeen,
										},
										select: { privacyOnline: true },
									});
									try {
										io.emit("user:offline", {
											userId: socket.userId,
											lastSeen,
											privacyOnline: updated.privacyOnline,
										});
									} catch (e) {
										/* ignore broadcast failures */
									}
								}
							} catch (e) {
								console.error('deferred disconnect update failed', e);
								try {
									io.emit("user:offline", {
										userId: socket.userId,
										lastSeen,
										privacyOnline: null,
									});
								} catch (_) { /* ignore */ }
							} finally {
								offlineTimers.delete(socket.userId);
							}
						}, OFFLINE_GRACE_MS);
						offlineTimers.set(socket.userId, timer);
					}
				} else {
					// user still has other active sockets; do not mark offline
				}
			} catch (e) {
				console.error('disconnect handler error', e);
				// best-effort: if we couldn't update DB, still emit basic offline info
				socket.broadcast.emit("user:offline", {
					userId: socket.userId,
					lastSeen,
					privacyOnline: null,
				});
			} finally {
				// cleanup per-user rate tracking if no sockets remain for this user
				try {
					const remaining = userSockets.get(socket.userId);
					if (!remaining || remaining.size === 0) sendRate.delete(socket.userId);
				} catch (e) {
					// ignore
				}

				// cleanup in-memory convo presence for this socket; only remove the
				// user from a conversation if no other connected socket for this
				// user remains joined to that conversation
				if (socket.joinedConversations && socket.joinedConversations.size > 0) {
					for (const cid of socket.joinedConversations) {
						const set = convoOnline.get(cid);
						if (!set) continue;
						let stillPresent = false;
						const otherSids = userSockets.get(socket.userId) || new Set();
						for (const sid of otherSids) {
							const s = io.sockets.sockets.get(sid);
							if (s && s.joinedConversations && s.joinedConversations.has(cid)) {
								stillPresent = true;
								break;
							}
						}
						if (!stillPresent) {
							set.delete(socket.userId);
							if (set.size === 0) convoOnline.delete(cid);
							else convoOnline.set(cid, set);
						}
					}
				}
			}
		});

		// ─── Message seen ───────────────────────────────────────────────────────
		socket.on("message:seen", async ({ conversationId }, callback) => {
			const convId = parseIntSafe(conversationId);
			if (!convId) return callback?.({ success: true, marked: [] });
			try {
				if (!(await _isMember(convId))) return; // user is not a member of this conversation

				// Only allow marking messages as seen if this socket explicitly
				// joined the conversation (prevents other tabs/sockets from auto-seeing)
				if (!socket.joinedConversations || !socket.joinedConversations.has(convId)) {
					return callback?.({ success: true, marked: [] });
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

					try {
						await prisma.contact.updateMany({ where: { conversationId: convId, ownerId: socket.userId }, data: { unreadCount: 0 } });
					} catch (e) {
						console.error('update unread failed', e);
					}

					// emit per-batch so clients can update progressively
					socket.to(`conversation:${convId}`).emit("message:seen", {
						conversationId: convId,
						messageIds: ids,
						seenBy: socket.userId,
					});

					totalMarked.push(...ids);
					if (totalMarked.length >= MAX_COLLECT) {
						console.warn(`message:seen truncated at ${MAX_COLLECT} ids for conv=${convId} user=${socket.userId}`);
						break;
					}

					if (toMark.length < BATCH_SIZE) break;
				}

				if (totalMarked.length > 0) {
					callback?.({ success: true, marked: totalMarked.length <= MAX_COLLECT ? totalMarked : undefined, markedCount: totalMarked.length });
				} else {
					callback?.({ success: true, marked: [] });
				}
			} catch (err) {
				console.error("message:seen handler error", err);
				callback?.({ error: "Server error" });
			}
		});

		socket.on("conversation:join", async ({ conversationId }) => {
			const convId = parseIntSafe(conversationId);
			if (!convId) return;
			try {
				if (!(await _isMember(convId))) return;
					socket.join(`conversation:${convId}`);
					socket.joinedConversations = socket.joinedConversations || new Set();
					socket.joinedConversations.add(convId);
					const set = convoOnline.get(convId) || new Set();
					set.add(socket.userId);
					convoOnline.set(convId, set);
			} catch (e) {
				console.error("conversation:join error", e);
			}
		});

		// Allow clients to explicitly leave a conversation room when they close it.
		socket.on("conversation:leave", async ({ conversationId }) => {
			const convId = parseIntSafe(conversationId);
			if (!convId) return;
			try {
				if (!socket.joinedConversations || !socket.joinedConversations.has(convId)) return;
				socket.leave(`conversation:${convId}`);
				socket.joinedConversations.delete(convId);
				const set = convoOnline.get(convId);
				if (set) {
					// If the user has other sockets, only remove their presence if
					// none of the other sockets remain joined to this conversation.
					const otherSids = userSockets.get(socket.userId) || new Set();
					let stillPresent = false;
					for (const sid of otherSids) {
						if (sid === socket.id) continue;
						const s = io.sockets.sockets.get(sid);
						if (s && s.joinedConversations && s.joinedConversations.has(convId)) {
							stillPresent = true;
							break;
						}
					}
					if (!stillPresent) {
						set.delete(socket.userId);
						if (set.size === 0) convoOnline.delete(convId);
						else convoOnline.set(convId, set);
					}
				}
			} catch (e) {
				console.error("conversation:leave error", e);
			}
		});
	});

	// Expose io instance so HTTP route handlers can broadcast events when
	// users update their profile (avatar/name/etc.). This keeps the
	// change small and avoids large refactors to pass `io` through.
	try {
		globalThis.__rivo_io = io;
	} catch (e) {
		// ignore if environment doesn't allow globalThis assignment
	}

	return io;
}