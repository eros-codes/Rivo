// Opens time capsules whose time has come (runs every 30 seconds).
import prisma from "../prisma.js";
import push from "../utils/push.js";
import { envNumber } from "../config.js";
import { loadReplySenders, serializeMessage } from "../utils/messageView.js";
import { getRecipientsCached } from "../services/caches.js";
import { deliverToConversation, hasVisibleSocket } from "../realtime/registry.js";
import { log } from "../utils/logger.js";

const BATCH = envNumber("OPEN_CAPSULES_BATCH_SIZE", 50);
let running = false;

export async function openDueCapsules() {
	// a slow run must not overlap the next tick
	if (running) return;
	running = true;
	try {
		const now = new Date();
		const due = await prisma.message.findMany({
			where: { isTimeCapsule: true, openedAt: null, isDeleted: false, scheduledFor: { lte: now } },
			take: BATCH,
			orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
			include: { reactions: { select: { userId: true, emoji: true }, orderBy: { id: "asc" } } },
		});
		let opened = 0;
		for (const msg of due) {
			// only if nobody opened it meanwhile
			const r = await prisma.message.updateMany({ where: { id: msg.id, openedAt: null, isDeleted: false }, data: { openedAt: now, updatedAt: now } });
			if (!r.count) continue;
			opened++;
			const message = { ...msg, openedAt: now, updatedAt: now };
			const replySenders = await loadReplySenders([message]);
			// every device of both people, each with the message as they may see it
			await deliverToConversation(msg.conversationId, "message:capsule:opened", null, {
				perUser: (uid) => {
					const view = serializeMessage(message, uid, { now, replySenders });
					return {
						messageId: msg.id,
						conversationId: msg.conversationId,
						senderId: msg.senderId,
						text: view.text,
						openedAt: now.toISOString(),
						message: view,
					};
				},
			}).catch((e) => log.error("capsule delivery failed", e?.message || e));

			try {
				const rows = await getRecipientsCached(msg.conversationId);
				const notified = new Set();
				for (const row of rows) {
					const uid = row.ownerId;
					if (uid === msg.senderId || notified.has(uid) || row.isMuted || row.isBlocked) continue;
					notified.add(uid);
					if (hasVisibleSocket(uid)) continue;
					push
						.sendNotificationToUser(uid, {
							title: row.nickname || "Time capsule unlocked",
							body: "A time capsule in your chat was unlocked. Open the app to read it.",
							data: {
								conversationId: msg.conversationId,
								messageId: msg.id,
								url: `/chat/?conversationId=${msg.conversationId}&messageId=${msg.id}`,
							},
							tag: `conversation-${msg.conversationId}`,
						})
						.catch(() => {});
				}
			} catch (e) {
				log.error("capsule notification failed", e?.message || e);
			}
		}
		if (opened > 0) log.info(`opened ${opened} time capsule(s)${due.length === BATCH ? " (more next run)" : ""}`);
	} catch (e) {
		log.error("openDueCapsules failed", e);
	} finally {
		running = false;
	}
}
