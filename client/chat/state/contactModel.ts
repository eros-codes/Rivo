// Contact rows: how they are named, previewed, sorted and placed, and the
// functions that change the contact list.
import type { ContactRow, LiveMessage, MessagePreview, Person } from "../../shared/api/types";
import { contacts } from "./stores";
import type { Pending, Section } from "./types";

export const SAVED_NAME = "Saved Messages";
export const DELETED_NAME = "Deleted account";

export function isDeletedAccount(row: ContactRow): boolean {
	return !row.isSaved && !!row.contact?.isDeleted;
}

/** How the user sees this chat named: Saved Messages, their nickname, or the person's name. */
export function displayName(row: ContactRow | null | undefined): string {
	if (!row) return "";
	if (row.isSaved) return SAVED_NAME;
	if (isDeletedAccount(row)) return DELETED_NAME;
	return row.nickname || row.contact?.name || "";
}

/** The person's own name (forwarded labels use it, never a private nickname). */
export function realName(row: ContactRow | null | undefined): string {
	if (!row) return "";
	if (isDeletedAccount(row)) return DELETED_NAME;
	return row.contact?.name || row.nickname || "";
}

/** Online and not hidden by privacy (Saved Messages and deleted accounts never are). */
export function isOnline(row: ContactRow): boolean {
	return !row.isSaved && !isDeletedAccount(row) && !!row.contact?.isOnline;
}

export const LOCKED_CAPSULE_PREVIEW = "Time capsule 🔒";
export const ONE_TIME_PREVIEW = "One-time message";

/** The line under a chat's name in the lists. */
export function previewText(m: Pick<MessagePreview, "senderId" | "text" | "isTimeCapsule" | "isLocked" | "openedAt" | "isOneTime"> | null, meId: number | null): string {
	if (!m) return "";
	const mine = m.senderId === meId;
	if (m.isTimeCapsule && !mine) {
		if (m.isLocked) return LOCKED_CAPSULE_PREVIEW;
		if (!m.text) return "Time capsule unlocked";
	}
	if (m.isOneTime && !mine) return ONE_TIME_PREVIEW;
	return (m.text || "").replace(/\s+/g, " ").trim();
}

/** A full message in its list-preview form. */
export function toPreview(m: LiveMessage): MessagePreview {
	return {
		id: m.id,
		conversationId: m.conversationId,
		senderId: m.senderId,
		text: m.text,
		createdAt: m.createdAt,
		isDeleted: false,
		isEdited: m.isEdited,
		isPinned: m.isPinned,
		isSeen: m.isSeen,
		isOneTime: m.isOneTime,
		isTimeCapsule: m.isTimeCapsule,
		isLocked: m.isLocked,
		scheduledFor: m.scheduledFor,
		openedAt: m.openedAt,
	};
}

/** What a list shows as a chat's latest message: something being sent beats the server's last one. */
export interface EffectiveLast {
	text: string;
	at: string | null;
	mine: boolean;
	/** for the sender: seen by the other person */
	seen: boolean;
	pending: boolean;
	failed: boolean;
}

export function effectiveLast(row: ContactRow, pending: Pending | undefined, meId: number | null): EffectiveLast | null {
	if (pending && (!row.lastMessage || pending.createdAt >= row.lastMessage.createdAt)) {
		return {
			text: pending.text.replace(/\s+/g, " ").trim(),
			at: pending.createdAt,
			mine: true,
			seen: false,
			pending: pending.status !== "failed",
			failed: pending.status === "failed",
		};
	}
	const m = row.lastMessage;
	if (!m) return null;
	return {
		text: previewText(m, meId),
		at: m.createdAt,
		mine: m.senderId === meId,
		seen: m.isSeen,
		pending: false,
		failed: false,
	};
}

/** Time of the latest message (ms), 0 without one. */
export function lastTime(row: ContactRow, pending?: Pending): number {
	const at = pending && (!row.lastMessage || pending.createdAt >= row.lastMessage.createdAt) ? pending.createdAt : row.lastMessage?.createdAt;
	const t = at ? Date.parse(at) : NaN;
	return Number.isFinite(t) ? t : 0;
}

/**
 * Where a chat belongs: Active Chats holds Saved Messages, pinned chats, the
 * chat on screen and chats with something unread or not yet seen by the
 * other person; the rest are contact cards. Archived chats are in neither.
 */
export function sectionOf(row: ContactRow, openConvId: number | null, meId: number | null, pending?: Pending): Section {
	if (row.isArchived && !row.isSaved) return "archived";
	if (row.isSaved || row.isPinned || row.conversationId === openConvId || row.unreadCount > 0) return "active";
	if (pending) return "active";
	const m = row.lastMessage;
	if (m && m.senderId === meId && !m.isSeen) return "active";
	return "contacts";
}

const nameKey = (row: ContactRow) => displayName(row).toLocaleLowerCase();

/** Active Chats: Saved Messages, then pinned chats (in pin order), then the most recent. */
export function sortActive(rows: ContactRow[], newestPending: Record<number, Pending>): ContactRow[] {
	const rank = (r: ContactRow) => (r.isSaved ? 0 : r.isPinned ? 1 : 2);
	return [...rows].sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		if (ra !== rb) return ra - rb;
		if (ra === 1) {
			const pa = a.pinOrder ?? Number.MAX_SAFE_INTEGER;
			const pb = b.pinOrder ?? Number.MAX_SAFE_INTEGER;
			if (pa !== pb) return pa - pb;
		}
		const t = lastTime(b, newestPending[b.conversationId]) - lastTime(a, newestPending[a.conversationId]);
		if (t !== 0) return t;
		return nameKey(a).localeCompare(nameKey(b));
	});
}

/** Contacts: most recent conversation first, then contacts never written to (newest first), blocked ones last. */
export function sortContacts(rows: ContactRow[]): ContactRow[] {
	const group = (r: ContactRow) => (r.isBlocked ? 2 : r.lastMessage ? 0 : 1);
	return [...rows].sort((a, b) => {
		const ga = group(a);
		const gb = group(b);
		if (ga !== gb) return ga - gb;
		const am = a.lastMessage ? 1 : 0;
		const bm = b.lastMessage ? 1 : 0;
		if (am !== bm) return bm - am;
		if (am) {
			const t = lastTime(b) - lastTime(a);
			if (t !== 0) return t;
		}
		return b.id - a.id;
	});
}

// ─── Changes to the list ──────────────────────────────────────────────────

export function getRow(conversationId: number | null | undefined): ContactRow | null {
	if (conversationId === null || conversationId === undefined) return null;
	return contacts.get().byConv[conversationId] ?? null;
}

export function rowById(rowId: number): ContactRow | null {
	for (const r of Object.values(contacts.get().byConv)) if (r.id === rowId) return r;
	return null;
}

/** The chat with a person (never Saved Messages). */
export function rowOfUser(userId: number): ContactRow | null {
	for (const r of Object.values(contacts.get().byConv)) if (!r.isSaved && r.contactId === userId) return r;
	return null;
}

// A full list from the server takes a moment to load, and live events keep
// changing rows meanwhile. Every change here is numbered, so a list that was
// asked for before a change does not undo it.
let rev = 0;
const changedAt = new Map<number, number>(); // conversationId → number of its last change here

function touch(conversationId: number): void {
	changedAt.set(conversationId, ++rev);
}

/** The number of the latest change (taken before asking for a full list). */
export function contactsRev(): number {
	return rev;
}

/**
 * Replaces the list with the server's. Rows changed here after `askedAt`
 * (added, updated or removed by live events) keep their newer local state.
 */
export function setAllRows(rows: ContactRow[], askedAt: number = rev): void {
	const newer = (convId: number) => (changedAt.get(convId) ?? 0) > askedAt;
	contacts.set((s) => {
		const byConv: Record<number, ContactRow> = {};
		for (const r of rows) {
			if (!newer(r.conversationId)) byConv[r.conversationId] = r;
			else if (s.byConv[r.conversationId]) byConv[r.conversationId] = s.byConv[r.conversationId]!;
			// (removed here after the list was asked for: stays removed)
		}
		// chats that arrived here while the list was on its way
		for (const [k, local] of Object.entries(s.byConv)) {
			const convId = Number(k);
			if (!byConv[convId] && newer(convId)) byConv[convId] = local;
		}
		return { ...s, byConv, loaded: true, failed: false };
	});
}

export function upsertRow(row: ContactRow): void {
	touch(row.conversationId);
	contacts.set((s) => ({ ...s, byConv: { ...s.byConv, [row.conversationId]: row } }));
}

export function patchRow(conversationId: number, patch: Partial<ContactRow> | ((row: ContactRow) => Partial<ContactRow>)): void {
	touch(conversationId);
	contacts.set((s) => {
		const row = s.byConv[conversationId];
		if (!row) return s;
		const p = typeof patch === "function" ? patch(row) : patch;
		return { ...s, byConv: { ...s.byConv, [conversationId]: { ...row, ...p } } };
	});
}

export function patchPerson(userId: number, patch: Partial<Person>): void {
	contacts.set((s) => {
		let changed = false;
		const byConv = { ...s.byConv };
		for (const [k, r] of Object.entries(byConv)) {
			if (r.isSaved || r.contactId !== userId || !r.contact) continue;
			touch(Number(k));
			byConv[Number(k)] = { ...r, contact: { ...r.contact, ...patch } };
			changed = true;
		}
		return changed ? { ...s, byConv } : s;
	});
}

export function removeRow(conversationId: number): void {
	touch(conversationId);
	contacts.set((s) => {
		if (!s.byConv[conversationId]) return s;
		const byConv = { ...s.byConv };
		delete byConv[conversationId];
		return { ...s, byConv };
	});
}
