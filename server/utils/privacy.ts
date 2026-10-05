// Privacy helpers shared by the HTTP routes and the socket layer.
//
// Every user chooses who may see their online status, email and profile
// picture: "everyone", "contacts" (people *they* have saved as a contact) or
// "nobody". Blocking someone also hides all three from that person.
//
// A contact row the server made by itself (someone added this user, which
// puts them in this user's list too) is not "saved by them": otherwise anyone
// could see a "contacts only" profile just by adding its owner.
import prisma from "../prisma.ts";

/** How one user treats another: saved them as a contact, blocked them. */
export interface Relation {
	hasViewer: boolean;
	blockedViewer: boolean;
}

/** The fields a privacy setting can hide, and the settings themselves. */
export interface PrivacyFields {
	privacyOnline?: string;
	privacyEmail?: string;
	privacyProfile?: string;
	passwordHash?: string;
	passwordChangedAt?: Date | null;
	isOnline?: boolean;
	lastSeen?: Date | null;
	email?: string | null;
	profilePics?: string[];
}
/** A user as someone else sees them: the settings and secrets are gone. */
export type Private<T> = Omit<T, "privacyOnline" | "privacyEmail" | "privacyProfile" | "passwordHash" | "passwordChangedAt">;

/**
 * How each user in `targetIds` treats `viewerId`.
 * @returns {Promise<Map<number, { hasViewer: boolean, blockedViewer: boolean }>>}
 */
export async function relationsFor(viewerId: number, targetIds: readonly (number | null | undefined)[] | null | undefined): Promise<Map<number, Relation>> {
	const ids = [...new Set((targetIds || []).filter((id): id is number => Number.isInteger(id) && id !== viewerId))];
	const map = new Map<number, Relation>();
	if (!Number.isInteger(viewerId) || ids.length === 0) return map;
	const rows = await prisma.contact.findMany({
		where: { ownerId: { in: ids }, contactId: viewerId },
		select: { ownerId: true, isBlocked: true, addedByOwner: true },
	});
	for (const r of rows) {
		const cur = map.get(r.ownerId) || { hasViewer: false, blockedViewer: false };
		if (r.addedByOwner) cur.hasViewer = true;
		if (r.isBlocked) cur.blockedViewer = true;
		map.set(r.ownerId, cur);
	}
	return map;
}

/**
 * How `targetId` treats each user in `viewerIds` (the audience of a broadcast).
 * @returns {Promise<Map<number, { hasViewer: boolean, blockedViewer: boolean }>>}
 */
export async function audienceOf(targetId: number, viewerIds: readonly (number | null | undefined)[] | null | undefined): Promise<Map<number, Relation>> {
	const ids = [...new Set((viewerIds || []).filter((id): id is number => Number.isInteger(id) && id !== targetId))];
	const map = new Map<number, Relation>();
	if (!Number.isInteger(targetId) || ids.length === 0) return map;
	const rows = await prisma.contact.findMany({
		where: { ownerId: targetId, contactId: { in: ids } },
		select: { contactId: true, isBlocked: true, addedByOwner: true },
	});
	for (const r of rows) {
		const cur = map.get(r.contactId) || { hasViewer: false, blockedViewer: false };
		if (r.addedByOwner) cur.hasViewer = true;
		if (r.isBlocked) cur.blockedViewer = true;
		map.set(r.contactId, cur);
	}
	return map;
}

/** Whether a viewer with relation `rel` may see a field protected by `setting`. */
export function canSee(setting: string | undefined, rel: Relation | null | undefined): boolean {
	if (rel && rel.blockedViewer) return false;
	if (setting === "nobody") return false;
	if (setting === "contacts") return !!(rel && rel.hasViewer);
	return true;
}

/**
 * Returns a copy of `user` with the fields the viewer may not see cleared and
 * the privacy settings themselves removed.
 */
export function applyPrivacy<T extends PrivacyFields>(user: T, rel: Relation | null | undefined): Private<T> {
	if (!user || typeof user !== "object") return user;
	const out: PrivacyFields = { ...user };
	if (!canSee(user.privacyOnline, rel)) {
		if ("isOnline" in out) out.isOnline = false;
		if ("lastSeen" in out) out.lastSeen = null;
	}
	if ("email" in out && !canSee(user.privacyEmail, rel)) out.email = null;
	if ("profilePics" in out && !canSee(user.privacyProfile, rel)) out.profilePics = [];
	delete out.privacyOnline;
	delete out.privacyEmail;
	delete out.privacyProfile;
	delete out.passwordHash;
	delete out.passwordChangedAt;
	return out as Private<T>;
}
