// End-to-end check of a running Rivo server with two existing accounts:
// signing in, the contact between them, live messages over the socket
// (send → receive, duplicate send, edit, reply, pin, typing, seen, delete)
// and catching up through the sync endpoint.
//
//   TEST_SERVER_URL=http://localhost:3000 \
//   TEST_USER_A=alice TEST_PASS_A=... TEST_USER_B=bob TEST_PASS_B=... \
//   npm run test:integration
//
// Both accounts must exist already (signing up needs an email code). The test
// makes them contacts if they are not, deletes the messages it sends, and
// signs its two sessions out at the end. Never point it at accounts whose
// chat you care about: it posts into their conversation.
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";

const SERVER = (process.env.TEST_SERVER_URL || "http://localhost:3000").replace(/\/+$/, "");
const USER_A = process.env.TEST_USER_A;
const PASS_A = process.env.TEST_PASS_A;
const USER_B = process.env.TEST_USER_B;
const PASS_B = process.env.TEST_PASS_B;

if (!USER_A || !PASS_A || !USER_B || !PASS_B) {
	console.error("Set TEST_USER_A, TEST_PASS_A, TEST_USER_B and TEST_PASS_B (and TEST_SERVER_URL if not http://localhost:3000).");
	process.exit(1);
}

// ─── HTTP with a cookie jar ───────────────────────────────────────────────

class Client {
	constructor(label) {
		this.label = label;
		this.jar = new Map();
	}
	cookieHeader() {
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
	}
	/** The CSRF token the server set ("rivo_csrf", or "__Host-rivo_csrf" in production). */
	csrf() {
		for (const [k, v] of this.jar) if (k.endsWith("rivo_csrf")) return decodeURIComponent(v);
		return "";
	}
	remember(res) {
		for (const line of res.headers.getSetCookie()) {
			const [pair, ...attrs] = line.split(";");
			const at = pair.indexOf("=");
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			const expired = !value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
			if (expired) this.jar.delete(name);
			else this.jar.set(name, value);
		}
	}
	async request(method, path, body, { csrf = true } = {}) {
		const headers = { Accept: "application/json", "User-Agent": "RivoIntegrationTest/1.0" };
		if (this.jar.size) headers.Cookie = this.cookieHeader();
		if (method !== "GET" && csrf) headers["X-CSRF-Token"] = this.csrf();
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const res = await fetch(SERVER + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
		this.remember(res);
		const text = await res.text();
		let data;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = text;
		}
		return { status: res.status, data };
	}
	async login(identifier, password) {
		const r = await this.request("POST", "/api/auth/login", { identifier, password });
		if (r.status !== 200) throw new Error(`${this.label}: sign-in failed (${r.status} ${r.data?.error ?? ""})`);
		if (!this.csrf()) throw new Error(`${this.label}: the server set no CSRF cookie`);
		return r.data.user;
	}
	logout() {
		return this.request("POST", "/api/auth/logout", {}).catch(() => null);
	}
}

// ─── Socket helpers ───────────────────────────────────────────────────────

function connect(client) {
	return new Promise((resolve, reject) => {
		const socket = io(SERVER, {
			extraHeaders: { Cookie: client.cookieHeader() },
			auth: { visible: true },
			reconnection: false,
			timeout: 8000,
		});
		// every event is kept, so one that arrives before we wait for it is not lost
		socket.seen = [];
		socket.onAny((event, data) => socket.seen.push({ event, data, used: false }));
		socket.once("connect", () => resolve(socket));
		socket.once("connect_error", (e) => reject(new Error(`${client.label}: socket refused (${e?.message ?? e})`)));
	});
}

function ask(socket, event, payload, timeout = 6000) {
	return socket.timeout(timeout).emitWithAck(event, payload);
}

function waitFor(socket, event, match = () => true, timeout = 6000) {
	return new Promise((resolve, reject) => {
		const take = () => {
			const hit = socket.seen.find((e) => !e.used && e.event === event && match(e.data));
			if (!hit) return false;
			hit.used = true;
			clearInterval(poll);
			clearTimeout(timer);
			resolve(hit.data);
			return true;
		};
		const poll = setInterval(take, 20);
		const timer = setTimeout(() => {
			clearInterval(poll);
			reject(new Error(`no "${event}" within ${timeout} ms`));
		}, timeout);
		take();
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── The checks ───────────────────────────────────────────────────────────

let passed = 0;
async function step(name, fn) {
	try {
		const result = await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
		return result;
	} catch (e) {
		e.message = `${name}: ${e.message}`;
		throw e;
	}
}

function check(condition, message) {
	if (!condition) throw new Error(message);
}

/** A's contact row for B: added now, or found among A's contacts. */
async function contactRow(a, username) {
	const added = await a.request("POST", "/api/contacts", { username });
	if (added.status === 201) return added.data;
	if (added.status !== 409) throw new Error(`adding the contact failed (${added.status} ${added.data?.error ?? ""})`);
	for (let skip = 0; skip < 5000; skip += 100) {
		const page = await a.request("GET", `/api/contacts?limit=100&skip=${skip}`);
		if (page.status !== 200) throw new Error(`listing contacts failed (${page.status})`);
		const row = page.data.find((r) => !r.isSaved && r.contact?.username?.toLowerCase() === username.toLowerCase());
		if (row) return row;
		if (page.data.length < 100) break;
	}
	throw new Error("the server says the contact exists but it is not in the list");
}

async function main() {
	const a = new Client("A");
	const b = new Client("B");
	let sockA = null;
	let sockB = null;
	try {
		console.log(`Rivo integration test against ${SERVER}`);
		const [userA, userB] = await step("both accounts sign in", () => Promise.all([a.login(USER_A, PASS_A), b.login(USER_B, PASS_B)]));
		check(userA.id !== userB.id, "TEST_USER_A and TEST_USER_B are the same account");

		await step("a request without the CSRF token is refused", async () => {
			const r = await a.request("PATCH", "/api/users/me", {}, { csrf: false });
			check(r.status === 403, `expected 403, got ${r.status}`);
		});

		const row = await step("A and B are contacts", () => contactRow(a, USER_B));
		const conversationId = row.conversationId;
		check(Number.isInteger(conversationId), "the contact row has no conversation");
		check(!row.isBlocked, "A has blocked B: unblock to run this test");

		[sockA, sockB] = await step("both connect live", () => Promise.all([connect(a), connect(b)]));
		sockA.emit("conversation:join", { conversationId });
		sockB.emit("conversation:join", { conversationId });
		const cursor = new Date().toISOString();
		await sleep(300);

		const clientId = randomUUID().replace(/-/g, "");
		const text = `integration test ${new Date().toISOString()}`;
		const sent = await step("A sends, B receives it", async () => {
			const ack = await ask(sockA, "message:send", { conversationId, text, clientId });
			check(ack?.success && ack.message?.id, `send failed: ${JSON.stringify(ack)}`);
			const got = await waitFor(sockB, "message:new", (m) => m?.id === ack.message.id);
			check(got.text === text, "B got different text");
			check(got.clientId === undefined || got.clientId === null || got.clientId === clientId, "B got another sender's clientId");
			return ack.message;
		});

		await step("sending the same message again does not duplicate it", async () => {
			const ack = await ask(sockA, "message:send", { conversationId, text, clientId });
			check(ack?.success && ack.duplicate === true && ack.message?.id === sent.id, `expected the first message back: ${JSON.stringify(ack)}`);
			await sleep(300);
			check(!sockB.seen.some((e) => e.event === "message:new" && e.data?.id === sent.id && !e.used), "B was sent the message twice");
		});

		await step("A edits, B sees the edit", async () => {
			const ack = await ask(sockA, "message:edit", { messageId: sent.id, text: `${text} (edited)` });
			check(ack?.success, `edit failed: ${JSON.stringify(ack)}`);
			const ev = await waitFor(sockB, "message:edited", (e) => e?.messageId === sent.id);
			check(ev.text === `${text} (edited)` && ev.isEdited, "the edit B got is wrong");
		});

		await step("B cannot edit A's message", async () => {
			const ack = await ask(sockB, "message:edit", { messageId: sent.id, text: "not mine" });
			check(ack?.error, "the server let B edit A's message");
		});

		const reply = await step("a reply quotes the real message, not what the client claims", async () => {
			const ack = await ask(sockB, "message:send", {
				conversationId,
				text: "integration reply",
				clientId: randomUUID().replace(/-/g, ""),
				replyToId: sent.id,
				replyToText: "something A never said",
			});
			check(ack?.success, `reply failed: ${JSON.stringify(ack)}`);
			const got = await waitFor(sockA, "message:new", (m) => m?.id === ack.message.id);
			check(got.replyToText === `${text} (edited)`, `A got the quote "${got.replyToText}"`);
			return ack.message;
		});

		await step("A pins, B sees the pin", async () => {
			const ack = await ask(sockA, "message:pin", { messageId: sent.id });
			check(ack?.success, `pin failed: ${JSON.stringify(ack)}`);
			const ev = await waitFor(sockB, "message:pinned", (e) => e?.messageId === sent.id);
			if (ev.isPinned) {
				// leave the chat's pins as they were
				await ask(sockA, "message:pin", { messageId: sent.id });
			}
		});

		await step("A types, B sees it", async () => {
			sockA.emit("typing:start", { conversationId });
			const ev = await waitFor(sockB, "typing:start", (e) => e?.conversationId === conversationId);
			check(ev.userId === userA.id, "typing came from the wrong user");
			sockA.emit("typing:stop", { conversationId });
		});

		await step("B reads, A sees it read", async () => {
			const ack = await ask(sockB, "message:seen", { conversationId, upToId: sent.id });
			check(ack?.success, `seen failed: ${JSON.stringify(ack)}`);
			if (ack.marked?.length) {
				const ev = await waitFor(sockA, "message:seen", (e) => e?.messageIds?.includes(sent.id));
				check(ev.seenBy === userB.id, "seen by the wrong user");
			}
		});

		await step("a device that was away catches up through /changes", async () => {
			const r = await b.request("GET", `/api/conversations/${conversationId}/changes?since=${encodeURIComponent(cursor)}`);
			check(r.status === 200, `changes failed (${r.status})`);
			check(typeof r.data.cursor === "string", "no new cursor");
			if (!r.data.reset) {
				const m = r.data.messages.find((x) => x.id === sent.id);
				check(m, "the message is not among the changes");
				check(m.isEdited, "the change has the old version");
			}
		});

		await step("A deletes the message for both, B sees it go", async () => {
			const ack = await ask(sockA, "messages:delete", { messageIds: [sent.id] });
			check(ack?.success, `delete failed: ${JSON.stringify(ack)}`);
			check((await ask(sockB, "messages:delete", { messageIds: [reply.id] }))?.success, "B could not delete its reply");
			await waitFor(sockB, "message:deleted", (e) => e?.messageId === sent.id);
			const r = await b.request("GET", `/api/conversations/${conversationId}/changes?since=${encodeURIComponent(cursor)}`);
			const m = r.data?.messages?.find((x) => x.id === sent.id);
			if (!r.data?.reset) check(m?.isDeleted && !m.text, "the deletion is not in the changes, or it kept its text");
		});

		await step("a signed-out session loses its connection", async () => {
			const closed = new Promise((resolve) => sockB.once("disconnect", resolve));
			await b.logout();
			await Promise.race([closed, sleep(4000).then(() => Promise.reject(new Error("B's socket stayed connected")))]);
			const r = await b.request("GET", "/api/users/me");
			check(r.status === 401, `expected 401 after signing out, got ${r.status}`);
		});

		console.log(`\nAll ${passed} checks passed.`);
		return 0;
	} catch (e) {
		console.error(`\n✗ ${e.message}`);
		return 1;
	} finally {
		sockA?.close();
		sockB?.close();
		await Promise.all([a.logout(), b.logout()]);
	}
}

process.exit(await main());
