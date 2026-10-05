// Real-time connection: authentication, presence and the socket events.
// The actions themselves live in services/messages.js (shared with REST).
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { bus } from "../events.ts";
import { loadSession, parseCookies, readToken, touchSession, type LiveSession } from "../auth/sessions.ts";
import { parseId } from "../utils/validators.ts";
import { batchCost, RATE_LIMITED, spendBudget } from "../services/actionLimit.ts";
import { blockState, getRecipientsCached, isMember } from "../services/caches.ts";
import { broadcastPresence } from "../services/presence.ts";
import {
	addSocket,
	deliverToConversation,
	endSockets,
	removeSocket,
	setIo,
	userSockets,
	type SocketData,
} from "../realtime/registry.ts";
import {
	cleanupSeenOneTime,
	deleteMessagesAs,
	editMessageAs,
	forwardMessagesAs,
	markSeenAs,
	reactAs,
	sendMessageAs,
	togglePinAs,
	type Actor,
} from "../services/messages.ts";
import { log, withLogContext } from "../utils/logger.ts";
import { messageOf } from "../utils/errors.ts";

export { userSockets };

// The events are not typed one by one yet: each handler checks what it gets.
type Events = { [event: string]: (...args: any[]) => void };
export type RivoServer = Server<Events, Events, Events, SocketData>;
type RivoSocket = Socket<Events, Events, Events, SocketData>;
/** What a client sends with an event (nothing in it is trusted). */
type Incoming = { [key: string]: unknown } | null | undefined;

/**
 * The client's address the same way Express reads it with "trust proxy" 1:
 * the entry our own proxy appended (the last one). Earlier entries come from
 * the client and can be anything.
 */
function clientIp(socket: RivoSocket): string {
	if (config.trustProxy) {
		const fwd = socket.handshake.headers?.["x-forwarded-for"];
		const last = fwd ? String(fwd).split(",").pop()?.trim() : "";
		if (last) return last;
	}
	return socket.handshake.address || "";
}

export function initSocket(httpServer: HttpServer): RivoServer {
	const { socket: S } = config;
	const io: RivoServer = new Server<Events, Events, Events, SocketData>(httpServer, {
		cors: {
			origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.has(origin) ? origin || true : false),
			credentials: true,
		},
		pingInterval: S.pingInterval,
		pingTimeout: S.pingTimeout,
		// a forwarded batch of long messages fits; anything larger is not ours
		maxHttpBufferSize: 512 * 1024,
	});
	setIo(io);

	// ─── Limits ────────────────────────────────────────────────────────────
	const attempts = new Map<string, number[]>(); // ip → timestamps (handshake floods)

	setInterval(() => {
		const now = Date.now();
		for (const [ip, arr] of attempts) {
			const recent = arr.filter((t) => now - t < S.connAttempt.windowMs).slice(-S.connAttempt.storeMax);
			if (recent.length) attempts.set(ip, recent);
			else attempts.delete(ip);
		}
		while (attempts.size > S.connAttempt.mapMax) {
			const oldest = attempts.keys().next().value;
			if (oldest === undefined) break;
			attempts.delete(oldest);
		}
	}, Math.max(10_000, Math.floor(S.connAttempt.windowMs / 4))).unref?.();

	// ─── Handshake: rate + session ─────────────────────────────────────────
	io.use(async (socket, next) => {
		const ip = clientIp(socket);
		const now = Date.now();
		const recent = (attempts.get(ip) || []).filter((t) => t > now - S.connAttempt.windowMs);
		recent.push(now);
		attempts.set(ip, recent.slice(-S.connAttempt.storeMax));
		if (recent.length > S.connAttempt.max) return next(new Error("RateLimit"));

		const payload = readToken(parseCookies(socket.handshake.headers?.cookie)[config.session.cookie]);
		if (!payload) return next(new Error("Unauthorized"));
		let session: LiveSession | null;
		try {
			session = await loadSession(payload);
		} catch (e) {
			log.error("socket session lookup failed", e);
			return next(new Error("ServiceUnavailable"));
		}
		if (!session) return next(new Error("Session ended"));
		touchSession(session, payload, null);
		socket.data.userId = session.userId;
		socket.data.sid = session.id;
		socket.data.joined = new Set();
		socket.data.joining = Promise.resolve();
		socket.data.typingAt = new Map();
		// hidden tabs and phones in a pocket get push notifications and never
		// mark messages as read
		socket.data.hidden = socket.handshake.auth?.visible === false;
		next();
	});

	// A signed-out device loses its live connection right away
	bus.on("session:revoked", ({ sid, userId }) => endSockets({ userId, sessionId: sid }));

	const offlineTimers = new Map<number, NodeJS.Timeout>();

	io.on("connection", (socket) => {
		const userId = socket.data.userId;
		// log lines written while handling this socket's events say whose they are
		const on = (event: string, handler: (...args: any[]) => unknown) =>
			socket.on(event, (...args: unknown[]) => withLogContext({ userId, socket: socket.id }, () => handler(...args)));
		addSocket(userId, socket.id);
		if (offlineTimers.has(userId)) {
			clearTimeout(offlineTimers.get(userId));
			offlineTimers.delete(userId);
		}

		(async () => {
			try {
				await prisma.user.update({ where: { id: userId }, data: { isOnline: true } });
				await broadcastPresence(userId, { online: true });
			} catch (e) {
				log.error("presence on connect failed", messageOf(e) || e);
			}
		})();

		const actor = (): Actor => ({ userId, socketId: socket.id });
		const answer = (cb: unknown): ((result: unknown) => void) => (typeof cb === "function" ? (cb as (result: unknown) => void) : () => {});
		const limited = (cb: unknown, cost = 1): boolean => {
			if (spendBudget(userId, cost)) return false;
			answer(cb)(RATE_LIMITED);
			return true;
		};

		on("presence:visibility", (p: Incoming) => {
			socket.data.hidden = p?.visible === false;
		});

		on("message:send", async (data: Incoming, cb: unknown) => {
			if (!data || typeof data !== "object") return answer(cb)({ error: "Invalid data" });
			if (limited(cb)) return;
			answer(cb)(await sendMessageAs(actor(), data));
		});

		on("messages:forward", async (data: Incoming, cb: unknown) => {
			if (limited(cb, batchCost(Array.isArray(data?.items) ? data.items.length : 1, 5))) return;
			answer(cb)(await forwardMessagesAs(actor(), data || {}));
		});

		on("message:edit", async (data: Incoming, cb: unknown) => {
			if (limited(cb)) return;
			answer(cb)(await editMessageAs(actor(), data || {}));
		});

		on("message:delete", async (data: Incoming, cb: unknown) => {
			if (limited(cb)) return;
			answer(cb)(await deleteMessagesAs(actor(), { messageIds: [data?.messageId] }));
		});

		on("messages:delete", async (data: Incoming, cb: unknown) => {
			if (limited(cb, batchCost(Array.isArray(data?.messageIds) ? data.messageIds.length : 1, 10))) return;
			answer(cb)(await deleteMessagesAs(actor(), data || {}));
		});

		on("message:pin", async (data: Incoming, cb: unknown) => {
			if (limited(cb)) return;
			answer(cb)(await togglePinAs(actor(), data || {}));
		});

		on("reaction:add", async (data: Incoming, cb: unknown) => {
			if (limited(cb)) return;
			answer(cb)(await reactAs(actor(), data || {}));
		});

		on("message:seen", async (data: Incoming, cb: unknown) => {
			const reply = answer(cb);
			const convId = parseId(data?.conversationId);
			// a "join" sent just before is still being checked: wait for it
			await socket.data.joining;
			// only the device that shows the chat, while visible, marks it read
			if (!convId || !socket.data.joined.has(convId) || socket.data.hidden) return reply({ success: true, marked: [] });
			reply(await markSeenAs(actor(), { conversationId: convId, upToId: data?.upToId }));
		});

		function relayTyping(event: string, data: Incoming): void {
			const convId = parseId(data?.conversationId);
			// only in the chat this device shows (no lookups for made-up ids)
			if (!convId || !socket.data.joined.has(convId)) return;
			const key = `${convId}:${event}`;
			const now = Date.now();
			if (now - (socket.data.typingAt.get(key) || 0) < S.typingThrottleMs) return;
			socket.data.typingAt.set(key, now);
			(async () => {
				if (!(await isMember(convId, userId))) return;
				const { blockedByMe, blockedByOther } = blockState(await getRecipientsCached(convId), userId);
				if (blockedByMe || blockedByOther) return;
				const payload = { userId, conversationId: convId };
				await deliverToConversation(convId, event, null, { perUser: (uid) => (uid === userId ? undefined : payload) });
			})().catch((e: unknown) => log.error(`${event} relay failed`, messageOf(e) || e));
		}
		on("typing:start", (d: Incoming) => relayTyping("typing:start", d));
		on("typing:stop", (d: Incoming) => relayTyping("typing:stop", d));

		on("conversation:join", (data: Incoming) => {
			const convId = parseId(data?.conversationId);
			// cheap, but each one is a lookup: part of the same budget
			if (!convId || !spendBudget(userId, 0.25)) return;
			// joins are applied in the order they were sent, and anything that
			// depends on them (marking read) waits for the last one
			socket.data.joining = socket.data.joining.then(async () => {
				try {
					if (!(await isMember(convId, userId))) return;
					// one chat on screen per device
					for (const old of socket.data.joined) {
						if (old === convId) continue;
						socket.data.joined.delete(old);
						socket.data.typingAt.clear();
						socket.leave(`conversation:${old}`);
						cleanupSeenOneTime(userId, old);
					}
					socket.join(`conversation:${convId}`);
					socket.data.joined.add(convId);
				} catch (e) {
					log.error("conversation:join failed", messageOf(e) || e);
				}
			});
		});

		on("conversation:leave", (data: Incoming) => {
			const convId = parseId(data?.conversationId);
			if (!convId) return;
			// after any join sent before it
			socket.data.joining = socket.data.joining.then(async () => {
				if (!socket.data.joined.has(convId)) return;
				socket.leave(`conversation:${convId}`);
				socket.data.joined.delete(convId);
				await cleanupSeenOneTime(userId, convId);
			}).catch((e: unknown) => log.error("conversation:leave failed", messageOf(e) || e));
		});

		on("disconnect", () => {
			const lastSeen = new Date();
			const none = removeSocket(userId, socket.id);
			for (const convId of socket.data.joined) cleanupSeenOneTime(userId, convId);
			socket.data.joined.clear();
			if (!none || offlineTimers.has(userId)) return;
			// a short grace period: a phone switching networks is not "offline"
			const t = setTimeout(async () => {
				offlineTimers.delete(userId);
				if (userSockets.has(userId)) return;
				try {
					await prisma.user.update({ where: { id: userId }, data: { isOnline: false, lastSeen } });
					await broadcastPresence(userId, { online: false, lastSeen });
				} catch (e) {
					log.error("presence on disconnect failed", messageOf(e) || e);
				}
			}, S.offlineGraceMs);
			offlineTimers.set(userId, t);
		});
	});

	return io;
}
