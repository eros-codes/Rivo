// Marking messages as read: only those that were actually on screen, only
// while the page is visible, up to the newest one shown. Bursts are combined
// into one request.
import { updateExisting } from "../state/chatModel";
import { patchRow } from "../state/contactModel";
import { ui } from "../state/stores";
import * as realtime from "./realtime";
import { meId } from "./session";

let pending: { convId: number; upToId: number } | null = null;
let timer: number | null = null;
let inFlight = false;

/** A message from the other person was seen on screen. */
export function sawMessage(convId: number, messageId: number): void {
	if (document.visibilityState !== "visible" || ui.get().openConvId !== convId) return;
	if (pending && pending.convId === convId) pending.upToId = Math.max(pending.upToId, messageId);
	else pending = { convId, upToId: messageId };
	if (timer === null) timer = window.setTimeout(flush, 250);
}

async function flush(): Promise<void> {
	timer = null;
	if (inFlight || !pending) {
		if (pending && timer === null) timer = window.setTimeout(flush, 250);
		return;
	}
	const { convId, upToId } = pending;
	pending = null;
	if (!realtime.isConnected() || ui.get().openConvId !== convId) return;
	inFlight = true;
	try {
		const ack = await realtime.request("message:seen", { conversationId: convId, upToId });
		if (ack.error !== undefined) return;
		const marked = new Set(ack.marked);
		const me = meId();
		if (marked.size) {
			updateExisting(convId, (c) =>
				c.messages.some((m) => marked.has(m.id) && !m.isSeen)
					? { ...c, messages: c.messages.map((m) => (marked.has(m.id) && m.senderId !== me ? { ...m, isSeen: true } : m)) }
					: c,
			);
		}
		const unread = ack.unreadCount;
		if (typeof unread === "number") {
			patchRow(convId, (r) => ({
				unreadCount: unread,
				lastMessage: r.lastMessage && marked.has(r.lastMessage.id) ? { ...r.lastMessage, isSeen: true } : r.lastMessage,
			}));
		}
	} catch {
		// unanswered: the next message on screen (or a reconnect) tries again
	} finally {
		inFlight = false;
		if (pending && timer === null) timer = window.setTimeout(flush, 250);
	}
}
