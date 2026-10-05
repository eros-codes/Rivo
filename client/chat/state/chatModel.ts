// The loaded part of each chat. Messages arrive from several places that can
// overlap in time (a page being loaded, live events, a catch-up after a
// reconnect), so every change is merged, never blindly replaced:
//  - a copy with an older `updatedAt` never overwrites a newer one;
//  - "seen" and "opened" only ever go one way;
//  - a message deleted while the chat is cached never comes back from an
//    older copy.
// The list stays ordered (oldest first) and holds every message once.
import type { LiveMessage, MessagePage, PinnedItem, WireMessage } from "../../shared/api/types";
import { chats } from "./stores";
import type { ConvCache } from "./types";

/** Chats kept in memory besides the open one. */
const MAX_CACHED = 12;
/** Deleted ids remembered per chat. */
const MAX_GONE = 500;

export function compareMessages(a: { createdAt: string; id: number }, b: { createdAt: string; id: number }): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return a.id - b.id;
}

export function emptyCache(): ConvCache {
	return {
		messages: [],
		hasMore: false,
		cursor: null,
		status: "loading",
		loadingOlder: false,
		staleSince: null,
		pinned: null,
		gone: {},
		usedAt: Date.now(),
	};
}

export function getCache(convId: number | null | undefined): ConvCache | null {
	if (convId === null || convId === undefined) return null;
	return chats.get()[convId] ?? null;
}

/** Changes a chat's cache (created empty, in "loading" state, if missing). */
export function updateCache(convId: number, fn: (c: ConvCache) => ConvCache): void {
	chats.set((s) => {
		const cur = s[convId];
		const next = fn(cur ?? emptyCache());
		if (cur && next === cur) return s;
		return { ...s, [convId]: next };
	});
}

/** Changes a chat's cache only when it exists. */
export function updateExisting(convId: number, fn: (c: ConvCache) => ConvCache): void {
	chats.set((s) => {
		const cur = s[convId];
		if (!cur) return s;
		const next = fn(cur);
		return next === cur ? s : { ...s, [convId]: next };
	});
}

/** The newer of two copies of a message, keeping one-way flags. */
export function newerCopy(existing: LiveMessage, incoming: LiveMessage): LiveMessage {
	const base = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
	const isSeen = existing.isSeen || incoming.isSeen;
	// once readable, a capsule stays readable
	const unlocked = !existing.isLocked && existing.isTimeCapsule && existing.text !== null ? existing : null;
	let out = base.isSeen === isSeen ? base : { ...base, isSeen };
	if (unlocked && out.isLocked) out = { ...out, isLocked: false, text: unlocked.text, openedAt: unlocked.openedAt ?? out.openedAt };
	// the sender's own id for it is only sent to the sender: keep it
	if (!out.clientId && (existing.clientId || incoming.clientId)) out = { ...out, clientId: existing.clientId ?? incoming.clientId };
	return out;
}

/** Index where `m` belongs (binary search on createdAt, id). */
function insertionIndex(list: LiveMessage[], m: LiveMessage): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (compareMessages(list[mid]!, m) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Adds or updates messages. One older than the oldest loaded message is left
 * out when older history exists (it belongs to a page not loaded yet).
 */
export function mergeMessages(c: ConvCache, incoming: LiveMessage[]): ConvCache {
	if (incoming.length === 0) return c;
	let list = c.messages;
	let copied = false;
	const copy = () => {
		if (!copied) {
			list = [...list];
			copied = true;
		}
	};
	for (const m of incoming) {
		if (c.gone[m.id]) continue;
		const at = list.findIndex((x) => x.id === m.id);
		if (at >= 0) {
			const merged = newerCopy(list[at]!, m);
			if (merged !== list[at]) {
				copy();
				list[at] = merged;
			}
			continue;
		}
		const first = list[0];
		if (c.hasMore && first && compareMessages(m, first) < 0) continue;
		copy();
		list.splice(insertionIndex(list, m), 0, m);
	}
	return list === c.messages ? c : { ...c, messages: list };
}

function rememberGone(gone: Record<number, true>, ids: number[]): Record<number, true> {
	const next = { ...gone };
	for (const id of ids) next[id] = true;
	const keys = Object.keys(next);
	if (keys.length > MAX_GONE) for (const k of keys.slice(0, keys.length - MAX_GONE)) delete next[Number(k)];
	return next;
}

export function removeFromCache(c: ConvCache, ids: number[]): ConvCache {
	if (ids.length === 0) return c;
	const drop = new Set(ids);
	const messages = c.messages.some((m) => drop.has(m.id)) ? c.messages.filter((m) => !drop.has(m.id)) : c.messages;
	const pinned = c.pinned && c.pinned.some((p) => drop.has(p.id)) ? c.pinned.filter((p) => !drop.has(p.id)) : c.pinned;
	return { ...c, messages, pinned, gone: rememberGone(c.gone, ids) };
}

/** The chat was cleared up to `upToId`: those messages and their pins go, newer ones stay. */
export function clearUpTo(c: ConvCache, upToId: number): ConvCache {
	const next = removeFromCache(
		c,
		c.messages.filter((m) => m.id <= upToId).map((m) => m.id),
	);
	const pinned = next.pinned && next.pinned.some((p) => p.id <= upToId) ? next.pinned.filter((p) => p.id > upToId) : next.pinned;
	// nothing older is left on the server either
	return { ...next, pinned, hasMore: false };
}

/** Keeps the pinned list in step with messages that changed. */
function syncPinned(pinned: PinnedItem[] | null, changed: LiveMessage[]): PinnedItem[] | null {
	if (!pinned || changed.length === 0) return pinned;
	let next = pinned;
	for (const m of changed) {
		const has = next.some((p) => p.id === m.id);
		if (m.isPinned && !has) next = insertPinned(next, m);
		else if (!m.isPinned && has) next = next.filter((p) => p.id !== m.id);
		else if (m.isPinned && has) next = next.map((p) => (p.id === m.id && p.text !== m.text ? { ...p, text: m.text } : p));
	}
	return next;
}

/** Applies changes from the server (live messages and tombstones). */
export function applyWire(c: ConvCache, wire: WireMessage[]): ConvCache {
	const removed: number[] = [];
	const live: LiveMessage[] = [];
	for (const m of wire) {
		if (m.isDeleted) removed.push(m.id);
		else live.push(m);
	}
	let next = removeFromCache(c, removed);
	next = mergeMessages(next, live);
	const pinned = syncPinned(next.pinned, live.filter((m) => !next.gone[m.id]));
	return pinned === next.pinned ? next : { ...next, pinned };
}

/**
 * Puts the newest page in place. Messages that arrived live while it loaded
 * (newer than the page) are kept, and so are their newer versions of
 * messages the page also has.
 */
export function withNewestPage(c: ConvCache, page: MessagePage): ConvCache {
	const live = page.messages.filter((m): m is LiveMessage => !m.isDeleted && !c.gone[m.id]);
	const newest = live[live.length - 1];
	const byId = new Map(c.messages.map((m) => [m.id, m]));
	const messages = live.map((m) => {
		const had = byId.get(m.id);
		return had ? newerCopy(had, m) : m;
	});
	const inPage = new Set(messages.map((m) => m.id));
	const later = c.messages.filter((m) => !inPage.has(m.id) && (!newest || compareMessages(m, newest) > 0));
	return {
		...c,
		messages: later.length ? [...messages, ...later].sort(compareMessages) : messages,
		hasMore: page.hasMore,
		cursor: page.cursor,
		status: "ready",
		staleSince: null,
	};
}

/** Adds an older page in front. */
export function withOlderPage(c: ConvCache, page: MessagePage): ConvCache {
	const first = c.messages[0];
	const older = page.messages.filter(
		(m): m is LiveMessage => !m.isDeleted && !c.gone[m.id] && (!first || compareMessages(m, first) < 0),
	);
	return { ...c, messages: [...older, ...c.messages], hasMore: page.hasMore, loadingOlder: false };
}

export function patchMessage(c: ConvCache, id: number, patch: Partial<LiveMessage>): ConvCache {
	const at = c.messages.findIndex((m) => m.id === id);
	if (at < 0) return c;
	const messages = [...c.messages];
	messages[at] = { ...messages[at]!, ...patch };
	return { ...c, messages };
}

export function insertPinned(list: PinnedItem[], m: Pick<LiveMessage, "id" | "text" | "senderId" | "createdAt">): PinnedItem[] {
	const item: PinnedItem = { id: m.id, text: m.text, senderId: m.senderId, createdAt: m.createdAt };
	return [...list.filter((p) => p.id !== m.id), item].sort(compareMessages);
}

/** Marks every cached chat as needing a catch-up (the connection dropped). */
export function markAllStale(since: string): void {
	chats.set((s) => {
		let changed = false;
		const next: Record<number, ConvCache> = {};
		for (const [k, c] of Object.entries(s)) {
			if (c.staleSince || c.status !== "ready") next[Number(k)] = c;
			else {
				next[Number(k)] = { ...c, staleSince: since };
				changed = true;
			}
		}
		return changed ? next : s;
	});
}

/** Drops the least recently used chats (never the open one). */
export function evictCaches(keepConvId: number | null): void {
	const all = Object.entries(chats.get());
	if (all.length <= MAX_CACHED + 1) return;
	const victims = all
		.filter(([k]) => Number(k) !== keepConvId)
		.sort(([, a], [, b]) => a.usedAt - b.usedAt)
		.slice(0, all.length - MAX_CACHED - 1)
		.map(([k]) => Number(k));
	chats.set((s) => {
		const next = { ...s };
		for (const k of victims) delete next[k];
		return next;
	});
}

export function dropCache(convId: number): void {
	chats.set((s) => {
		if (!s[convId]) return s;
		const next = { ...s };
		delete next[convId];
		return next;
	});
}

export function findMessage(convId: number, messageId: number): LiveMessage | null {
	return getCache(convId)?.messages.find((m) => m.id === messageId) ?? null;
}
