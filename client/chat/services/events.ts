// What the server tells the app as it happens, applied to the state.
import type { LiveMessage, ServerEvents } from "../../shared/api/types";
import { getCache, removeFromCache, applyWire, insertPinned, updateExisting } from "../state/chatModel";
import {
	displayName,
	getRow,
	patchPerson,
	patchRow,
	previewText,
	removeRow,
	toPreview,
	upsertRow,
} from "../state/contactModel";
import { getComposer, resetComposer } from "../state/composerModel";
import { ui, undoing, vanishing } from "../state/stores";
import { notify } from "./feedback";
import { forgetChat } from "./navigation";
import { on } from "./realtime";
import { meId, patchMe } from "./session";
import { loadPinned, refreshContacts, refreshRowSoon, settleOutbox } from "./sync";
import { setTyping } from "./typing";

const pageVisible = () => document.visibilityState === "visible";
const isViewing = (convId: number) => ui.get().openConvId === convId && pageVisible();

/** A newer message becomes the chat's preview. */
function previewWith(convId: number, m: LiveMessage): void {
	patchRow(convId, (r) => {
		const last = r.lastMessage;
		const newer = !last || last.id === m.id || m.createdAt > last.createdAt || (m.createdAt === last.createdAt && m.id > last.id);
		if (!newer) return {};
		const at = r.conversation?.lastMessageAt;
		return {
			lastMessage: toPreview(m),
			conversation: r.conversation ? { ...r.conversation, lastMessageAt: !at || m.createdAt > at ? m.createdAt : at } : r.conversation,
		};
	});
}

/**
 * The chat's newest message went away: the next one from memory when the
 * newest messages are loaded and in sync, otherwise from the server.
 */
function previewAfterRemoval(convId: number, removed: Set<number>): void {
	const row = getRow(convId);
	if (!row?.lastMessage || !removed.has(row.lastMessage.id)) return;
	const c = getCache(convId);
	if (c && c.status === "ready" && !c.staleSince) {
		const last = c.messages[c.messages.length - 1];
		if (last) {
			patchRow(convId, { lastMessage: toPreview(last) });
			return;
		}
		if (!c.hasMore) {
			patchRow(convId, { lastMessage: null });
			return;
		}
	}
	refreshRowSoon(convId);
}

/** Things on screen that point at messages that no longer exist. */
function forgetMessages(convId: number, ids: Set<number>): void {
	ui.set((s) => {
		let next = s;
		if (s.menu && s.menu.conversationId === convId && ids.has(s.menu.messageId)) next = { ...next, menu: null };
		if (s.selection && s.selection.conversationId === convId && s.selection.ids.some((id) => ids.has(id))) {
			const left = s.selection.ids.filter((id) => !ids.has(id));
			next = { ...next, selection: { ...s.selection, ids: left } };
		}
		return next;
	});
	const action = getComposer(convId).action;
	if (action && (action.kind === "reply" || action.kind === "edit") && ids.has(action.message.id)) resetComposer(convId);
	undoing.set((s) => {
		if (!Object.keys(s.messages).some((k) => ids.has(Number(k)))) return s;
		const messages = { ...s.messages };
		for (const id of ids) delete messages[id];
		return { ...s, messages };
	});
}

/** Removes messages; on the open chat they fade out first. */
function removeMessages(convId: number, ids: number[]): void {
	const set = new Set(ids);
	const drop = () => {
		updateExisting(convId, (c) => removeFromCache(c, ids));
		vanishing.set((s) => {
			if (!ids.some((id) => s[id])) return s;
			const next = { ...s };
			for (const id of ids) delete next[id];
			return next;
		});
		forgetMessages(convId, set);
		previewAfterRemoval(convId, set);
	};
	const shown = ui.get().openConvId === convId && getCache(convId)?.messages.some((m) => set.has(m.id));
	if (!shown || !pageVisible()) return drop();
	vanishing.set((s) => {
		const next = { ...s };
		for (const id of ids) next[id] = true;
		return next;
	});
	window.setTimeout(drop, 300);
}

/** Applies a change only when it is newer than the copy in memory. */
function patchIfNewer(convId: number, messageId: number, updatedAt: string | undefined, patch: Partial<LiveMessage>): void {
	updateExisting(convId, (c) => {
		const at = c.messages.findIndex((m) => m.id === messageId);
		if (at < 0) return c;
		const cur = c.messages[at]!;
		if (updatedAt && cur.updatedAt > updatedAt) return c;
		const messages = [...c.messages];
		messages[at] = { ...cur, ...patch, ...(updatedAt ? { updatedAt } : {}) };
		return { ...c, messages };
	});
}

let unknownRefresh: number | null = null;
function refreshForUnknownChat(): void {
	if (unknownRefresh !== null) return;
	unknownRefresh = window.setTimeout(() => {
		unknownRefresh = null;
		refreshContacts().catch(() => undefined);
	}, 300);
}

// ─── Handlers ─────────────────────────────────────────────────────────────

function onNew(m: ServerEvents["message:new"]): void {
	const convId = m.conversationId;
	const row = getRow(convId);
	if (!row) {
		// someone new wrote (or we had removed them): the list gets the chat
		refreshForUnknownChat();
		return;
	}
	const me = meId();
	const mine = m.senderId === me;
	// a list loaded just now may already include (and count) this message
	const counted = !!row.lastMessage && row.lastMessage.id >= m.id;
	updateExisting(convId, (c) => applyWire(c, [m]));
	if (mine) settleOutbox([m]);
	else setTyping(convId, false);
	previewWith(convId, m);
	if (!mine && !counted && !isViewing(convId)) patchRow(convId, (r) => ({ unreadCount: r.unreadCount + 1 }));

	if (!mine && pageVisible() && ui.get().openConvId !== convId && !row.isMuted && !row.isSaved) {
		notify({ conversationId: convId, title: displayName(row), text: previewText(m, me), messageId: m.id });
	}
}

function onEdited(d: ServerEvents["message:edited"]): void {
	patchIfNewer(d.conversationId, d.messageId, d.updatedAt, { text: d.text, isEdited: true });
	updateExisting(d.conversationId, (c) =>
		c.pinned?.some((p) => p.id === d.messageId) ? { ...c, pinned: c.pinned.map((p) => (p.id === d.messageId ? { ...p, text: d.text } : p)) } : c,
	);
	patchRow(d.conversationId, (r) =>
		r.lastMessage?.id === d.messageId ? { lastMessage: { ...r.lastMessage, text: d.text, isEdited: true } } : {},
	);
}

function onDeleted(d: ServerEvents["message:deleted"]): void {
	const row = getRow(d.conversationId);
	const known = getCache(d.conversationId)?.messages.find((m) => m.id === d.messageId);
	const fromOther = d.senderId !== meId();
	const wasUnseen = known ? !known.isSeen : !d.isSeen;
	if (row && fromOther && wasUnseen && row.unreadCount > 0) patchRow(d.conversationId, (r) => ({ unreadCount: Math.max(0, r.unreadCount - 1) }));
	removeMessages(d.conversationId, [d.messageId]);
}

function onBulkDeleted(d: ServerEvents["messages:bulk-deleted"]): void {
	// the chat was cleared (for both people) up to a message; newer ones stay
	const convId = d.conversationId;
	const ids = (getCache(convId)?.messages ?? []).filter((m) => m.id <= d.upToId).map((m) => m.id);
	removeMessages(convId, ids);
	updateExisting(convId, (c) => ({ ...c, hasMore: false, pinned: c.pinned ? c.pinned.filter((p) => p.id > d.upToId) : c.pinned }));
	const last = getRow(convId)?.lastMessage;
	if (!last || last.id <= d.upToId) patchRow(convId, { lastMessage: null, unreadCount: 0 });
	// newer messages stayed: the server has their unread count
	else refreshRowSoon(convId);
	undoing.set((s) => {
		if (!s.clearedChats[d.conversationId]) return s;
		const clearedChats = { ...s.clearedChats };
		delete clearedChats[d.conversationId];
		return { ...s, clearedChats };
	});
}

function onOneTimeDeleted(d: ServerEvents["message:onetime-deleted"]): void {
	removeMessages(d.conversationId, d.messageIds);
}

function onPinned(d: ServerEvents["message:pinned"]): void {
	patchIfNewer(d.conversationId, d.messageId, d.updatedAt, { isPinned: d.isPinned });
	const c = getCache(d.conversationId);
	if (!c?.pinned) return;
	if (!d.isPinned) {
		updateExisting(d.conversationId, (x) => (x.pinned ? { ...x, pinned: x.pinned.filter((p) => p.id !== d.messageId) } : x));
		return;
	}
	const m = c.messages.find((x) => x.id === d.messageId);
	if (m) updateExisting(d.conversationId, (x) => (x.pinned ? { ...x, pinned: insertPinned(x.pinned, m) } : x));
	else void loadPinned(d.conversationId);
}

function onReaction(d: ServerEvents["reaction:updated"]): void {
	patchIfNewer(d.conversationId, d.messageId, d.updatedAt, { reactions: d.reactions });
	const me = meId();
	if ((d.action !== "added" && d.action !== "changed") || d.actorId === me) return;
	const row = getRow(d.conversationId);
	const m = getCache(d.conversationId)?.messages.find((x) => x.id === d.messageId);
	if (!row || row.isMuted || !m || m.senderId !== me) return;
	if (ui.get().openConvId === d.conversationId || !pageVisible()) return;
	notify({
		conversationId: d.conversationId,
		title: displayName(row),
		text: `${displayName(row) || "Someone"} reacted ${d.emoji} to your message`,
		messageId: d.messageId,
	});
}

function onSeen(d: ServerEvents["message:seen"]): void {
	const me = meId();
	const ids = new Set(d.messageIds);
	const byMe = d.seenBy === me;
	updateExisting(d.conversationId, (c) => {
		if (!c.messages.some((m) => ids.has(m.id) && !m.isSeen)) return c;
		return { ...c, messages: c.messages.map((m) => (ids.has(m.id) && !m.isSeen ? { ...m, isSeen: true } : m)) };
	});
	patchRow(d.conversationId, (r) => ({
		lastMessage: r.lastMessage && ids.has(r.lastMessage.id) ? { ...r.lastMessage, isSeen: true } : r.lastMessage,
		// read on another device of this user
		unreadCount: byMe ? Math.max(0, r.unreadCount - d.messageIds.length) : r.unreadCount,
	}));
}

function onCapsuleOpened(d: ServerEvents["message:capsule:opened"]): void {
	const m = d.message;
	if (!m) return;
	updateExisting(d.conversationId, (c) => applyWire(c, [m]));
	if (!m.isDeleted) patchRow(d.conversationId, (r) => (r.lastMessage?.id === m.id ? { lastMessage: toPreview(m) } : {}));
}

function onUserUpdated(u: ServerEvents["user:updated"]): void {
	if (u.id === meId()) {
		patchMe({ name: u.name, username: u.username, bio: u.bio, profilePics: u.profilePics, ...(u.email ? { email: u.email } : {}) });
		return;
	}
	patchPerson(u.id, {
		name: u.name,
		username: u.username,
		bio: u.bio,
		profilePics: u.profilePics,
		email: u.email,
		isDeleted: u.isDeleted,
		...(u.isDeleted ? { isOnline: false, lastSeen: null } : {}),
	});
}

function onContactUpsert(row: ServerEvents["contact:upsert"]): void {
	upsertRow(row);
}

function onContactRemoved(d: ServerEvents["contact:removed"]): void {
	forgetChat(d.conversationId);
	removeRow(d.conversationId);
}

export function installEventHandlers(): void {
	on("message:new", onNew);
	on("message:edited", onEdited);
	on("message:deleted", onDeleted);
	on("messages:bulk-deleted", onBulkDeleted);
	on("message:onetime-deleted", onOneTimeDeleted);
	on("message:pinned", onPinned);
	on("reaction:updated", onReaction);
	on("message:seen", onSeen);
	on("message:capsule:opened", onCapsuleOpened);
	on("typing:start", (d) => setTyping(d.conversationId, true));
	on("typing:stop", (d) => setTyping(d.conversationId, false));
	on("user:online", (d) => patchPerson(d.userId, { isOnline: true }));
	on("user:offline", (d) => patchPerson(d.userId, { isOnline: false, lastSeen: d.lastSeen }));
	on("user:updated", onUserUpdated);
	on("contact:upsert", onContactUpsert);
	on("contact:removed", onContactRemoved);
}
