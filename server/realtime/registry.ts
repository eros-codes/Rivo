// Who is connected: userId → socket ids, and helpers to reach a user's
// devices. Routes, jobs and the socket layer all send through here.
// Every event goes out typed against the contract (shared/events.ts): a
// payload that does not match what the app expects is a type error here.
import { getMembersCached } from "../services/caches.ts";
import type { ServerEvents } from "../../shared/events.ts";

/** What the socket layer keeps on each connection (socket.data). */
export interface SocketData {
	/** the signed-in user */
	userId: number;
	/** the signed-in device (session) */
	sid: string;
	/** the conversations open on this device right now */
	joined: Set<number>;
	/** joins and leaves run one after another */
	joining: Promise<void>;
	/** last "typing" sent, per conversation and kind */
	typingAt: Map<string, number>;
	/** the app is in the background (no "seen", push instead) */
	hidden: boolean;
}

/** The part of a Socket.IO socket this module uses. */
export interface LiveSocket {
	readonly id: string;
	data: Partial<SocketData>;
	emit(event: string, ...args: unknown[]): unknown;
	disconnect(close?: boolean): unknown;
}
/** The part of the Socket.IO server this module uses. */
export interface LiveServer {
	readonly sockets: { readonly sockets: Map<string, LiveSocket> };
}

export const userSockets = new Map<number, Set<string>>();
let io: LiveServer | null = null;

export function setIo(instance: LiveServer): void {
	io = instance;
}

export function getSocketById(id: string): LiveSocket | null {
	try {
		return io?.sockets?.sockets?.get(id) || null;
	} catch {
		return null;
	}
}

export function socketsOfUser(userId: number): LiveSocket[] {
	const out: LiveSocket[] = [];
	for (const sid of userSockets.get(userId) || []) {
		const s = getSocketById(sid);
		if (s) out.push(s);
	}
	return out;
}

export function addSocket(userId: number, socketId: string): void {
	const set = userSockets.get(userId) || new Set<string>();
	set.add(socketId);
	userSockets.set(userId, set);
}

/** Removes a socket; true when the user has no socket left. */
export function removeSocket(userId: number, socketId: string): boolean {
	const set = userSockets.get(userId);
	if (!set) return true;
	set.delete(socketId);
	if (set.size === 0) {
		userSockets.delete(userId);
		return true;
	}
	return false;
}

export function isOnline(userId: number): boolean {
	return (userSockets.get(userId)?.size || 0) > 0;
}

/** The app is open and visible on at least one of the user's devices. */
export function hasVisibleSocket(userId: number): boolean {
	return socketsOfUser(userId).some((s) => !s.data?.hidden);
}

/** The user is looking at this conversation right now. */
export function isUserViewing(userId: number, convId: number): boolean {
	return socketsOfUser(userId).some((s) => !s.data?.hidden && s.data?.joined?.has(convId));
}

export function emitToUser<E extends keyof ServerEvents>(userId: number, event: E, payload: ServerEvents[E], { exceptSocketId = null }: { exceptSocketId?: string | null } = {}): void {
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
export interface DeliverOptions<P> {
	/** the device that made the change (it shows it already) */
	exceptSocketId?: string | null;
	/** a payload per member, or undefined to skip that member */
	perUser?: ((userId: number) => P | undefined) | null;
}

export async function deliverToConversation<E extends keyof ServerEvents>(
	convId: number,
	event: E,
	payload: ServerEvents[E] | null,
	{ exceptSocketId = null, perUser = null }: DeliverOptions<ServerEvents[E]> = {},
): Promise<void> {
	const members = await getMembersCached(convId);
	for (const { userId } of members) {
		const p = perUser ? perUser(userId) : payload;
		if (p === undefined || p === null) continue;
		emitToUser(userId, event, p, { exceptSocketId });
	}
}

/** Ends the live connection of a signed-out device (or all of a user's). */
export function endSockets({ userId = null, sessionId = null, exceptSocketId = null }: { userId?: number | null; sessionId?: string | null; exceptSocketId?: string | null } = {}): void {
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
