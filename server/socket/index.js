import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

export function initSocket(httpServer) {
	const io = new Server(httpServer, {
		cors: { origin: "*" },
	});

	// ─── Auth middleware ───────────────────────────────────────────────────────
	io.use((socket, next) => {
		const token = socket.handshake.auth?.token;

		if (!token) {
			return next(new Error("Unauthorized"));
		}

		try {
			const payload = jwt.verify(token, process.env.JWT_SECRET);
			socket.userId = payload.userId;
			next();
		} catch {
			return next(new Error("Invalid token"));
		}
	});

	// ─── Connection ───────────────────────────────────────────────────────────
	io.on("connection", async (socket) => {
		console.log(`User ${socket.userId} connected`);

		// show user online
		await prisma.user.update({
			where: { id: socket.userId },
			data: { isOnline: true },
		});

		// join user to all their conversation rooms
		const memberships = await prisma.conversationMember.findMany({
			where: { userId: socket.userId },
			select: { conversationId: true },
		});

		memberships.forEach(({ conversationId }) => {
			socket.join(`conversation:${conversationId}`);
		});

		// notify other users that this user is online
		socket.broadcast.emit("user:online", { userId: socket.userId });

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

			if (!conversationId || !text?.trim()) {
				return callback?.({ error: "Invalid data" });
			}

			try {
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

				const roomSockets = await io
					.in(`conversation:${conversationId}`)
					.fetchSockets();
				const usersInRoom = new Set(roomSockets.map((s) => s.userId));

				for (const contact of recipientContacts) {
					if (!usersInRoom.has(contact.ownerId)) {
						await prisma.contact.update({
							where: { id: contact.id },
							data: { unreadCount: { increment: 1 } },
						});
					}
				}

				socket
					.to(`conversation:${conversationId}`)
					.emit("message:new", message);

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

				io.to(`conversation:${message.conversationId}`).emit(
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

				io.to(`conversation:${message.conversationId}`).emit(
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

				const updated = await prisma.message.update({
					where: { id: messageId },
					data: { isPinned: !message.isPinned },
				});

				io.to(`conversation:${message.conversationId}`).emit(
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
			socket.to(`conversation:${conversationId}`).emit("typing:start", {
				userId: socket.userId,
				conversationId,
			});
		});

		socket.on("typing:stop", ({ conversationId }) => {
			socket.to(`conversation:${conversationId}`).emit("typing:stop", {
				userId: socket.userId,
				conversationId,
			});
		});

		// ─── Disconnect ────────────────────────────────────────────────────────
		socket.on("disconnect", async () => {
			console.log(`User ${socket.userId} disconnected`);

			const lastSeen = new Date();
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
		});

		// ─── Message seen ───────────────────────────────────────────────────────
		socket.on("message:seen", async ({ conversationId }) => {
			try {
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
				}
			} catch (err) {
				console.error("message:seen handler error", err);
			}
		});
	});

	return io;
}