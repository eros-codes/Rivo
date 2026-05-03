import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

export function initSocket(httpServer) {
	const allowedOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
	const io = new Server(httpServer, {
		cors: {
			origin: (origin, cb) => {
				if (!origin) return cb(null, true);
				cb(null, allowedOrigins.has(origin) ? origin : false);
			},
			credentials: true,
		},
	});

	const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || "2000");
	// Map<conversationId, Set<userId>> of users currently in each conversation room
	const convoOnline = new Map();

	// Map<userId, Set<socketId>> for quick targeting of a user's connected sockets
	const userSockets = new Map();

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
			console.log(`User ${socket.userId} connected`);
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
					console.error('rate limit check failed', e);
				}

				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId,
						userId: socket.userId,
					},
				});

				if (!member) {
					return callback?.({ error: "Forbidden" });
				}

				const message = await prisma.message.create({
					data: {
						conversationId,
						senderId: socket.userId,
						text: text.trim(),
						...(replyToId && { replyToId }),
						...(replyToName && { replyToName }),
						...(replyToText && { replyToText }),
						...(forwardedFrom && { forwardedFrom }),
						...(forwardedText && { forwardedText }),
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
					where: { id: conversationId },
					data: { lastMessageAt: message.createdAt },
				});


				const recipientContacts = await prisma.contact.findMany({
					where: { conversationId, ownerId: { not: socket.userId } },
					select: { id: true, ownerId: true },
				});

				// Use in-memory map of users present in conversation to avoid expensive fetchSockets()
				const usersInRoom = convoOnline.get(conversationId) || new Set();

				const toUpdateIds = recipientContacts
					.filter((c) => !usersInRoom.has(c.ownerId))
					.map((c) => c.id);

				if (toUpdateIds.length > 0) {
					// perform unread count update asynchronously so it doesn't block delivery
					prisma.contact.updateMany({
						where: { id: { in: toUpdateIds } },
						data: { unreadCount: { increment: 1 } },
					}).catch((e) => console.error('update unread failed', e));
				}

				socket
					.to(`conversation:${conversationId}`)
					.emit("message:new", message);

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
								s.emit("message:new", message);
							}
						}
					}
				} catch (e) {
					console.error('deliver direct message to offline-room sockets failed', e);
				}

				callback?.({ success: true, message });
			} catch (err) {
				console.error(err);
				callback?.({ error: "Server error" });
			}
		});

		// ─── Edit message ──────────────────────────────────────────────────────
		socket.on("message:edit", async (data, callback) => {
			const { messageId, text } = data;
			try {
			if (!text || typeof text !== "string" || !text.trim() || text.trim().length > MAX_MESSAGE_LENGTH) {
				return callback?.({ error: "Invalid data" });
			}
				const message = await prisma.message.findUnique({
					where: { id: messageId },
				});

				if (!message || message.senderId !== socket.userId) {
					return callback?.({ error: "Forbidden" });
				}

				const updated = await prisma.message.update({
					where: { id: messageId },
					data: { text: text.trim(), isEdited: true },
				});

				socket.to(`conversation:${message.conversationId}`).emit(
					"message:edited",
					{
						messageId,
						text: updated.text,
						isEdited: true,
					},
				);

				callback?.({ success: true });
			} catch (err) {
				console.error(err);
				callback?.({ error: "Server error" });
			}
		});

		// ─── Delete message ────────────────────────────────────────────────────
		socket.on("message:delete", async (data, callback) => {
			const { messageId } = data;

			try {
				const message = await prisma.message.findUnique({
					where: { id: messageId },
				});

				if (!message || message.senderId !== socket.userId) {
					return callback?.({ error: "Forbidden" });
				}

				await prisma.message.update({
					where: { id: messageId },
					data: { isDeleted: true },
				});

				socket.to(`conversation:${message.conversationId}`).emit(
					"message:deleted",
					{
						messageId,
					},
				);

				callback?.({ success: true });
			} catch (err) {
				console.error(err);
				callback?.({ error: "Server error" });
			}
		});

		// ─── Pin/Unpin message ─────────────────────────────────────────────────
		socket.on("message:pin", async ({ messageId }, callback) => {
			try {
				const message = await prisma.message.findUnique({
					where: { id: messageId },
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
					where: { id: messageId },
					data: { isPinned: !message.isPinned },
				});

				socket.to(`conversation:${message.conversationId}`).emit(
					"message:pinned",
					{
						messageId,
						isPinned: updated.isPinned,
					},
				);

				callback?.({ success: true, isPinned: updated.isPinned });
			} catch (err) {
				callback?.({ error: "Server error" });
			}
		});

		// ─── Typing ────────────────────────────────────────────────────────────
		socket.on("typing:start", ({ conversationId }) => {
			// ensure sender is a member of the conversation before emitting
			(async () => {
				try {
					const member = await prisma.conversationMember.findFirst({
						where: { conversationId, userId: socket.userId },
					});
					if (!member) return;
					socket.to(`conversation:${conversationId}`).emit("typing:start", {
						userId: socket.userId,
						conversationId,
					});
				} catch (e) {
					console.error('typing:start auth check failed', e);
				}
			})();
		});

		socket.on("typing:stop", ({ conversationId }) => {
			// ensure sender is a member of the conversation before emitting
			(async () => {
				try {
					const member = await prisma.conversationMember.findFirst({
						where: { conversationId, userId: socket.userId },
					});
					if (!member) return;
					socket.to(`conversation:${conversationId}`).emit("typing:stop", {
						userId: socket.userId,
						conversationId,
					});
				} catch (e) {
					console.error('typing:stop auth check failed', e);
				}
			})();
		});

		// ─── Disconnect ────────────────────────────────────────────────────────
		socket.on("disconnect", async () => {
			console.log(`User ${socket.userId} disconnected`);

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
					const updated = await prisma.user.update({
						where: { id: socket.userId },
						data: {
							isOnline: false,
							lastSeen,
						},
						select: { privacyOnline: true },
					});

					socket.broadcast.emit("user:offline", {
						userId: socket.userId,
						lastSeen,
						privacyOnline: updated.privacyOnline,
					});
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
			try {
				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId,
						userId: socket.userId,
					},
				});
				if (!member) return; // user is not a member of this conversation

				// Only allow marking messages as seen if this socket explicitly
				// joined the conversation (prevents other tabs/sockets from auto-seeing)
				if (!socket.joinedConversations || !socket.joinedConversations.has(conversationId)) {
					return callback?.({ success: true, marked: [] });
				}

				// find message ids that will be marked as seen (messages sent by others to this socket)
				const toMark = await prisma.message.findMany({
					where: {
						conversationId,
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
							conversationId,
							ownerId: socket.userId,
						},
						data: { unreadCount: 0 },
					});

					// notify other participants only when there are messages actually marked as seen
					socket
						.to(`conversation:${conversationId}`)
						.emit("message:seen", {
							conversationId,
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
			try {
				const member = await prisma.conversationMember.findFirst({
					where: {
						conversationId,
						userId: socket.userId,
					},
					});
					if (!member) return;
					socket.join(`conversation:${conversationId}`);
					socket.joinedConversations = socket.joinedConversations || new Set();
					socket.joinedConversations.add(conversationId);
					const set = convoOnline.get(conversationId) || new Set();
					set.add(socket.userId);
					convoOnline.set(conversationId, set);
			} catch (e) {
				console.error("conversation:join error", e);
			}
		});

		// Allow clients to explicitly leave a conversation room when they close it.
		socket.on("conversation:leave", async ({ conversationId }) => {
			try {
				if (!socket.joinedConversations || !socket.joinedConversations.has(conversationId)) return;
				socket.leave(`conversation:${conversationId}`);
				socket.joinedConversations.delete(conversationId);
				const set = convoOnline.get(conversationId);
				if (set) {
					// If the user has other sockets, only remove their presence if
					// none of the other sockets remain joined to this conversation.
					const otherSids = userSockets.get(socket.userId) || new Set();
					let stillPresent = false;
					for (const sid of otherSids) {
						if (sid === socket.id) continue;
						const s = io.sockets.sockets.get(sid);
						if (s && s.joinedConversations && s.joinedConversations.has(conversationId)) {
							stillPresent = true;
							break;
						}
					}
					if (!stillPresent) {
						set.delete(socket.userId);
						if (set.size === 0) convoOnline.delete(conversationId);
						else convoOnline.set(conversationId, set);
					}
				}
			} catch (e) {
				console.error("conversation:leave error", e);
			}
		});
	});

	return io;
}