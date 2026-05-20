import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import push from "../utils/push.js";
import { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage } from "../utils/encryption.js";
import { parseIntSafe, MAX_MESSAGE_LENGTH } from "../utils/validators.js";

export function initSocket(httpServer) {
	const allowedOrigins = new Set([
		"http://localhost:3000",
		"http://127.0.0.1:3000",
		"https://rivo.ir",
		"https://www.rivo.ir",
		"https://chat.rivo.ir",
	]);
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

	// Simple per-socket rate limiter: Map<socketId, Array<timestamp>>
	const sendRate = new Map();
	const RATE_LIMIT_WINDOW_MS = parseInt(process.env.SOCKET_RATE_WINDOW_MS || "10000"); // 10s
	const RATE_LIMIT_MAX = parseInt(process.env.SOCKET_RATE_MAX || "20"); // max messages per window

	// ─── Auth middleware ───────────────────────────────────────────────────────
	io.use(async (socket, next) => {
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
		try {
			// connection logged (suppressed in production)
			await prisma.user.update({
				where: { id: socket.userId },
				data: { isOnline: true },
			});
			// Do not auto-join conversation rooms on connect. Clients should
			// explicitly join a conversation when the user opens that chat.
			socket.joinedConversations = new Set();
			// track this socket under the user's connected sockets
			const us = userSockets.get(socket.userId) || new Set();
			us.add(socket.id);
			userSockets.set(socket.userId, us);

			// If there was a pending offline timer for this user, clear it.
			if (offlineTimers.has(socket.userId)) {
				clearTimeout(offlineTimers.get(socket.userId));
				offlineTimers.delete(socket.userId);
			}
			// init rate tracking for this socket
			sendRate.set(socket.id, []);
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
				// Rate limiting: simple sliding window per-socket
				try {
					const now = Date.now();
					const arrival = sendRate.get(socket.id) || [];
					const minTs = now - RATE_LIMIT_WINDOW_MS;
					const recent = arrival.filter((t) => t > minTs);
					recent.push(now);
					sendRate.set(socket.id, recent);
					if (recent.length > RATE_LIMIT_MAX) {
						return callback?.({ error: "Rate limit exceeded" });
					}
				} catch (e) {
					// rate limiting must not crash handler
					console.error("rate limit check failed", e);
				}

				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId: convId,
						userId: socket.userId,
					},
				});

				if (!member) {
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

				const recipientContacts = await prisma.contact.findMany({
					where: { conversationId: convId, ownerId: { not: socket.userId } },
					select: { id: true, ownerId: true },
				});

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
					const recipientContacts = await prisma.contact.findMany({
						where: { conversationId: message.conversationId, ownerId: { not: socket.userId } },
						select: { ownerId: true },
					});
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
						const recipientContacts = await prisma.contact.findMany({
							where: { conversationId: message.conversationId, ownerId: { not: socket.userId } },
							select: { id: true },
						});
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
					const recipientContacts = await prisma.contact.findMany({
						where: { conversationId: message.conversationId, ownerId: { not: socket.userId } },
						select: { ownerId: true },
					});
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

				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId: message.conversationId,
						userId: socket.userId,
					},
				});
				if (!member) return callback?.({ error: "Forbidden" });

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
					const recipientContacts = await prisma.contact.findMany({
						where: { conversationId: message.conversationId, ownerId: { not: socket.userId } },
						select: { ownerId: true },
					});
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

		// ─── Typing ────────────────────────────────────────────────────────────
		socket.on("typing:start", ({ conversationId }) => {
			const convId = parseIntSafe(conversationId);
			if (!convId) return;
			// ensure sender is a member of the conversation before emitting
			(async () => {
				try {
					const member = await prisma.conversationMember.findFirst({
						where: { conversationId: convId, userId: socket.userId },
					});
					if (!member) return;
					socket.to(`conversation:${convId}`).emit("typing:start", {
						userId: socket.userId,
						conversationId: convId,
					});

					// also deliver typing start to connected sockets not joined to the room
					try {
						const recipientContacts = await prisma.contact.findMany({
							where: { conversationId: convId, ownerId: { not: socket.userId } },
							select: { ownerId: true },
						});
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
					const member = await prisma.conversationMember.findFirst({
						where: { conversationId: convId, userId: socket.userId },
					});
					if (!member) return;
					socket.to(`conversation:${convId}`).emit("typing:stop", {
						userId: socket.userId,
						conversationId: convId,
					});

					// also deliver typing stop to connected sockets not joined to the room
					try {
						const recipientContacts = await prisma.contact.findMany({
							where: { conversationId: convId, ownerId: { not: socket.userId } },
							select: { ownerId: true },
						});
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
				// cleanup per-socket rate tracking
				sendRate.delete(socket.id);

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
				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId: convId,
						userId: socket.userId,
					},
				});
				if (!member) return; // user is not a member of this conversation

				// Only allow marking messages as seen if this socket explicitly
				// joined the conversation (prevents other tabs/sockets from auto-seeing)
				if (!socket.joinedConversations || !socket.joinedConversations.has(convId)) {
					return callback?.({ success: true, marked: [] });
				}

				// find message ids that will be marked as seen (messages sent by others to this socket)
				const toMark = await prisma.message.findMany({
					where: {
						conversationId: convId,
						senderId: { not: socket.userId },
						isSeen: false,
					},
					select: { id: true },
				});

				if (toMark.length > 0) {
					await prisma.message.updateMany({
						where: { id: { in: toMark.map((m) => m.id) } },
						data: { isSeen: true },
					});

					await prisma.contact.updateMany({
						where: {
							conversationId: convId,
							ownerId: socket.userId,
						},
						data: { unreadCount: 0 },
					});

					// notify other participants only when there are messages actually marked as seen
					socket
						.to(`conversation:${convId}`)
						.emit("message:seen", {
							conversationId: convId,
							messageIds: toMark.map((m) => m.id),
							seenBy: socket.userId,
						});

					callback?.({ success: true, marked: toMark.map((m) => m.id) });
				}
			else {
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
				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId: convId,
						userId: socket.userId,
					},
					});
					if (!member) return;
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