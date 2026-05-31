import prisma from "../prisma.js";
import { unwrapDEK, decryptMessage } from "../utils/encryption.js";
import push from "../utils/push.js";

export async function openDueCapsules(io) {
	const now = new Date();
	try {
		const due = await prisma.message.findMany({
			where: {
				isTimeCapsule: true,
				openedAt: null,
				isDeleted: false,
				scheduledFor: { lte: now },
			},
		});

		if (!due || due.length === 0) return;

		for (const msg of due) {
			// Attempt atomic update: only set openedAt if still null
			const updated = await prisma.message.updateMany({
				where: { id: msg.id, openedAt: null, isDeleted: false },
				data: { openedAt: now },
			});
			if (!updated || updated.count === 0) {
				// someone else already opened it
				continue;
			}

			let text = "";
			try {
				if (msg.ciphertext && msg.wrapped_dek) {
					const dek = unwrapDEK(msg.wrapped_dek, msg.key_id || "v1");
					text = decryptMessage(msg.ciphertext, msg.iv, msg.auth_tag, dek);
				} else if (msg.text) {
					text = msg.text;
				}
			} catch (e) {
				console.error('failed to decrypt time capsule', msg.id, e);
				text = "";
			}

			const roomName = `conversation:${msg.conversationId}`;
			const payload = {
				messageId: msg.id,
				conversationId: msg.conversationId,
				text,
				openedAt: now.toISOString(),
			};
			// Emit to the conversation room first
			io.to(roomName).emit("message:capsule:opened", payload);

			// Also attempt to deliver to connected sockets not joined to the room
			try {
				const members = await prisma.conversationMember.findMany({ where: { conversationId: msg.conversationId }, select: { userId: true } });
				for (const m of members) {
					const uid = m.userId;
					if (uid === msg.senderId) continue; // skip sender
					let deliveredToSocket = false;
					for (const s of io.sockets.sockets.values()) {
						try {
							if (s.userId === uid) {
								// if socket is not in room, send directly
								if (!(s.rooms && s.rooms.has(roomName))) {
									s.emit('message:capsule:opened', payload);
								}
								deliveredToSocket = true;
							}
						} catch (e) {
							/* ignore */
						}
					}
					// If user had no active socket receives, fallback to push
					if (!deliveredToSocket) {
						try {
							await push.sendNotificationToUser(uid, {
								title: 'Time capsule unlocked',
								body: 'A time capsule in your chat has been unlocked. Open the app to view.',
								data: { conversationId: msg.conversationId, messageId: msg.id, url: `/?conversationId=${msg.conversationId}&messageId=${msg.id}` },
							});
						} catch (e) {
							/* suppress push errors */
						}
					}
				}
			} catch (e) {
				console.error('openDueCapsules delivery failed', e);
			}
		}
	} catch (e) {
		console.error('openDueCapsules error', e);
	}
}
