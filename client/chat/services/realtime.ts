// The live connection to the server (socket.io), typed: events in, requests
// out with an acknowledgement and a timeout, and the connection status.
import { io, type Socket } from "socket.io-client";
import type { ClientEvents, ServerEvents } from "../../shared/api/types";
import { connection } from "../state/stores";

type Handler<E extends keyof ServerEvents> = (payload: ServerEvents[E]) => void;

let socket: Socket | null = null;
const handlers = new Map<string, Set<(payload: never) => void>>();
let lifecycle: {
	onConnect: (first: boolean) => void;
	onDisconnect: () => void;
	/** `certain`: the server said so; otherwise the handshake was refused and the session should be checked */
	onSessionEnded: (certain: boolean) => void;
} | null = null;
let retryTimer: number | null = null;
let retryDelay = 1000;
let connectedOnce = false;
let ended = false;
/** when the server was last heard from (any event, or its keep-alive ping) */
let heardAt = 0;
const heard = () => {
	heardAt = Date.now();
};

const visible = () => document.visibilityState !== "hidden";

/** Subscribes to a server event; returns the unsubscribe function. */
export function on<E extends keyof ServerEvents>(
	event: E,
	handler: Handler<E>,
): () => void {
	let set = handlers.get(event);
	if (!set) {
		set = new Set();
		handlers.set(event, set);
		listen(event);
	}
	set.add(handler as (payload: never) => void);
	return () => set.delete(handler as (payload: never) => void);
}

/**
 * Passes a server event from the socket to its subscribers. Takes a plain
 * string: socket.io types a listener by the event's name, and for a generic
 * name (`E extends keyof ServerEvents`) TypeScript cannot work out that type.
 * The payload's type is checked where the handlers subscribe, in `on`.
 */
function listen(event: string): void {
	socket?.on(event, (payload: unknown) => dispatch(event, payload));
}

function dispatch(event: string, payload: unknown): void {
	for (const h of [...(handlers.get(event) ?? [])]) {
		try {
			(h as (p: unknown) => void)(payload);
		} catch (e) {
			console.error(`handler for ${event} failed`, e);
		}
	}
}

export function socketId(): string | null {
	return socket?.connected ? (socket.id ?? null) : null;
}

export function isConnected(): boolean {
	return !!socket?.connected;
}

/**
 * How long ago the server was last heard from. A phone that slept with the
 * page open notices the lost connection only when it wakes: everything since
 * the last sign of life may have been missed, not just since the disconnect.
 */
export function silentForMs(): number {
	return heardAt ? Math.max(0, Date.now() - heardAt) : 0;
}

/** Fire-and-forget (typing, visibility, joining a chat). Dropped while offline. */
export function send<E extends keyof ClientEvents>(
	event: E,
	...args: ClientEvents[E] extends [infer P] ? [P] : never
): void {
	if (!socket?.connected) return;
	socket.emit(event, ...args);
}

type AckOf<E extends keyof ClientEvents> = ClientEvents[E] extends [
	unknown,
	(ack: infer A) => void,
]
	? A
	: never;
type PayloadOf<E extends keyof ClientEvents> = ClientEvents[E] extends [
	infer P,
	unknown,
]
	? P
	: never;

/** Requests waiting for an answer: they fail at once when the connection drops. */
const inflight = new Set<() => void>();

/** Thrown when an action could not reach the server or got no answer. */
export class OfflineError extends Error {
	constructor(message = "No connection") {
		super(message);
		this.name = "OfflineError";
	}
}

/**
 * Sends an action and waits for the server's answer. Rejects with
 * OfflineError when not connected or unanswered within `timeoutMs` (the
 * action may still have happened: retries must be idempotent).
 */
export function request<E extends keyof ClientEvents>(
	event: E,
	payload: PayloadOf<E>,
	timeoutMs = 10_000,
): Promise<AckOf<E>> {
	return new Promise((resolve, reject) => {
		if (!socket?.connected) {
			reject(new OfflineError());
			return;
		}
		let done = false;
		const fail = (why: string) => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			inflight.delete(lost);
			reject(new OfflineError(why));
		};
		// an answer can only come on the connection the request went out on
		const lost = () => fail("Connection lost");
		const timer = window.setTimeout(
			() => fail("The server did not answer"),
			timeoutMs,
		);
		inflight.add(lost);
		socket.emit(event, payload, (ack: AckOf<E>) => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			inflight.delete(lost);
			resolve(ack);
		});
	});
}

function scheduleRetry(): void {
	if (ended || retryTimer !== null) return;
	const delay = retryDelay;
	retryDelay = Math.min(retryDelay * 2, 30_000);
	retryTimer = window.setTimeout(
		() => {
			retryTimer = null;
			if (!ended && socket && !socket.connected) socket.connect();
		},
		delay + Math.random() * 500,
	);
}

/** Opens the connection (once). */
export function connect(callbacks: NonNullable<typeof lifecycle>): void {
	if (socket) return;
	lifecycle = callbacks;
	socket = io({
		withCredentials: true,
		// sent with every (re)connection: hidden tabs and phones in a pocket
		// get push notifications and never mark messages as read
		auth: (cb) => cb({ visible: visible() }),
	});

	for (const event of handlers.keys()) listen(event);
	socket.onAny(heard);
	// the server's keep-alive (every few seconds while connected)
	socket.io.on("ping", heard);

	socket.on("connect", () => {
		heard();
		retryDelay = 1000;
		if (retryTimer !== null) {
			window.clearTimeout(retryTimer);
			retryTimer = null;
		}
		const first = !connectedOnce;
		connectedOnce = true;
		connection.set({ status: "online", everConnected: true });
		lifecycle?.onConnect(first);
	});

	socket.on("disconnect", (reason) => {
		for (const lost of [...inflight]) lost();
		connection.set((s) => ({ ...s, status: "offline" }));
		lifecycle?.onDisconnect();
		// the server closed it on purpose (signed out): it does not come back
		if (reason === "io server disconnect" && !ended) scheduleRetry();
	});

	socket.on("connect_error", (err) => {
		connection.set((s) => ({
			...s,
			status: s.everConnected ? "offline" : "connecting",
		}));
		const msg = String(err?.message || "");
		if (msg === "Unauthorized" || msg === "Session ended") {
			// the session may have ended (or the cookie was being renewed)
			lifecycle?.onSessionEnded(false);
			return;
		}
		// refused by the server (busy, rate limited): the client does not retry these itself
		if (!socket?.active) scheduleRetry();
	});

	socket.on("session:ended", () => {
		ended = true;
		lifecycle?.onSessionEnded(true);
	});

	socket.io.on("reconnect_attempt", () => {
		connection.set((s) => ({
			...s,
			status: s.everConnected ? "offline" : "connecting",
		}));
	});

	document.addEventListener("visibilitychange", () => {
		if (socket?.connected)
			socket.emit("presence:visibility", { visible: visible() });
		// a phone waking up: reconnect now rather than at the next retry
		if (visible() && socket && !socket.connected && !ended)
			socket.connect();
	});
	window.addEventListener("online", () => {
		if (socket && !socket.connected && !ended) socket.connect();
	});
	// leaving the page: the server hears it right away (presence); a page kept
	// in the back/forward cache reconnects when it is shown again
	window.addEventListener("pagehide", () => socket?.disconnect());
	window.addEventListener("pageshow", (e) => {
		if (e.persisted && socket && !socket.connected && !ended)
			socket.connect();
	});
}

/** Tries again after the session was confirmed valid (a refused handshake). */
export function retrySoon(): void {
	scheduleRetry();
}

/** Closes the connection for good (signing out). */
export function disconnect(): void {
	ended = true;
	if (retryTimer !== null) window.clearTimeout(retryTimer);
	socket?.disconnect();
}
