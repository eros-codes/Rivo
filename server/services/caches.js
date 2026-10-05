// Short-lived caches of who is in a conversation. Every send, typing event
// and seen receipt needs them; routes invalidate them when rows change.
import prisma from "../prisma.js";
import { envNumber } from "../config.js";

const TTL = envNumber("RECIPIENTS_CACHE_TTL_MS", 30_000);
const MAX = envNumber("RECIPIENTS_CACHE_MAX", 5000);
const MEMBERSHIP_TTL = envNumber("MEMBERSHIP_CACHE_TTL_MS", 30_000);
const MEMBERSHIP_MAX = envNumber("MEMBERSHIP_CACHE_MAX", 10_000);

const membership = new Map(); // `${convId}:${userId}` → { res, ts }
const recipients = new Map(); // convId → { data, ts }  (contact rows)
const members = new Map(); // convId → { data, ts }  (members, also people who removed the contact)

function put(map, key, value, max) {
	if (map.size >= max) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

export async function isMember(convId, userId) {
	const key = `${convId}:${userId}`;
	const hit = membership.get(key);
	if (hit && Date.now() - hit.ts < MEMBERSHIP_TTL) return hit.res;
	const row = await prisma.conversationMember.findFirst({ where: { conversationId: convId, userId }, select: { id: true } });
	put(membership, key, { res: !!row, ts: Date.now() }, MEMBERSHIP_MAX);
	return !!row;
}

/** Contact rows of a conversation: whose list it is in, muted, blocked… */
export async function getRecipientsCached(convId, fresh = false) {
	const hit = recipients.get(convId);
	if (!fresh && hit && Date.now() - hit.ts < TTL) return hit.data;
	const data = await prisma.contact.findMany({
		where: { conversationId: convId },
		select: { id: true, ownerId: true, contactId: true, isMuted: true, isBlocked: true, nickname: true, isSaved: true, isArchived: true, addedByOwner: true },
	});
	put(recipients, convId, { data, ts: Date.now() }, MAX);
	return data;
}

export async function getMembersCached(convId, fresh = false) {
	const hit = members.get(convId);
	if (!fresh && hit && Date.now() - hit.ts < TTL) return hit.data;
	const rows = await prisma.conversationMember.findMany({
		where: { conversationId: convId },
		select: { userId: true, user: { select: { isDeleted: true } } },
	});
	const seen = new Set();
	const data = [];
	for (const r of rows) {
		if (seen.has(r.userId)) continue;
		seen.add(r.userId);
		data.push({ userId: r.userId, isDeleted: !!r.user?.isDeleted });
	}
	put(members, convId, { data, ts: Date.now() }, MAX);
	return data;
}

/** Call after contact rows or members of a conversation change. */
export function invalidateConversation(convId) {
	const id = Number(convId);
	if (!Number.isInteger(id)) return;
	recipients.delete(id);
	members.delete(id);
	for (const key of membership.keys()) if (key.startsWith(`${id}:`)) membership.delete(key);
}

export function invalidateAll() {
	recipients.clear();
	members.clear();
	membership.clear();
}

/** Block state of a 1:1 conversation from its contact rows. */
export function blockState(rows, userId) {
	const own = rows.find((r) => r.ownerId === userId);
	return {
		blockedByMe: !!own?.isBlocked,
		blockedByOther: rows.some((r) => r.ownerId !== userId && r.isBlocked),
	};
}
