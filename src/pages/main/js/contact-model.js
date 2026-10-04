// Contacts as the chat UI keeps them, built from the server's contact rows,
// and keeping that list in step with the server (start-up, reconnects, a
// message from someone who is not in the list yet).
import { getContacts } from "./api.js";
import { getContactPreviewText } from "./chat-state.js";
import { contacts, state } from "./state.js";
import { formatClock, localDateKey } from "../../../utils/date.js";

/** A server contact row in the shape the UI uses. */
export function normalizeServerContact(c, meId) {
	const last = c?.conversation?.messages?.[0] || null;
	const isSaved = !!c.isSaved;
	const isDeleted = !isSaved && !!c.contact?.isDeleted;
	const lastFromMe = last ? Number(last.senderId) === Number(meId) : false;
	const created = last && last.createdAt ? new Date(last.createdAt) : null;
	return {
		...c,
		name: isSaved ? "Saved Messages" : c.nickname || c.contact?.name || "",
		username: isSaved || isDeleted ? "" : c.contact?.username || "",
		profilePics: isSaved ? [] : c.contact?.profilePics || [],
		isOnline: isSaved ? false : !!c.contact?.isOnline,
		lastSeen: isSaved ? null : c.contact?.lastSeen || null,
		bio: isSaved ? "" : c.contact?.bio || "",
		email: isSaved || isDeleted ? "" : c.contact?.email || "",
		isDeleted,
		contactId: isSaved ? c.ownerId : (c.contact?.id ?? c.contactId ?? null),
		isSaved,
		lastMessage: last
			? getContactPreviewText({
					user: lastFromMe,
					text: last.text,
					isTimeCapsule: last.isTimeCapsule,
					isLocked: last.isLocked,
					openedAt: last.openedAt,
					isOneTime: last.isOneTime,
				})
			: "",
		lastMessageId: last ? last.id : null,
		lastMessageTime: created ? formatClock(created) : null,
		lastMessageDate: created ? localDateKey(created) : null,
		lastMessageTs: created ? created.getTime() : 0,
		unreadCount: c.unreadCount ?? 0,
		// Treat missing `isSeen` as seen; only an explicit false is unseen
		lastMessageSeen: last ? last.isSeen !== false : true,
	};
}

/**
 * Every contact row of the user. The server pages the list, so pages are
 * requested until an empty one comes back.
 */
export async function fetchAllContacts() {
	const PAGE = 100;
	const all = [];
	const seen = new Set();
	let skip = 0;
	for (let i = 0; i < 100; i++) {
		const page = await getContacts({ limit: PAGE, skip });
		if (!Array.isArray(page) || page.length === 0) break;
		let added = 0;
		for (const c of page) {
			if (!c || seen.has(c.id)) continue;
			seen.add(c.id);
			all.push(c);
			added++;
		}
		// an old server that ignores paging would return the same rows forever
		if (added === 0) break;
		skip += page.length;
	}
	return all;
}

/**
 * Brings the in-memory list in line with the server. Returns
 * { added, updated, removed } contact objects so the caller can redraw.
 */
export async function syncContactsWithServer(meId) {
	const rows = await fetchAllContacts();
	const fresh = rows.map((c) => normalizeServerContact(c, meId));
	const freshIds = new Set(fresh.map((c) => c.id));
	const added = [];
	const updated = [];
	for (const f of fresh) {
		const existing = contacts.find((c) => c.id === f.id);
		if (!existing) {
			f._previousContainer = "contacts";
			contacts.push(f);
			added.push(f);
			continue;
		}
		const keep = { _previousContainer: existing._previousContainer };
		Object.assign(existing, f, keep);
		// the chat on screen is being read right now
		if (state.contactUserId === existing.id && document.visibilityState !== "hidden") {
			existing.unreadCount = 0;
		}
		updated.push(existing);
	}
	const removed = [];
	for (let i = contacts.length - 1; i >= 0; i--) {
		if (!freshIds.has(contacts[i].id)) removed.push(...contacts.splice(i, 1));
	}
	return { added, updated, removed };
}
