// Online state and profile changes, pushed to the people who have the user as
// a contact, each according to the user's privacy settings and blocks.
import prisma from "../prisma.js";
import { audienceOf, canSee } from "../utils/privacy.js";
import { emitToUser } from "../realtime/registry.js";
import { log } from "../utils/logger.js";

async function ownersOf(userId) {
	const rows = await prisma.contact.findMany({ where: { contactId: userId, ownerId: { not: userId } }, select: { ownerId: true } });
	return [...new Set(rows.map((r) => r.ownerId))];
}

/**
 * With `notifyHidden`, people who may no longer see the state are told the
 * user is offline (used when the setting changes while they are looking).
 */
export async function broadcastPresence(userId, { online, lastSeen = null, notifyHidden = false } = {}) {
	try {
		const me = await prisma.user.findUnique({ where: { id: userId }, select: { privacyOnline: true, isDeleted: true } });
		if (!me) return;
		const owners = await ownersOf(userId);
		if (owners.length === 0) return;
		const rel = await audienceOf(userId, owners);
		const seen = lastSeen ? new Date(lastSeen).toISOString() : null;
		for (const ownerId of owners) {
			const allowed = !me.isDeleted && canSee(me.privacyOnline, rel.get(ownerId));
			if (allowed) {
				if (online) emitToUser(ownerId, "user:online", { userId });
				else emitToUser(ownerId, "user:offline", { userId, lastSeen: seen, privacyOnline: me.privacyOnline });
			} else if (notifyHidden) {
				emitToUser(ownerId, "user:offline", { userId, lastSeen: null, privacyOnline: "nobody" });
			}
		}
	} catch (e) {
		log.error("broadcastPresence failed", e?.message || e);
	}
}

/** Name, username, bio and picture changes (the picture subject to privacy). */
export async function broadcastUserUpdate(userId) {
	try {
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, name: true, username: true, bio: true, profilePics: true, privacyProfile: true, privacyEmail: true, email: true, isDeleted: true },
		});
		if (!user) return;
		const base = { id: user.id, name: user.name, username: user.username, bio: user.bio || "", isDeleted: !!user.isDeleted };
		// the user's own devices always get everything
		if (!user.isDeleted) emitToUser(userId, "user:updated", { ...base, email: user.email, profilePics: user.profilePics || [] });
		const owners = await ownersOf(userId);
		if (owners.length === 0) return;
		const rel = await audienceOf(userId, owners);
		for (const ownerId of owners) {
			const r = rel.get(ownerId);
			emitToUser(ownerId, "user:updated", {
				...base,
				profilePics: !user.isDeleted && canSee(user.privacyProfile, r) ? user.profilePics || [] : [],
				email: !user.isDeleted && canSee(user.privacyEmail, r) ? user.email : null,
			});
		}
	} catch (e) {
		log.error("broadcastUserUpdate failed", e?.message || e);
	}
}
