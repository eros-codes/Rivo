// Real-time connection: authentication, presence and the socket events.
// The actions themselves live in services/messages.ts (shared with REST).
// The events are the contract of shared/events.ts: each payload is checked
// against its schema there (ClientEventSchemas), each answer is type-checked
// against its ack (ClientAcks), each event sent against ServerEvents.
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { bus } from "../events.ts";
import { loadSession, parseCookies, readToken, touchSession, type LiveSession } from "../auth/sessions.ts";
import { ClientEventSchemas, type ClientAcks, type ClientEventName, type ClientPayload } from "../../shared/events.ts";
import { check, type Checked } from "../http/validate.ts";
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

// (Socket.IO's own event maps stay loose: every payload arrives unchecked
// and goes through its schema first; what is sent goes through the typed
// helpers of realtime/registry.ts.)
type Events = { [event: string]: (...args: any[]) => void };
export type RivoServer = Server<Events, Events, Events, SocketData>;
type RivoSocket = Socket<Events, Events, Events, SocketData>;

/** How many items a batch payload names (its cost is counted before it is checked). */
function sizeOf(payload: unknown, key: string): number {
	const list = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
	return Array.isArray(list) ? list.length : 1;
}

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
		const on = (event: ClientEventName | "disconnect", handler: (...args: any[]) => unknown) =>
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
		/** The client's callback for an event's answer (a no-op when it sent none). */
		const answer = <E extends keyof ClientAcks>(cb: unknown): ((result: ClientAcks[E]) => void) =>
			typeof cb === "function" ? (cb as (result: ClientAcks[E]) => void) : () => {};
		const limited = (cb: unknown, cost = 1): boolean => {
			if (spendBudget(userId, cost)) return false;
			answer(cb)(RATE_LIMITED);
			return true;
		};

		/** An event's payload after its schema, or why it was refused. */
		const read = <E extends ClientEventName>(event: E, payload: unknown): Checked<ClientPayload<E>> =>
			check(ClientEventSchemas[event], payload) as Checked<ClientPayload<E>>;

		/**
		 * An action event: its cost comes out of the action budget first (a
		 * flood of bad payloads is not free), then the payload is checked; a
		 * bad one is answered { error } and goes no further. `run` must answer
		 * what the app expects (ClientAcks).
		 */
		function action<E extends keyof ClientAcks>(event: E, cost: number | ((payload: unknown) => number), run: (data: ClientPayload<E>) => Promise<ClientAcks[E]>): void {
			on(event, async (payload: unknown, cb: unknown) => {
				if (limited(cb, typeof cost === "function" ? cost(payload) : cost)) return;
				const input = read(event, payload);
				if (!input.ok) return answer<E>(cb)({ error: input.error });
				answer<E>(cb)(await run(input.data));
			});
		}

		on("presence:visibility", (payload: unknown) => {
			// only an explicit "not visible" hides the device
			const input = read("presence:visibility", payload);
			socket.data.hidden = input.ok && !input.data.visible;
		});

		action("message:send", 1, (data) => sendMessageAs(actor(), data));
		action("messages:forward", (p) => batchCost(sizeOf(p, "items"), 5), (data) => forwardMessagesAs(actor(), data));
		action("message:edit", 1, (data) => editMessageAs(actor(), data));
		action("messages:delete", (p) => batchCost(sizeOf(p, "messageIds"), 10), (data) => deleteMessagesAs(actor(), data));
		action("message:pin", 1, (data) => togglePinAs(actor(), data));
		action("reaction:add", 1, (data) => reactAs(actor(), data));

		on("message:seen", async (payload: unknown, cb: unknown) => {
			const reply = answer<"message:seen">(cb);
			const input = read("message:seen", payload);
			if (!input.ok) return reply({ error: input.error });
			// a "join" sent just before is still being checked: wait for it
			await socket.data.joining;
			// only the device that shows the chat, while visible, marks it read
			if (!socket.data.joined.has(input.data.conversationId) || socket.data.hidden) return reply({ success: true, marked: [] });
			reply(await markSeenAs(actor(), input.data));
		});

		/** The chat a typing / join / leave event names, or null (then it is ignored). */
		const chatOf = (payload: unknown): number | null => {
			const input = read("conversation:join", payload);
			return input.ok ? input.data.conversationId : null;
		};

		function relayTyping(event: "typing:start" | "typing:stop", payload: unknown): void {
			const convId = chatOf(payload);
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
				const out = { userId, conversationId: convId };
				await deliverToConversation(convId, event, null, { perUser: (uid) => (uid === userId ? undefined : out) });
			})().catch((e: unknown) => log.error(`${event} relay failed`, messageOf(e) || e));
		}
		on("typing:start", (payload: unknown) => relayTyping("typing:start", payload));
		on("typing:stop", (payload: unknown) => relayTyping("typing:stop", payload));

		on("conversation:join", (payload: unknown) => {
			const convId = chatOf(payload);
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
						void cleanupSeenOneTime(userId, old);
					}
					socket.join(`conversation:${convId}`);
					socket.data.joined.add(convId);
				} catch (e) {
					log.error("conversation:join failed", messageOf(e) || e);
				}
			});
		});

		on("conversation:leave", (payload: unknown) => {
			const convId = chatOf(payload);
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
