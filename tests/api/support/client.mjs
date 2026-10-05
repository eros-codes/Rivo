// A test user's device: HTTP with a cookie jar and the CSRF header, and live
// connections (socket.io) that record every event they receive.
import { io } from "socket.io-client";
import { db, mails } from "./backend.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** A unique name for this run (usernames are unique in the shared test database). */
export function uniq(prefix = "u") {
	return `${prefix}${Date.now().toString(36).slice(-5)}${process.pid % 1000}${++seq}`.slice(0, 30);
}

export class Api {
	constructor(base, { userAgent = "RivoTest/1.0 (X11; Linux x86_64) Chrome/130" } = {}) {
		this.base = base;
		this.jar = new Map();
		this.userAgent = userAgent;
	}
	cookieHeader() {
		return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
	}
	csrf() {
		for (const [k, v] of this.jar) if (/csrf/i.test(k)) return v;
		return "";
	}
	remember(res) {
		for (const line of res.headers.getSetCookie?.() ?? []) {
			const [pair, ...attrs] = line.split(";");
			const i = pair.indexOf("=");
			const k = pair.slice(0, i).trim();
			const v = decodeURIComponent(pair.slice(i + 1).trim());
			const expired = !v || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /expires=thu, 01 jan 1970/i.test(a.trim()));
			if (expired) this.jar.delete(k);
			else this.jar.set(k, v);
		}
	}
	async req(method, path, body, extraHeaders = {}) {
		const headers = { "User-Agent": this.userAgent, ...extraHeaders };
		const cookies = this.cookieHeader();
		if (cookies) headers.Cookie = cookies;
		if (!["GET", "HEAD"].includes(method) && !("X-CSRF-Token" in extraHeaders)) {
			const t = this.csrf();
			if (t) headers["X-CSRF-Token"] = t;
		}
		let payload;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const res = await fetch(this.base + path, { method, headers, body: payload, redirect: "manual" });
		this.remember(res);
		const text = await res.text();
		let data = text;
		try {
			data = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, data, headers: res.headers };
	}
	get(p, h) {
		return this.req("GET", p, undefined, h);
	}
	post(p, b, h) {
		return this.req("POST", p, b ?? {}, h);
	}
	patch(p, b, h) {
		return this.req("PATCH", p, b ?? {}, h);
	}
	del(p, b, h) {
		return this.req("DELETE", p, b, h);
	}
	mails() {
		return mails(this.base);
	}
	db(model, op, args) {
		return db(this.base, model, op, args);
	}
	/** Sign-up the way the app does it: code by email, then the account. */
	async signup({ name, email, username, password }) {
		let r = await this.post("/api/auth/send-code", { email });
		if (r.status !== 200) throw new Error(`send-code ${r.status} ${JSON.stringify(r.data)}`);
		const mail = (await this.mails()).filter((m) => m.to.toLowerCase() === email.toLowerCase()).pop();
		const code = /(\d{6})/.exec(mail?.text ?? "")?.[1];
		if (!code) throw new Error(`no code was emailed to ${email}`);
		r = await this.post("/api/auth/verify-code", { email, code });
		if (r.status !== 200) throw new Error(`verify-code ${r.status}`);
		r = await this.post("/api/auth/register", { name, email, username, password });
		if (r.status !== 201) throw new Error(`register ${r.status} ${JSON.stringify(r.data)}`);
		return r.data;
	}
	async login(identifier, password) {
		const r = await this.post("/api/auth/login", { identifier, password });
		if (r.status !== 200) throw new Error(`login ${r.status} ${JSON.stringify(r.data)}`);
		return r.data;
	}
	socket(auth = { visible: true }) {
		return new TestSocket(this, auth);
	}
}

/** A live connection that keeps every event, so a test can wait for one that already came. */
export class TestSocket {
	constructor(api, auth) {
		this.events = [];
		this.waiters = [];
		this.serverDisconnected = false;
		this.io = io(api.base, {
			transports: ["websocket"],
			forceNew: true,
			reconnection: false,
			extraHeaders: { Cookie: api.cookieHeader(), "User-Agent": api.userAgent },
			auth,
		});
		this.io.onAny((ev, ...args) => {
			const e = { ev, data: args[0], used: false };
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
			this.io.once("connect_error", (e) => reject(new Error(e?.message || String(e))));
		});
	}
	get id() {
		return this.io.id;
	}
	emit(ev, data) {
		this.io.emit(ev, data);
	}
	request(ev, data, timeout = 5000) {
		return this.io.timeout(timeout).emitWithAck(ev, data);
	}
	waitFor(ev, pred, timeout = 5000) {
		const hit = this.events.find((e) => !e.used && e.ev === ev && (!pred || pred(e.data)));
		if (hit) {
			hit.used = true;
			return Promise.resolve(hit.data);
		}
		return new Promise((resolve, reject) => {
			const w = { ev, pred, resolve };
			const t = setTimeout(() => {
				this.waiters = this.waiters.filter((x) => x !== w);
				reject(new Error(`no "${ev}" within ${timeout} ms`));
			}, timeout);
			w.resolve = (d) => {
				clearTimeout(t);
				resolve(d);
			};
			this.waiters.push(w);
		});
	}
	of(ev) {
		return this.events.filter((e) => e.ev === ev).map((e) => e.data);
	}
	close() {
		this.io.close();
	}
}

/** A signed-in user with a fresh account. */
export async function newUser(base, name = "User") {
	const api = new Api(base);
	const username = uniq(name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8) || "u");
	const email = `${username}@test.io`;
	await api.signup({ name, email, username, password: "password123" });
	await api.login(username, "password123");
	api.username = username;
	api.email = email;
	api.me = (await api.get("/api/users/me")).data;
	return api;
}

/** `a` adds `b` as a contact; returns a's contact row. */
export async function befriend(a, b) {
	const r = await a.post("/api/contacts", { username: b.username });
	if (r.status !== 201) throw new Error(`add contact ${r.status} ${JSON.stringify(r.data)}`);
	return r.data;
}

export const conv = (row) => row.conversationId;
