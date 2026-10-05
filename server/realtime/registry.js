// Who is connected: userId → socket ids, and helpers to reach a user's
// devices. Routes, jobs and the socket layer all send through here.
import { getMembersCached } from "../services/caches.js";

export const userSockets = new Map();
let io = null;

export function setIo(instance) {
	io = instance;
}

export function getSocketById(id) {
	try {
		return io?.sockets?.sockets?.get(id) || null;
	} catch {
		return null;
	}
}

export function socketsOfUser(userId) {
	const out = [];
	for (const sid of userSockets.get(userId) || []) {
		const s = getSocketById(sid);
		if (s) out.push(s);
	}
	return out;
}

export function addSocket(userId, socketId) {
	const set = userSockets.get(userId) || new Set();
	set.add(socketId);
	userSockets.set(userId, set);
}

/** Removes a socket; true when the user has no socket left. */
export function removeSocket(userId, socketId) {
	const set = userSockets.get(userId);
	if (!set) return true;
	set.delete(socketId);
	if (set.size === 0) {
		userSockets.delete(userId);
		return true;
	}
	return false;
}

export function isOnline(userId) {
	return (userSockets.get(userId)?.size || 0) > 0;
}

/** The app is open and visible on at least one of the user's devices. */
export function hasVisibleSocket(userId) {
	return socketsOfUser(userId).some((s) => !s.data?.hidden);
}

/** The user is looking at this conversation right now. */
export function isUserViewing(userId, convId) {
	return socketsOfUser(userId).some((s) => !s.data?.hidden && s.data?.joined?.has(convId));
}

export function emitToUser(userId, event, payload, { exceptSocketId = null } = {}) {
	for (const s of socketsOfUser(userId)) {
		if (exceptSocketId && s.id === exceptSocketId) continue;
		try {
			s.emit(event, payload);
		} catch {
			/* one broken socket must not stop the others */
		}
	}
}

/**
 * Sends an event to every device of every member of a conversation.
 * `perUser(userId)` may return a different payload per member, or undefined
 * to skip that member.
 */
export async function deliverToConversation(convId, event, payload, { exceptSocketId = null, perUser = null } = {}) {
	const members = await getMembersCached(convId);
	for (const { userId } of members) {
		const p = perUser ? perUser(userId) : payload;
		if (p === undefined) continue;
		emitToUser(userId, event, p, { exceptSocketId });
	}
}

/** Ends the live connection of a signed-out device (or all of a user's). */
export function endSockets({ userId = null, sessionId = null, exceptSocketId = null } = {}) {
	const targets = userId != null ? socketsOfUser(userId) : io ? [...io.sockets.sockets.values()] : [];
	for (const s of targets) {
		if (exceptSocketId && s.id === exceptSocketId) continue;
		if (sessionId && s.data?.sid !== sessionId) continue;
		try {
			s.emit("session:ended");
			s.disconnect(true);
		} catch {
			/* ignore */
		}
	}
}
