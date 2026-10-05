// Short messages to the user: the toast at the bottom (with an optional Undo)
// and the in-app notification banner at the top.
import { notices, toasts } from "../state/stores";
import type { InAppNotice, ToastIcon } from "../state/types";

const TOAST_MS = 3000;
let toastSeq = 0;
let toastTimer: number | null = null;

export function showToast(
	text: string,
	opts: { icon?: ToastIcon; action?: { label: string; run: () => void }; ms?: number } = {},
): void {
	const id = ++toastSeq;
	toasts.set({ current: { id, text, icon: opts.icon ?? null, action: opts.action ?? null } });
	if (toastTimer !== null) window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		toastTimer = null;
		toasts.set((s) => (s.current?.id === id ? { current: null } : s));
	}, opts.ms ?? TOAST_MS);
}

export function hideToast(): void {
	if (toastTimer !== null) window.clearTimeout(toastTimer);
	toastTimer = null;
	toasts.set({ current: null });
}

// ─── In-app notifications ─────────────────────────────────────────────────
const MAX_QUEUED = 5;
let noticeSeq = 0;

/**
 * Queues a banner. A banner for a chat that is already waiting or showing is
 * replaced in place, so a burst of messages is one banner.
 */
export function notify(n: Omit<InAppNotice, "id">): void {
	const notice: InAppNotice = { ...n, id: ++noticeSeq };
	notices.set((s) => {
		const at = s.list.findIndex((x) => x.conversationId === n.conversationId);
		if (at >= 0) {
			const list = [...s.list];
			list[at] = { ...notice, id: s.list[at]!.id };
			return { list };
		}
		const list = [...s.list, notice];
		return { list: list.length > MAX_QUEUED ? list.slice(list.length - MAX_QUEUED) : list };
	});
}

export function dismissNotice(id: number): void {
	notices.set((s) => ({ list: s.list.filter((x) => x.id !== id) }));
}

export function clearNotices(conversationId?: number): void {
	notices.set((s) => ({ list: conversationId === undefined ? [] : s.list.filter((x) => x.conversationId !== conversationId) }));
}
