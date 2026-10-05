// Loading from the server: the contact list, pages of a chat, what changed
// while the connection was down, and the pinned list.
import { contactsApi, conversationsApi } from "../../shared/api/endpoints";
import { ApiError } from "../../shared/api/http";
import type { ContactRow, LiveMessage, WireMessage } from "../../shared/api/types";
import {
	applyWire,
	evictCaches,
	getCache,
	updateCache,
	updateExisting,
	withNewestPage,
	withOlderPage,
} from "../state/chatModel";
import { contactsRev, getRow, setAllRows, upsertRow } from "../state/contactModel";
import { contacts, outbox, ui } from "../state/stores";
import { noteServerTime } from "./clock";
import { showToast } from "./feedback";
import * as realtime from "./realtime";

export const PAGE_SIZE = 50;
const MAX_PAGE = 100;
const CONTACTS_PAGE = 200;

// ─── Contacts ─────────────────────────────────────────────────────────────
let contactsInFlight: Promise<void> | null = null;
let contactsAgain = false;

async function fetchAllContacts(): Promise<ContactRow[]> {
	const all: ContactRow[] = [];
	const seen = new Set<number>();
	for (let skip = 0; skip < 100_000; ) {
		const page = await contactsApi.page(CONTACTS_PAGE, skip);
		let added = 0;
		for (const row of page) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			all.push(row);
			added++;
		}
		if (page.length < CONTACTS_PAGE || added === 0) break;
		skip += page.length;
	}
	return all;
}

/**
 * Loads the whole contact list (all pages) and puts it in memory (rows that
 * changed here meanwhile keep their newer state). Asked again while loading,
 * it loads once more afterwards: the first answer may predate the reason.
 */
export function refreshContacts(): Promise<void> {
	if (contactsInFlight) {
		contactsAgain = true;
		return contactsInFlight;
	}
	contactsInFlight = (async () => {
		try {
			do {
				contactsAgain = false;
				const askedAt = contactsRev();
				setAllRows(await fetchAllContacts(), askedAt);
			} while (contactsAgain);
		} finally {
			contactsInFlight = null;
		}
	})();
	return contactsInFlight;
}

/** First load, retried until it works (the app shows skeletons meanwhile). */
export async function loadContactsUntilDone(): Promise<void> {
	let delay = 3000;
	let told = false;
	for (;;) {
		try {
			await refreshContacts();
			return;
		} catch (e) {
			if (e instanceof ApiError && e.status === 401) throw e;
			contacts.set((s) => ({ ...s, failed: true }));
			if (!told) {
				told = true;
				showToast("Couldn't load your chats. Retrying…", { icon: "error" });
			}
			await new Promise((r) => window.setTimeout(r, delay));
			delay = Math.min(delay * 2, 30_000);
		}
	}
}

const rowRefresh = new Map<number, number>();

/** Fetches one contact row again soon (its preview after a deletion, say). */
export function refreshRowSoon(convId: number, delay = 400): void {
	if (rowRefresh.has(convId)) return;
	rowRefresh.set(
		convId,
		window.setTimeout(async () => {
			rowRefresh.delete(convId);
			const row = getRow(convId);
			if (!row) return;
			try {
				upsertRow(await contactsApi.get(row.id));
			} catch {
				/* the next full refresh fixes it */
			}
		}, delay),
	);
}

// ─── Messages ─────────────────────────────────────────────────────────────

/** Removes sends the server already has (their ack was lost), deleted since or not. */
export function settleOutbox(messages: WireMessage[]): void {
	const ids = new Set<string>();
	for (const m of messages) if (m.clientId) ids.add(m.clientId);
	if (ids.size === 0) return;
	outbox.set((s) => {
		let changed = false;
		const next = { ...s };
		for (const id of ids) {
			if (next[id]) {
				delete next[id];
				changed = true;
			}
		}
		return changed ? next : s;
	});
}

const loading = new Map<number, Promise<void>>();

/** Loads the newest page of a chat (enough to show where unread messages start). */
export function loadNewest(convId: number): Promise<void> {
	const running = loading.get(convId);
	if (running) return running;
	const unread = getRow(convId)?.unreadCount ?? 0;
	const limit = Math.min(Math.max(unread + 20, PAGE_SIZE), MAX_PAGE);
	const p = (async () => {
		updateCache(convId, (c) => (c.status === "ready" ? c : { ...c, status: "loading" }));
		try {
			const page = await conversationsApi.page(convId, { limit });
			noteServerTime(page.cursor);
			settleOutbox(page.messages);
			updateCache(convId, (c) => withNewestPage(c, page));
		} catch (e) {
			updateCache(convId, (c) => (c.status === "ready" ? c : { ...c, status: "error" }));
			throw e;
		} finally {
			loading.delete(convId);
		}
	})();
	loading.set(convId, p);
	return p;
}

/** Brings a cached chat up to date: what changed since it was last in sync. */
export async function catchUp(convId: number): Promise<void> {
	const c = getCache(convId);
	if (!c || c.status !== "ready" || !c.cursor) return loadNewest(convId);
	const since = c.staleSince && c.staleSince > c.cursor ? c.staleSince : c.cursor;
	const startedStale = c.staleSince;
	try {
		const res = await conversationsApi.changes(convId, since);
		noteServerTime(res.cursor);
		if (res.reset) {
			// too much happened: start over with the newest page
			updateExisting(convId, (x) => ({ ...x, messages: [], hasMore: false, status: "loading" }));
			return loadNewest(convId);
		}
		settleOutbox(res.messages);
		updateExisting(convId, (x) => {
			const next = applyWire(x, res.messages);
			// a newer disconnect during the request keeps it stale
			return { ...next, cursor: res.cursor, staleSince: x.staleSince !== startedStale ? x.staleSince : null };
		});
	} catch (e) {
		if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return;
		throw e;
	}
}

/**
 * catchUp, tried again a little later if it fails, for as long as the chat is
 * open and the connection is up (a reconnect starts a new one).
 */
export async function catchUpPersistently(convId: number): Promise<void> {
	for (let delay = 2000; ; delay = Math.min(delay * 2, 30_000)) {
		try {
			await catchUp(convId);
			return;
		} catch {
			await new Promise((r) => window.setTimeout(r, delay));
			if (ui.get().openConvId !== convId || !realtime.isConnected() || !getCache(convId)?.staleSince) return;
		}
	}
}

/** Makes the chat's messages ready to show: loaded, or brought up to date. */
export async function prepareChat(convId: number): Promise<void> {
	updateCache(convId, (c) => ({ ...c, usedAt: Date.now() }));
	evictCaches(convId);
	const c = getCache(convId);
	const work = !c || c.status !== "ready" ? loadNewest(convId) : c.staleSince ? catchUp(convId) : Promise.resolve();
	if (!c?.pinned) void loadPinned(convId);
	await work;
}

/** One page of older messages. */
export async function loadOlder(convId: number): Promise<boolean> {
	const c = getCache(convId);
	if (!c || c.status !== "ready" || !c.hasMore || c.loadingOlder) return false;
	const first = c.messages[0];
	if (!first) return false;
	updateExisting(convId, (x) => ({ ...x, loadingOlder: true }));
	try {
		const page = await conversationsApi.page(convId, { limit: PAGE_SIZE, before: first.createdAt, beforeId: first.id });
		updateExisting(convId, (x) => withOlderPage(x, page));
		return true;
	} catch {
		updateExisting(convId, (x) => ({ ...x, loadingOlder: false }));
		return false;
	}
}

/** Loads older pages until a message is in memory (for jumping to it). */
export async function loadUntil(convId: number, messageId: number, maxPages = 20): Promise<LiveMessage | null> {
	for (let i = 0; i <= maxPages; i++) {
		const c = getCache(convId);
		if (!c) return null;
		const found = c.messages.find((m) => m.id === messageId);
		if (found) return found;
		// an id smaller than every loaded one may still be older history
		if (!c.hasMore) return null;
		if (ui.get().openConvId !== convId) return null;
		const ok = await loadOlder(convId);
		if (!ok) return null;
	}
	return null;
}

export async function loadPinned(convId: number): Promise<void> {
	try {
		const { pinned } = await conversationsApi.pinned(convId);
		updateExisting(convId, (c) => ({ ...c, pinned: pinned.filter((p) => !c.gone[p.id]) }));
	} catch {
		/* the bar stays hidden; opening the chat again retries */
	}
}
