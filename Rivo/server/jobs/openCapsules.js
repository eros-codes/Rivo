import prisma from "../prisma.js";
import { unwrapDEK, decryptMessage } from "../utils/encryption.js";
import push from "../utils/push.js";

// Process due time-capsules in bounded batches to avoid large DB/CPU spikes
const OPEN_CAPSULES_BATCH_SIZE = parseInt(process.env.OPEN_CAPSULES_BATCH_SIZE || "50", 10) || 50;

export async function openDueCapsules(io, userSockets) {
	const now = new Date();
	try {
		const whereClause = {
			isTimeCapsule: true,
			openedAt: null,
			isDeleted: false,
			scheduledFor: { lte: now },
		};

		const totalDue = await prisma.message.count({ where: whereClause });
		if (!totalDue) return;

		// Fetch a bounded batch ordered by scheduled time (oldest first)
		const due = await prisma.message.findMany({
			where: whereClause,
			take: OPEN_CAPSULES_BATCH_SIZE,
			orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
		});

		if (!due || due.length === 0) return;

		let processed = 0;
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

			processed += 1;

			let text = null;
			let decryptionFailed = false;
			try {
				if (msg.ciphertext && msg.wrapped_dek) {
					const dek = unwrapDEK(msg.wrapped_dek, msg.key_id || "v1");
					text = decryptMessage(msg.ciphertext, msg.iv, msg.auth_tag, dek);
				} else if (msg.text) {
					text = msg.text;
				}
			} catch (e) {
				console.error('failed to decrypt time capsule', msg.id, e);
				decryptionFailed = true;
				text = null;
			}

			const roomName = `conversation:${msg.conversationId}`;
			const payload = {
				messageId: msg.id,
				conversationId: msg.conversationId,
				text,
				openedAt: now.toISOString(),
				...(decryptionFailed ? { error: true } : {}),
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
					const sidSet = (userSockets && userSockets.get(uid)) || new Set();
					for (const sid of sidSet) {
						const s = io.sockets.sockets.get(sid);
						if (s) {
							try {
								if (!(s.rooms && s.rooms.has(roomName))) {
									s.emit('message:capsule:opened', payload);
								}
								deliveredToSocket = true;
							} catch (e) {
								/* ignore per-socket errors */
							}
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

		if (totalDue > processed) {
			console.info(`openDueCapsules: processed ${processed}/${totalDue} due capsules (batch size ${OPEN_CAPSULES_BATCH_SIZE}); ${totalDue - processed} remain`);
		} else {
			console.info(`openDueCapsules: processed ${processed} due capsules`);
		}
	} catch (e) {
		console.error('openDueCapsules error', e);
	}
}
