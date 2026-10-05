// "typing..." both ways: telling the other person while this user types, and
// showing it while they do (it also goes away by itself if "stop" is lost).
import { typing } from "../state/stores";
import * as realtime from "./realtime";

const SHOW_MS = 6000;
const SEND_EVERY_MS = 800;
const IDLE_MS = 2000;

// ─── Showing ──────────────────────────────────────────────────────────────
const hideTimers = new Map<number, number>();

export function setTyping(convId: number, on: boolean): void {
	const t = hideTimers.get(convId);
	if (t !== undefined) window.clearTimeout(t);
	hideTimers.delete(convId);
	if (on) {
		typing.set((s) => ({ ...s, [convId]: Date.now() + SHOW_MS }));
		hideTimers.set(
			convId,
			window.setTimeout(() => setTyping(convId, false), SHOW_MS),
		);
	} else {
		typing.set((s) => {
			if (!(convId in s)) return s;
			const next = { ...s };
			delete next[convId];
			return next;
		});
	}
}

export function clearAllTyping(): void {
	for (const t of hideTimers.values()) window.clearTimeout(t);
	hideTimers.clear();
	typing.set({});
}

// ─── Telling ──────────────────────────────────────────────────────────────
let lastSent = 0;
let sentFor: number | null = null;
let idleTimer: number | null = null;

/** Called on every keystroke in a chat's message box. */
export function userTyped(convId: number): void {
	const now = Date.now();
	if (sentFor !== convId || now - lastSent > SEND_EVERY_MS) {
		if (sentFor !== null && sentFor !== convId) realtime.send("typing:stop", { conversationId: sentFor });
		realtime.send("typing:start", { conversationId: convId });
		lastSent = now;
		sentFor = convId;
	}
	if (idleTimer !== null) window.clearTimeout(idleTimer);
	idleTimer = window.setTimeout(() => stopTyping(), IDLE_MS);
}

/** The user sent the message, cleared the box or left the chat. */
export function stopTyping(): void {
	if (idleTimer !== null) window.clearTimeout(idleTimer);
	idleTimer = null;
	if (sentFor !== null) realtime.send("typing:stop", { conversationId: sentFor });
	sentFor = null;
	lastSent = 0;
}
