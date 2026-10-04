import prisma from "../prisma.js";
import { decryptBody } from "../utils/messageView.js";
import push from "../utils/push.js";
import { deliverToConversation, getRecipientsCached, hasVisibleSocket } from "../socket/index.js";

// Process due time-capsules in bounded batches to avoid large DB/CPU spikes
const OPEN_CAPSULES_BATCH_SIZE = parseInt(process.env.OPEN_CAPSULES_BATCH_SIZE || "50", 10) || 50;

let _running = false;

// `io` and `userSockets` are accepted for backwards compatibility; delivery
// goes through the shared socket helpers.
// eslint-disable-next-line no-unused-vars
export async function openDueCapsules(_io, _userSockets) {
	// a slow run must not overlap with the next tick
	if (_running) return;
	_running = true;
	const now = new Date();
	try {
		const whereClause = {
			isTimeCapsule: true,
			openedAt: null,
			isDeleted: false,
			scheduledFor: { lte: now },
		};

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

			const body = decryptBody(msg);
			const payload = {
				messageId: msg.id,
				conversationId: msg.conversationId,
				senderId: msg.senderId,
				text: body.ok ? body.text : null,
				openedAt: now.toISOString(),
				...(body.ok ? {} : { error: true }),
			};

			// Every device of both people (the sender sees "Opened" too)
			try {
				await deliverToConversation(msg.conversationId, "message:capsule:opened", payload);
			} catch (e) {
				console.error('openDueCapsules delivery failed', e);
			}

			// Notify recipients who do not have the app open
			try {
				const rows = await getRecipientsCached(msg.conversationId);
				const notified = new Set();
				for (const r of rows) {
					const uid = r.ownerId;
					if (uid === msg.senderId || notified.has(uid) || r.isMuted || r.isBlocked) continue;
					notified.add(uid);
					if (hasVisibleSocket(uid)) continue;
					push.sendNotificationToUser(uid, {
						title: r.nickname || 'Time capsule unlocked',
						body: 'A time capsule in your chat has been unlocked. Open the app to view.',
						data: {
							conversationId: msg.conversationId,
							messageId: msg.id,
							url: `/chat/main.html?conversationId=${msg.conversationId}&messageId=${msg.id}`,
						},
						tag: `conversation-${msg.conversationId}`,
					}).catch(() => { /* suppress push errors */ });
				}
			} catch (e) {
				console.error('openDueCapsules push failed', e);
			}
		}

		if (processed > 0) {
			const more = due.length === OPEN_CAPSULES_BATCH_SIZE ? " (more may remain for the next run)" : "";
			console.info(`openDueCapsules: opened ${processed} capsule(s)${more}`);
		}
	} catch (e) {
		console.error('openDueCapsules error', e);
	} finally {
		_running = false;
	}
}
