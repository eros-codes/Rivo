// Short-lived caches of who is in a conversation. Every send, typing event
// and seen receipt needs them; routes invalidate them when rows change.
import prisma from "../prisma.ts";
import { envNumber } from "../config.ts";

const TTL = envNumber("RECIPIENTS_CACHE_TTL_MS", 30_000);
const MAX = envNumber("RECIPIENTS_CACHE_MAX", 5000);
const MEMBERSHIP_TTL = envNumber("MEMBERSHIP_CACHE_TTL_MS", 30_000);
const MEMBERSHIP_MAX = envNumber("MEMBERSHIP_CACHE_MAX", 10_000);

/** A conversation's contact row as the caches keep it: whose list it is in, muted, blocked… */
export type Recipient = Awaited<ReturnType<typeof loadRecipients>>[number];
/** A member of a conversation (also someone who removed the contact). */
export interface Member {
	userId: number;
	isDeleted: boolean;
}

const membership = new Map<string, { res: boolean; ts: number }>(); // `${convId}:${userId}`
const recipients = new Map<number, { data: Recipient[]; ts: number }>(); // convId → contact rows
const members = new Map<number, { data: Member[]; ts: number }>(); // convId → members

function put<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	if (map.size >= max) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

export async function isMember(convId: number, userId: number): Promise<boolean> {
	const key = `${convId}:${userId}`;
	const hit = membership.get(key);
	if (hit && Date.now() - hit.ts < MEMBERSHIP_TTL) return hit.res;
	const row = await prisma.conversationMember.findFirst({ where: { conversationId: convId, userId }, select: { id: true } });
	put(membership, key, { res: !!row, ts: Date.now() }, MEMBERSHIP_MAX);
	return !!row;
}

/** Contact rows of a conversation: whose list it is in, muted, blocked… */
function loadRecipients(convId: number) {
	return prisma.contact.findMany({
		where: { conversationId: convId },
		select: { id: true, ownerId: true, contactId: true, isMuted: true, isBlocked: true, nickname: true, isSaved: true, isArchived: true, addedByOwner: true },
	});
}

export async function getRecipientsCached(convId: number, fresh = false): Promise<Recipient[]> {
	const hit = recipients.get(convId);
	if (!fresh && hit && Date.now() - hit.ts < TTL) return hit.data;
	const data = await loadRecipients(convId);
	put(recipients, convId, { data, ts: Date.now() }, MAX);
	return data;
}

export async function getMembersCached(convId: number, fresh = false): Promise<Member[]> {
	const hit = members.get(convId);
	if (!fresh && hit && Date.now() - hit.ts < TTL) return hit.data;
	const rows = await prisma.conversationMember.findMany({
		where: { conversationId: convId },
		select: { userId: true, user: { select: { isDeleted: true } } },
	});
	const seen = new Set<number>();
	const data: Member[] = [];
	for (const r of rows) {
		if (seen.has(r.userId)) continue;
		seen.add(r.userId);
		data.push({ userId: r.userId, isDeleted: !!r.user?.isDeleted });
	}
	put(members, convId, { data, ts: Date.now() }, MAX);
	return data;
}

/** Call after contact rows or members of a conversation change. */
export function invalidateConversation(convId: number | string): void {
	const id = Number(convId);
	if (!Number.isInteger(id)) return;
	recipients.delete(id);
	members.delete(id);
	for (const key of membership.keys()) if (key.startsWith(`${id}:`)) membership.delete(key);
}

export function invalidateAll(): void {
	recipients.clear();
	members.clear();
	membership.clear();
}

/** Block state of a 1:1 conversation from its contact rows. */
export function blockState(rows: readonly Pick<Recipient, "ownerId" | "isBlocked">[], userId: number): { blockedByMe: boolean; blockedByOther: boolean } {
	const own = rows.find((r) => r.ownerId === userId);
	return {
		blockedByMe: !!own?.isBlocked,
		blockedByOther: rows.some((r) => r.ownerId !== userId && r.isBlocked),
	};
}
