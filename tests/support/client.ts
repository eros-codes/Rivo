// A test user's device: HTTP with a cookie jar and the CSRF header, and live
// connections (socket.io) that keep every event they receive.
//
// Typed by the app's own contract (shared/api.ts, shared/events.ts): name the
// endpoint and the answer is typed — get<"GET /api/contacts">("/api/contacts")
// — and an event's payload, answer and pushes are the ones the server is
// checked against. A field renamed there is a type error here. Without an
// endpoint the answer is read loosely (an error, or a request that is wrong
// on purpose).
import { io, type Socket } from "socket.io-client";
import type { z } from "zod";
import type { Answer, Body, Endpoint, LiveMessage, Me, WireMessage } from "../../shared/api.ts";
import type { ClientAcks, ClientEventName, ClientEventSchemas, ServerEvents } from "../../shared/events.ts";
import type { Mail } from "./backend.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let seq = 0;
/** A unique name for this run (usernames are unique in the shared test database). */
export function uniq(prefix = "u"): string {
	return `${prefix}${Date.now().toString(36).slice(-5)}${process.pid % 1000}${++seq}`.slice(0, 30);
}

export interface Reply<T> {
	status: number;
	data: T;
	headers: Headers;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type EndpointOf<M extends Method> = Extract<Endpoint, `${M} ${string}`>;
/** An answer the test did not type: an error ({ error }), or a body read loosely. */
type Loose = any;
type DataOf<E> = [E] extends [never] ? Loose : E extends Endpoint ? Answer<E> : never;
type BodyOf<E> = [E] extends [never] ? unknown : E extends Endpoint ? Body<E> : never;

/** Where the backend helpers are (loaded when used: the integration test runs without a database). */
const backend = () => import("./backend.ts");

export class Api {
	readonly base: string;
	readonly userAgent: string;
	readonly jar = new Map<string, string>();

	constructor(base: string, { userAgent = "RivoTest/1.0 (X11; Linux x86_64) Chrome/130" }: { userAgent?: string } = {}) {
		this.base = base;
		this.userAgent = userAgent;
	}
	cookieHeader(): string {
		return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
	}
	/** The CSRF token the server set ("rivo_csrf", or "__Host-rivo_csrf" in production). */
	csrf(): string {
		for (const [k, v] of this.jar) if (/csrf/i.test(k)) return v;
		return "";
	}
	remember(res: Response): void {
		for (const line of res.headers.getSetCookie()) {
			const [pair = "", ...attrs] = line.split(";");
			const i = pair.indexOf("=");
			const k = pair.slice(0, i).trim();
			const v = decodeURIComponent(pair.slice(i + 1).trim());
			const expired = !v || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /expires=thu, 01 jan 1970/i.test(a.trim()));
			if (expired) this.jar.delete(k);
			else this.jar.set(k, v);
		}
	}
	/**
	 * Any request, answered loosely (`X-CSRF-Token` in `headers` replaces the
	 * real one). A FormData body goes as a multipart form, anything else as JSON.
	 */
	async req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply<Loose>> {
		const headers: Record<string, string> = { "User-Agent": this.userAgent, ...extraHeaders };
		const cookies = this.cookieHeader();
		if (cookies) headers.Cookie = cookies;
		if (!["GET", "HEAD"].includes(method) && !("X-CSRF-Token" in extraHeaders)) {
			const t = this.csrf();
			if (t) headers["X-CSRF-Token"] = t;
		}
		let payload: string | FormData | undefined;
		if (body instanceof FormData) {
			// (fetch writes the Content-Type, with the form's boundary)
			payload = body;
		} else if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const res = await fetch(this.base + path, { method, headers, body: payload, redirect: "manual" });
		this.remember(res);
		const text = await res.text();
		let data: unknown = text;
		try {
			data = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, data, headers: res.headers };
	}
	get<E extends EndpointOf<"GET"> = never>(path: string, headers?: Record<string, string>): Promise<Reply<DataOf<E>>> {
		return this.req("GET", path, undefined, headers);
	}
	post<E extends EndpointOf<"POST"> = never>(path: string, body?: BodyOf<E>, headers?: Record<string, string>): Promise<Reply<DataOf<E>>> {
		return this.req("POST", path, body ?? {}, headers);
	}
	patch<E extends EndpointOf<"PATCH"> = never>(path: string, body?: BodyOf<E>, headers?: Record<string, string>): Promise<Reply<DataOf<E>>> {
		return this.req("PATCH", path, body ?? {}, headers);
	}
	del<E extends EndpointOf<"DELETE"> = never>(path: string, body?: BodyOf<E>, headers?: Record<string, string>): Promise<Reply<DataOf<E>>> {
		return this.req("DELETE", path, body, headers);
	}
	/** The emails the server has "sent" (test servers write them to a file). */
	async mails(): Promise<Mail[]> {
		return (await backend()).mails(this.base);
	}
	/** One Prisma call on the test database (see backend.ts): a row, typed by the caller. */
	async db<T = any>(model: string, op: string, args?: unknown): Promise<T> {
		return (await backend()).db<T>(this.base, model, op, args);
	}
	/** Sign-up the way the app does it: code by email, then the account. */
	async signup({ name, email, username, password }: { name: string; email: string; username: string; password: string }): Promise<Answer<"POST /api/auth/register">> {
		let r = await this.post<"POST /api/auth/send-code">("/api/auth/send-code", { email });
		if (r.status !== 200) throw new Error(`send-code ${r.status} ${JSON.stringify(r.data)}`);
		const mail = (await this.mails()).filter((m) => m.to.toLowerCase() === email.toLowerCase()).pop();
		const code = /(\d{6})/.exec(mail?.text ?? "")?.[1];
		if (!code) throw new Error(`no code was emailed to ${email}`);
		r = await this.post<"POST /api/auth/verify-code">("/api/auth/verify-code", { email, code });
		if (r.status !== 200) throw new Error(`verify-code ${r.status}`);
		const done = await this.post<"POST /api/auth/register">("/api/auth/register", { name, email, username, password });
		if (done.status !== 201) throw new Error(`register ${done.status} ${JSON.stringify(done.data)}`);
		return done.data;
	}
	async login(identifier: string, password: string): Promise<Answer<"POST /api/auth/login">> {
		const r = await this.post<"POST /api/auth/login">("/api/auth/login", { identifier, password });
		if (r.status !== 200) throw new Error(`login ${r.status} ${JSON.stringify(r.data)}`);
		return r.data;
	}
	socket(auth: Record<string, unknown> = { visible: true }): TestSocket {
		return new TestSocket(this, auth);
	}
}

/** What the server accepts with an event (its schema's input: ids may be digits too). */
export type Payload<E extends ClientEventName> = z.input<(typeof ClientEventSchemas)[E]>;

interface Seen {
	ev: string;
	data: unknown;
	used: boolean;
}

/** A live connection that keeps every event, so a test can wait for one that already came. */
export class TestSocket {
	readonly io: Socket;
	readonly events: Seen[] = [];
	readonly ready: Promise<TestSocket>;
	/** the server ended the connection (not this side) */
	serverDisconnected = false;
	private waiters: { ev: string; pred?: (d: unknown) => boolean; resolve: (d: unknown) => void }[] = [];

	constructor(api: Api, auth: Record<string, unknown>) {
		this.io = io(api.base, {
			transports: ["websocket"],
			forceNew: true,
			reconnection: false,
			extraHeaders: { Cookie: api.cookieHeader(), "User-Agent": api.userAgent },
			auth,
		});
		this.io.onAny((ev: string, ...args: unknown[]) => {
			const e: Seen = { ev, data: args[0], used: false };
			this.events.push(e);
			for (const w of [...this.waiters]) {
				if (w.ev === ev && (!w.pred || w.pred(e.data))) {
					e.used = true;
					this.waiters = this.waiters.filter((x) => x !== w);
					w.resolve(e.data);
					break;
				}
			}
		});
		this.io.on("disconnect", (reason) => {
			if (reason === "io server disconnect") this.serverDisconnected = true;
		});
		this.ready = new Promise((resolve, reject) => {
			this.io.once("connect", () => resolve(this));
			this.io.once("connect_error", (e: Error) => reject(new Error(e?.message || String(e))));
		});
	}
	get id(): string | undefined {
		return this.io.id;
	}
	/** An event without an answer (typing, joining a chat, …). */
	emit<E extends ClientEventName>(ev: E, data: Payload<E>): void {
		this.io.emit(ev, data);
	}
	/** An event and the server's answer to it. */
	request<E extends keyof ClientAcks>(ev: E, data: Payload<E>, timeout = 5000): Promise<ClientAcks[E]> {
		return this.io.timeout(timeout).emitWithAck(ev, data);
	}
	/** Anything at all (an event the server does not know, a payload of the wrong shape). */
	requestRaw(ev: string, data: unknown, timeout = 5000): Promise<Loose> {
		return this.io.timeout(timeout).emitWithAck(ev, data);
	}
	/** The next `ev` (one that already came counts) that `pred` accepts. */
	waitFor<E extends keyof ServerEvents>(ev: E, pred?: (d: ServerEvents[E]) => boolean, timeout = 5000): Promise<ServerEvents[E]> {
		const test = pred as ((d: unknown) => boolean) | undefined;
		const hit = this.events.find((e) => !e.used && e.ev === ev && (!test || test(e.data)));
		if (hit) {
			hit.used = true;
			return Promise.resolve(hit.data as ServerEvents[E]);
		}
		return new Promise((resolve, reject) => {
			const w = { ev, pred: test, resolve: (_: unknown) => {} };
			const t = setTimeout(() => {
				this.waiters = this.waiters.filter((x) => x !== w);
				reject(new Error(`no "${ev}" within ${timeout} ms`));
			}, timeout);
			w.resolve = (d) => {
				clearTimeout(t);
				resolve(d as ServerEvents[E]);
			};
			this.waiters.push(w);
		});
	}
	/** Every `ev` received so far. */
	of<E extends keyof ServerEvents>(ev: E): ServerEvents[E][] {
		return this.events.filter((e) => e.ev === ev).map((e) => e.data as ServerEvents[E]);
	}
	close(): void {
		this.io.close();
	}
}

/** The answer of a request that has to succeed (otherwise the test fails with the server's reason). */
export function ok<A extends { success?: true; error?: string }>(ack: A): Extract<A, { success: true }> {
	if (!ack?.success) throw new Error(`the server refused: ${JSON.stringify(ack)}`);
	return ack as Extract<A, { success: true }>;
}

/** A message that has to be a live one (a deleted one is only a tombstone). */
export function live(m: WireMessage | undefined): LiveMessage {
	if (!m || m.isDeleted) throw new Error(`expected a live message, got ${JSON.stringify(m)}`);
	return m;
}

/** A signed-in user with a fresh account. */
export class TestUser extends Api {
	username = "";
	email = "";
	me!: Me;
}

export async function newUser(base: string, name = "User"): Promise<TestUser> {
	const api = new TestUser(base);
	const username = uniq(name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8) || "u");
	const email = `${username}@test.io`;
	await api.signup({ name, email, username, password: "password123" });
	await api.login(username, "password123");
	api.username = username;
	api.email = email;
	api.me = (await api.get<"GET /api/users/me">("/api/users/me")).data;
	return api;
}

/** `a` adds `b` as a contact; returns a's contact row. */
export async function befriend(a: Api, b: TestUser): Promise<Answer<"POST /api/contacts">> {
	const r = await a.post<"POST /api/contacts">("/api/contacts", { username: b.username });
	if (r.status !== 201) throw new Error(`add contact ${r.status} ${JSON.stringify(r.data)}`);
	return r.data;
}

export const conv = (row: { conversationId: number }): number => row.conversationId;
