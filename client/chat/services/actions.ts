// What the user does to messages and chats. Changes show at once; the server
// confirms (or the change is undone with a short message).
import { contactsApi, conversationsApi, messagesApi, type ContactPatch } from "../../shared/api/endpoints";
import { ApiError, errorText } from "../../shared/api/http";
import type { ContactRow, LiveMessage } from "../../shared/api/types";
import { clearUpTo, getCache, insertPinned, patchMessage, removeFromCache, updateExisting } from "../state/chatModel";
import { getRow, patchRow, realName, removeRow, toPreview, upsertRow } from "../state/contactModel";
import { patchComposer } from "../state/composerModel";
import { contacts, session, ui, undoing } from "../state/stores";
import type { ForwardSource } from "../state/types";
import { showToast } from "./feedback";
import { closeChat, closeMenu, forgetChat } from "./navigation";
import * as realtime from "./realtime";
import { refreshRowSoon } from "./sync";
import { cancelUndo, withUndo } from "./undo";

const OFFLINE = "No connection. Check your internet and try again.";

// ─── Clipboard ────────────────────────────────────────────────────────────

export async function copyText(text: string): Promise<void> {
	const done = () => showToast("Message copied", { icon: "copy" });
	try {
		// only on https (and localhost)
		await navigator.clipboard.writeText(text);
		done();
		return;
	} catch {
		/* fall back below */
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		if (ok) done();
		else showToast("Couldn't copy the message", { icon: "error" });
	} catch {
		showToast("Couldn't copy the message", { icon: "error" });
	}
}

// ─── Messages ─────────────────────────────────────────────────────────────

/** Saves an edited text (shown right away, put back if the server refuses). */
export async function editMessage(convId: number, message: LiveMessage, rawText: string): Promise<void> {
	const text = rawText.trim();
	if (!text || text === message.text) return;
	const before = { text: message.text, isEdited: message.isEdited };
	updateExisting(convId, (c) => patchMessage(c, message.id, { text, isEdited: true }));
	try {
		const ack = await realtime.request("message:edit", { messageId: message.id, text });
		if (ack.error !== undefined) throw new Error(ack.error);
		updateExisting(convId, (c) => patchMessage(c, message.id, { text: ack.text, isEdited: true, updatedAt: ack.updatedAt }));
		updateExisting(convId, (c) =>
			c.pinned?.some((p) => p.id === message.id) ? { ...c, pinned: c.pinned.map((p) => (p.id === message.id ? { ...p, text: ack.text } : p)) } : c,
		);
		patchRow(convId, (r) => (r.lastMessage?.id === message.id ? { lastMessage: { ...r.lastMessage, text: ack.text, isEdited: true } } : {}));
	} catch (e) {
		updateExisting(convId, (c) => patchMessage(c, message.id, before));
		showToast(e instanceof realtime.OfflineError ? OFFLINE : (e as Error).message || "Couldn't edit the message", { icon: "error" });
	}
}

/** The newest loaded message that is not about to go away. */
function newestRemaining(convId: number, hidden: Set<number>): LiveMessage | null {
	const list = getCache(convId)?.messages ?? [];
	for (let i = list.length - 1; i >= 0; i--) if (!hidden.has(list[i]!.id)) return list[i]!;
	return null;
}

/** Deletes the user's own messages (for both people), with Undo. */
export function deleteMessages(convId: number, ids: number[]): void {
	if (ids.length === 0) return;
	const idSet = new Set(ids);
	const row = getRow(convId);
	const previousPreview = row?.lastMessage ?? null;
	let shownPreview: ContactRow["lastMessage"] | undefined;
	withUndo({
		key: `messages:${convId}:${[...ids].sort((a, b) => a - b).join(",")}`,
		text: ids.length > 1 ? `${ids.length} messages deleted` : "Message deleted",
		icon: "delete",
		apply: () => {
			undoing.set((s) => {
				const messages = { ...s.messages };
				for (const id of ids) messages[id] = true;
				return { ...s, messages };
			});
			// the list already shows the message before them
			if (previousPreview && idSet.has(previousPreview.id)) {
				const hidden = new Set(Object.keys(undoing.get().messages).map(Number));
				const before = newestRemaining(convId, hidden);
				shownPreview = before ? toPreview(before) : null;
				patchRow(convId, { lastMessage: shownPreview });
			}
		},
		revert: () => {
			undoing.set((s) => {
				const messages = { ...s.messages };
				for (const id of ids) delete messages[id];
				return { ...s, messages };
			});
			if (shownPreview !== undefined && getRow(convId)?.lastMessage === shownPreview) patchRow(convId, { lastMessage: previousPreview });
		},
		commit: async () => {
			if (realtime.isConnected()) {
				const ack = await realtime.request("messages:delete", { messageIds: ids });
				if (ack.error !== undefined) throw new Error(ack.error);
			} else {
				await messagesApi.deleteMany(ids);
			}
			updateExisting(convId, (c) => removeFromCache(c, ids));
			undoing.set((s) => {
				const messages = { ...s.messages };
				for (const id of ids) delete messages[id];
				return { ...s, messages };
			});
			// what the list shows came from memory; the server has the truth
			if (previousPreview && idSet.has(previousPreview.id) && !getCache(convId)) refreshRowSoon(convId);
		},
		commitOnExit: () => void messagesApi.deleteMany(ids, true).catch(() => undefined),
		failedText: ids.length > 1 ? "Couldn't delete the messages. Try again." : "Couldn't delete the message. Try again.",
	});
}

export async function togglePin(convId: number, message: LiveMessage): Promise<void> {
	closeMenu();
	try {
		const ack = await realtime.request("message:pin", { messageId: message.id });
		if (ack.error !== undefined) throw new Error(ack.error);
		updateExisting(convId, (c) => {
			const next = patchMessage(c, message.id, { isPinned: ack.isPinned });
			if (!next.pinned) return next;
			return {
				...next,
				pinned: ack.isPinned ? insertPinned(next.pinned, message) : next.pinned.filter((p) => p.id !== message.id),
			};
		});
	} catch (e) {
		const msg = (e as Error).message;
		showToast(e instanceof realtime.OfflineError ? OFFLINE : msg.startsWith("Pin limit") ? msg : "Failed to update pin", { icon: "error" });
	}
}

/** Adds, changes or (same emoji again) removes the user's reaction. */
export async function react(convId: number, message: LiveMessage, emoji: string): Promise<void> {
	const me = session.get().me?.id;
	if (me === undefined) return;
	const before = message.reactions;
	const mine = before.find((r) => r.userId === me);
	const optimistic = mine?.emoji === emoji ? before.filter((r) => r.userId !== me) : [...before.filter((r) => r.userId !== me), { userId: me, emoji }];
	updateExisting(convId, (c) => patchMessage(c, message.id, { reactions: optimistic }));
	try {
		const ack = await realtime.request("reaction:add", { messageId: message.id, emoji });
		if (ack.error !== undefined) throw new Error(ack.error);
		updateExisting(convId, (c) => patchMessage(c, message.id, { reactions: ack.reactions }));
	} catch (e) {
		updateExisting(convId, (c) => patchMessage(c, message.id, { reactions: before }));
		showToast(e instanceof realtime.OfflineError ? OFFLINE : "Failed to send reaction", { icon: "error" });
	}
}

/** Who a forwarded copy names as the author (forwarding a forward keeps the original). */
export function forwardSource(convId: number, m: LiveMessage): ForwardSource {
	const me = session.get().me;
	const row = getRow(convId);
	let author: string;
	if (m.forwardedFrom) author = m.forwardedFrom === "You" ? (m.senderId === me?.id ? me?.name ?? "" : realName(row)) : m.forwardedFrom;
	else if (m.senderId === me?.id || row?.isSaved) author = me?.name ?? "";
	else author = realName(row);
	return { sourceId: m.id, text: m.text ?? "", forwardedFrom: author || "Unknown" };
}

/** Puts a reply into the chat's message box. */
export function startReply(convId: number, message: LiveMessage): void {
	closeMenu();
	patchComposer(convId, { action: { kind: "reply", message } });
}

export function startEdit(convId: number, message: LiveMessage): void {
	closeMenu();
	patchComposer(convId, { action: { kind: "edit", message }, draft: message.text ?? "" });
}

// ─── Chats and contacts ───────────────────────────────────────────────────

async function updateContact(convId: number, patch: ContactPatch, optimistic: Partial<ContactRow>): Promise<boolean> {
	const row = getRow(convId);
	if (!row) return false;
	const before: Partial<ContactRow> = {};
	for (const k of Object.keys(optimistic) as (keyof ContactRow)[]) (before as Record<string, unknown>)[k] = row[k];
	patchRow(convId, optimistic);
	try {
		upsertRow(await contactsApi.update(row.id, patch));
		return true;
	} catch (e) {
		patchRow(convId, before);
		showToast(errorText(e, "Couldn't update. Try again."), { icon: "error" });
		return false;
	}
}

export function togglePinChat(row: ContactRow): void {
	void updateContact(row.conversationId, { isPinned: !row.isPinned }, { isPinned: !row.isPinned });
}

export function toggleMute(row: ContactRow): void {
	void updateContact(row.conversationId, { isMuted: !row.isMuted }, { isMuted: !row.isMuted });
}

export async function toggleBlock(row: ContactRow): Promise<void> {
	if (row.isSaved) return;
	const next = !row.isBlocked;
	if (await updateContact(row.conversationId, { isBlocked: next }, { isBlocked: next })) {
		showToast(next ? "Contact blocked" : "Contact unblocked", { icon: "block" });
	}
}

export async function setArchived(row: ContactRow, archived: boolean): Promise<boolean> {
	if (row.isSaved) return false;
	// an archived chat leaves the screen
	if (archived && ui.get().openConvId === row.conversationId) closeChat();
	const ok = await updateContact(row.conversationId, { isArchived: archived }, { isArchived: archived });
	if (ok) showToast(archived ? "Chat archived" : "Chat unarchived", { icon: "archive" });
	return ok;
}

export async function rename(row: ContactRow, nickname: string): Promise<void> {
	const clean = nickname.replace(/\s+/g, " ").trim().slice(0, 100);
	const shown = row.nickname || row.contact?.name || "";
	if (clean === shown) return;
	// an empty name goes back to the person's own name
	const value = clean && clean !== row.contact?.name ? clean : null;
	if (value === row.nickname) return;
	const ok = await updateContact(row.conversationId, { nickname: value ?? "" }, { nickname: value });
	if (!ok) showToast("Couldn't change the name. Try again.", { icon: "error" });
}

/** The newest message of a chat this device knows about. */
function newestKnownId(convId: number): number | null {
	const fromList = getRow(convId)?.lastMessage?.id ?? 0;
	const list = getCache(convId)?.messages;
	const fromChat = list && list.length ? list[list.length - 1]!.id : 0;
	return Math.max(fromList, fromChat) || null;
}

/** Clears the chat for both people (Saved Messages: just its messages), with Undo. */
export function deleteChat(row: ContactRow): void {
	const convId = row.conversationId;
	if (ui.get().openConvId === convId) closeChat();
	// only what the user has seen: a message that arrives during Undo stays
	const upToId = newestKnownId(convId);
	withUndo({
		key: `chat:${convId}`,
		text: "Chat deleted",
		icon: "delete",
		apply: () => undoing.set((s) => ({ ...s, clearedChats: { ...s.clearedChats, [convId]: true } })),
		revert: () =>
			undoing.set((s) => {
				const clearedChats = { ...s.clearedChats };
				delete clearedChats[convId];
				return { ...s, clearedChats };
			}),
		commit: async () => {
			await conversationsApi.clear(convId, upToId);
			if (upToId !== null) updateExisting(convId, (c) => clearUpTo(c, upToId));
			const last = getRow(convId)?.lastMessage;
			if (!last || upToId === null || last.id <= upToId) patchRow(convId, { lastMessage: null, unreadCount: 0 });
			// something newer arrived meanwhile: the server has its unread count
			else refreshRowSoon(convId);
			undoing.set((s) => {
				const clearedChats = { ...s.clearedChats };
				delete clearedChats[convId];
				return { ...s, clearedChats };
			});
		},
		commitOnExit: () => void conversationsApi.clear(convId, upToId, true).catch(() => undefined),
		failedText: "Couldn't delete the chat. Try again.",
	});
}

/** Removes the contact from this user's list (the other person keeps the chat), with Undo. */
export function deleteContact(row: ContactRow): void {
	if (row.isSaved) return;
	const convId = row.conversationId;
	if (ui.get().openConvId === convId) closeChat();
	withUndo({
		key: `contact:${convId}`,
		text: "Contact deleted",
		icon: "delete",
		apply: () => undoing.set((s) => ({ ...s, removedContacts: { ...s.removedContacts, [convId]: true } })),
		revert: () =>
			undoing.set((s) => {
				const removedContacts = { ...s.removedContacts };
				delete removedContacts[convId];
				return { ...s, removedContacts };
			}),
		commit: async () => {
			await contactsApi.remove(row.id);
			// (the contact:removed event may have done this already)
			forgetChat(convId);
			removeRow(convId);
			undoing.set((s) => {
				const removedContacts = { ...s.removedContacts };
				delete removedContacts[convId];
				return { ...s, removedContacts };
			});
		},
		commitOnExit: () => void contactsApi.remove(row.id, true).catch(() => undefined),
		failedText: "Couldn't delete the contact. Try again.",
	});
}

/**
 * Adds someone by username and returns their chat. Someone already in the
 * list (or deleted a moment ago, still in its Undo window) is just found; one
 * who is in the list only because they added this user becomes a contact
 * this user chose (the server answers 200 with the same row).
 */
export async function addContact(username: string, name: string): Promise<ContactRow> {
	const clean = username.trim().replace(/^@/, "");
	try {
		const row = await contactsApi.add(clean, name.trim() || undefined);
		// (already in the list because they added this user, maybe being deleted
		// right now: adding them is the answer to that Undo)
		cancelUndo(`contact:${row.conversationId}`);
		upsertRow(row);
		return row;
	} catch (e) {
		if (e instanceof ApiError && e.status === 409) {
			const key = clean.toLowerCase();
			const row = Object.values(contacts.get().byConv).find((r) => !r.isSaved && r.contact?.username.toLowerCase() === key);
			if (row) {
				cancelUndo(`contact:${row.conversationId}`);
				return row;
			}
		}
		throw e;
	}
}
