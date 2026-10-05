// What is on screen: the open chat, panels, dialogs, menus, search and the
// selection — each tied to the back button.
import { dropCache } from "../state/chatModel";
import { getRow } from "../state/contactModel";
import { dropComposer, getComposer, patchComposer } from "../state/composerModel";
import { ui, type Dialog, type Panel } from "../state/stores";
import { popLayer, pushLayer } from "./backStack";
import { clearNotices } from "./feedback";
import * as realtime from "./realtime";
import { prepareChat } from "./sync";
import { stopTyping } from "./typing";
import { showToast } from "./feedback";

let focusSeq = 0;

/** Scrolls the open chat to a message and highlights it (loading older pages if needed). */
export function focusMessage(conversationId: number, messageId: number): void {
	ui.set((s) => ({ ...s, focus: { conversationId, messageId, seq: ++focusSeq } }));
}

function leave(convId: number): void {
	realtime.send("conversation:leave", { conversationId: convId });
	stopTyping();
	// a reply, edit or forward being prepared belongs to that visit
	const c = getComposer(convId);
	if (c.action || c.mode !== "normal") patchComposer(convId, { action: null, mode: "normal", scheduledFor: null });
}

/** Every way of opening a chat goes through here. */
export function openChat(convId: number, opts: { focusMessageId?: number | null } = {}): void {
	if (!getRow(convId)) return;
	const prev = ui.get().openConvId;
	if (prev !== null && prev !== convId) leave(prev);
	closeMenu();
	cancelSelection();
	closeSearch();
	closeDialog();
	closePanel();
	ui.set((s) => ({ ...s, openConvId: convId }));
	pushLayer("chat", closeChatQuietly);
	if (prev !== convId) realtime.send("conversation:join", { conversationId: convId });
	clearNotices(convId);
	prepareChat(convId).catch(() => {
		if (ui.get().openConvId === convId) showToast("Couldn't load the messages. Check your connection.", { icon: "error" });
	});
	if (opts.focusMessageId) focusMessage(convId, opts.focusMessageId);
}

function closeChatQuietly(): void {
	const id = ui.get().openConvId;
	if (id === null) return;
	leave(id);
	closeMenu();
	cancelSelection();
	if (ui.get().panel === "profile") closePanel();
	ui.set((s) => ({ ...s, openConvId: null, focus: null }));
}

export function closeChat(): void {
	closeChatQuietly();
	popLayer("chat");
}

/** A chat that no longer exists here (contact removed, account deleted): closed and forgotten. */
export function forgetChat(convId: number): void {
	if (ui.get().openConvId === convId) closeChat();
	dropCache(convId);
	dropComposer(convId);
	clearNotices(convId);
}

// ─── Panels and dialogs ───────────────────────────────────────────────────

export function openPanel(panel: Panel): void {
	closeMenu();
	ui.set((s) => ({ ...s, panel }));
	pushLayer("panel", () => ui.set((s) => ({ ...s, panel: null })));
}

export function closePanel(): void {
	if (ui.get().panel === null) return;
	ui.set((s) => ({ ...s, panel: null }));
	popLayer("panel");
}

export function openDialog(dialog: Dialog): void {
	ui.set((s) => ({ ...s, dialog }));
	pushLayer("dialog", () => ui.set((s) => ({ ...s, dialog: null, forwarding: s.dialog === "forward" ? null : s.forwarding })));
}

export function closeDialog(): void {
	if (ui.get().dialog === null) return;
	ui.set((s) => ({ ...s, dialog: null, forwarding: s.dialog === "forward" ? null : s.forwarding }));
	popLayer("dialog");
}

export function openAllContacts(): void {
	ui.set((s) => ({ ...s, allContactsOpen: true }));
	pushLayer("allContacts", () => ui.set((s) => ({ ...s, allContactsOpen: false })));
}

export function closeAllContacts(): void {
	if (!ui.get().allContactsOpen) return;
	ui.set((s) => ({ ...s, allContactsOpen: false }));
	popLayer("allContacts");
}

// ─── Search ───────────────────────────────────────────────────────────────

export function openSearch(): void {
	if (ui.get().search.open) return;
	ui.set((s) => ({ ...s, search: { ...s.search, open: true } }));
	pushLayer("search", () => ui.set((s) => ({ ...s, search: { open: false, query: "" } })));
}

export function setSearchQuery(query: string): void {
	ui.set((s) => ({ ...s, search: { open: true, query } }));
}

export function closeSearch(): void {
	const { search } = ui.get();
	if (!search.open && !search.query) return;
	ui.set((s) => ({ ...s, search: { open: false, query: "" } }));
	popLayer("search");
}

// ─── Message menu and selection ───────────────────────────────────────────

export function openMenu(conversationId: number, messageId: number, x: number, y: number): void {
	ui.set((s) => ({ ...s, menu: { conversationId, messageId, x, y } }));
	pushLayer("menu", () => ui.set((s) => ({ ...s, menu: null })));
}

export function closeMenu(): void {
	if (!ui.get().menu) return;
	ui.set((s) => ({ ...s, menu: null }));
	popLayer("menu");
}

export function startSelection(conversationId: number, messageId: number): void {
	ui.set((s) => ({ ...s, selection: { conversationId, ids: [messageId] } }));
	pushLayer("selection", () => ui.set((s) => ({ ...s, selection: null })));
}

export function toggleSelected(messageId: number): void {
	ui.set((s) => {
		if (!s.selection) return s;
		const has = s.selection.ids.includes(messageId);
		const ids = has ? s.selection.ids.filter((id) => id !== messageId) : [...s.selection.ids, messageId];
		return { ...s, selection: { ...s.selection, ids } };
	});
	// nothing left selected: selection mode ends
	if (ui.get().selection?.ids.length === 0) cancelSelection();
}

export function cancelSelection(): void {
	if (!ui.get().selection) return;
	ui.set((s) => ({ ...s, selection: null }));
	popLayer("selection");
}
