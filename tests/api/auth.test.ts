// Accounts and sessions: sign-in, CSRF, devices, password change and reset,
// sign-up by email code (and what it must not reveal).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { closeDb, startServer, type Mail, type TestServer } from "../support/backend.ts";
import { Api, newUser, sleep, uniq } from "../support/client.ts";

let srv: TestServer;
before(async () => {
	srv = await startServer();
});
after(async () => {
	await srv?.stop();
	await closeDb();
});

test("sign-in creates a session with signed CSRF; unsafe calls need it", async () => {
	const a = await newUser(srv.base, "Alice");
	assert.ok(a.jar.has("rivo_session"), "session cookie");
	assert.ok(a.jar.has("rivo_csrf"), "csrf cookie");
	assert.equal(a.me.username, a.username);
	// without the header
	const noHeader = await fetch(srv.base + "/api/users/me", {
		method: "PATCH",
		headers: { Cookie: a.cookieHeader(), "Content-Type": "application/json" },
		body: JSON.stringify({ bio: "x" }),
	});
	assert.equal(noHeader.status, 403);
	// an empty one, and a forged one
	assert.equal((await a.req("PATCH", "/api/users/me", { bio: "x" }, { "X-CSRF-Token": "" })).status, 403);
	assert.equal((await a.req("PATCH", "/api/users/me", { bio: "x" }, { "X-CSRF-Token": "abc" })).status, 403);
	const ok = await a.patch<"PATCH /api/users/me">("/api/users/me", { bio: "hello" });
	assert.equal(ok.status, 200);
	assert.equal(ok.data.bio, "hello");
});

test("a token that names no session is not accepted", async () => {
	const a = await newUser(srv.base, "Nosid");
	const forged = jwt.sign({ uid: a.me.id }, srv.jwtSecret, { expiresIn: "7d" });
	const r = await fetch(srv.base + "/api/users/me", { headers: { Cookie: `rivo_session=${forged}` } });
	assert.equal(r.status, 401);
});

test("devices: list, revoke one, revoke others; revoked device loses API and socket", async () => {
	const a1 = await newUser(srv.base, "Dev");
	const a2 = new Api(srv.base, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" });
	await a2.login(a1.username, "password123");
	const a3 = new Api(srv.base, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0" });
	await a3.login(a1.email, "password123");
	const s2 = await a2.socket().ready;

	let list = (await a1.get<"GET /api/sessions">("/api/sessions")).data.sessions;
	assert.equal(list.length, 3);
	assert.equal(list[0]!.current, true);
	assert.ok(list.some((s) => s.userAgent.includes("iPhone")));

	const target = (await a2.get<"GET /api/sessions">("/api/sessions")).data.sessions.find((s) => s.current)!.id;
	const self = await a1.del(`/api/sessions/${list.find((s) => s.current)!.id}`);
	assert.equal(self.status, 400, "current session cannot be revoked here");
	const r = await a1.del<"DELETE /api/sessions/:id">(`/api/sessions/${target}`);
	assert.equal(r.status, 200);
	await s2.waitFor("session:ended");
	assert.equal((await a2.get("/api/users/me")).status, 401);
	assert.equal((await a3.get("/api/users/me")).status, 200);

	const rr = await a1.post<"POST /api/sessions/revoke-others">("/api/sessions/revoke-others");
	assert.equal(rr.data.revoked, 1);
	assert.equal((await a3.get("/api/users/me")).status, 401);
	assert.equal((await a1.get("/api/users/me")).status, 200);
	list = (await a1.get<"GET /api/sessions">("/api/sessions")).data.sessions;
	assert.equal(list.length, 1);
	// someone else's session id
	const b = await newUser(srv.base, "Other");
	const bs = (await b.get<"GET /api/sessions">("/api/sessions")).data.sessions[0]!.id;
	assert.equal((await a1.del(`/api/sessions/${bs}`)).status, 404);
	assert.equal((await b.get("/api/users/me")).status, 200);
});

test("password change keeps this device, signs out the others and their push", async () => {
	const a = await newUser(srv.base, "Pw");
	const other = new Api(srv.base);
	await other.login(a.username, "password123");
	const keys = { p256dh: "k", auth: "a" };
	await other.post<"POST /api/push/subscribe">("/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/other", keys });
	await a.post<"POST /api/push/subscribe">("/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/mine", keys });
	const so = await other.socket().ready;
	const wrong = await a.patch<"PATCH /api/users/me/password">("/api/users/me/password", { currentPassword: "nope", newPassword: "newpassword1" });
	assert.equal(wrong.status, 403);
	const r = await a.patch<"PATCH /api/users/me/password">("/api/users/me/password", { currentPassword: "password123", newPassword: "newpassword1" });
	assert.equal(r.status, 200);
	assert.equal(r.data.signedOut, 1);
	await so.waitFor("session:ended");
	assert.equal((await a.get("/api/users/me")).status, 200);
	assert.equal((await other.get("/api/users/me")).status, 401);
	const subs = await a.db<{ endpoint: string }[]>("pushSubscription", "findMany", { where: { userId: a.me.id } });
	assert.deepEqual(
		subs.map((s) => s.endpoint),
		["https://fcm.googleapis.com/fcm/send/mine"],
	);
	await a.post<"POST /api/auth/logout">("/api/auth/logout", {});
	const login = await new Api(srv.base).post<"POST /api/auth/login">("/api/auth/login", { identifier: a.username, password: "newpassword1" });
	assert.equal(login.status, 200);
});

test("logout ends the session and this device's push", async () => {
	const a = await newUser(srv.base, "Out");
	await a.post<"POST /api/push/subscribe">("/api/push/subscribe", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/out", keys: { p256dh: "k", auth: "a" } });
	const replay = new Api(srv.base);
	for (const [k, v] of a.jar) replay.jar.set(k, v);
	await a.post<"POST /api/auth/logout">("/api/auth/logout", {});
	assert.equal(a.jar.has("rivo_session"), false);
	assert.equal((await replay.get("/api/users/me")).status, 401, "a copied cookie is dead after logout");
	assert.equal(await a.db<number>("pushSubscription", "count", { where: { userId: a.me.id } }), 0);
});

test("password reset by email signs out everywhere", async () => {
	const a = await newUser(srv.base, "Xia");
	const other = new Api(srv.base);
	await other.login(a.username, "password123");
	const anon = new Api(srv.base);
	assert.equal((await anon.post<"POST /api/auth/request-password-reset">("/api/auth/request-password-reset", { identifier: a.email })).status, 200);
	// (sent after the answer, so the answer's timing tells nothing)
	let mail: Mail | undefined;
	for (let i = 0; i < 40 && !mail; i++) {
		await sleep(50);
		mail = (await anon.mails()).filter((m) => m.to === a.email && /Reset/.test(m.subject)).pop();
	}
	assert.equal((await anon.post<"POST /api/auth/request-password-reset">("/api/auth/request-password-reset", { identifier: "nobody_here_at_all" })).status, 200);
	assert.ok(mail, "the reset email was sent");
	assert.match(mail.subject, /Reset your Rivo password/);
	assert.match(mail.html, /#fa5f1a/, "the email uses Rivo's accent");
	const token = /token=([a-f0-9]+)/.exec(mail.text)![1]!;
	const reset = (newPassword: string) => anon.post<"POST /api/auth/reset-password-with-token">("/api/auth/reset-password-with-token", { token, newPassword });
	assert.equal((await reset("short")).status, 400);
	assert.equal((await reset("brandnew123")).status, 200);
	assert.equal((await reset("brandnew123")).status, 400, "used once");
	assert.equal((await a.get("/api/users/me")).status, 401);
	assert.equal((await other.get("/api/users/me")).status, 401);
	assert.equal((await anon.post<"POST /api/auth/login">("/api/auth/login", { identifier: a.email, password: "brandnew123" })).status, 200);
});

test("sign-up never tells whether an email has an account", async () => {
	const a = await newUser(srv.base, "Hal");
	const anon = new Api(srv.base);
	// (an email sent along is not even read)
	const avail = await anon.post("/api/auth/check-availability", { email: a.email, username: a.username });
	assert.equal(avail.status, 200);
	assert.equal(avail.data.usernameTaken, true);
	assert.equal(avail.data.emailTaken, undefined);
	const before = (await anon.mails()).length;
	const sent = await anon.post<"POST /api/auth/send-code">("/api/auth/send-code", { email: a.email });
	assert.equal(sent.status, 200, "same answer as for a new address");
	const mails = (await anon.mails()).slice(before).filter((m) => m.to === a.email);
	assert.equal(mails.length, 1);
	assert.match(mails[0]!.subject, /already have/);
	assert.doesNotMatch(mails[0]!.text, /\b\d{6}\b/, "no code in it");
	assert.match(mails[0]!.text, /\/auth\/\?forgot=1/);
	// send-code only takes an email address
	assert.equal((await anon.post("/api/auth/send-code", { identifier: a.username })).status, 400);
	assert.equal((await anon.post<"POST /api/auth/verify-code">("/api/auth/verify-code", { email: a.email, code: "123456" })).status, 400);
});

test("a long crafted email address is refused at once (no catastrophic backtracking)", async () => {
	const anon = new Api(srv.base);
	const t = Date.now();
	const r = await anon.post<"POST /api/auth/send-code">("/api/auth/send-code", { email: "a@" + ".".repeat(60_000) + "@" });
	assert.equal(r.status, 400);
	const r2 = await anon.post<"POST /api/auth/register">("/api/auth/register", { name: "Evil", email: "a@" + "a.".repeat(30_000) + "@", username: "evil_one", password: "password123" });
	assert.equal(r2.status, 400);
	assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

test("verification codes: guesses sent all at once still use up the tries", async () => {
	const anon = new Api(srv.base);
	const email = `${uniq("guess")}@test.io`;
	await anon.post<"POST /api/auth/send-code">("/api/auth/send-code", { email });
	const mail = (await anon.mails()).filter((m) => m.to === email).pop();
	const code = /(\d{6})/.exec(mail?.text ?? "")![1]!;
	const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
	// (each from a "different" device, naming a different account: neither helps)
	const results = await Promise.all(Array.from({ length: 12 }, (_, i) => new Api(srv.base).post("/api/auth/verify-code", { email, code: wrong, identifier: `random${i}` })));
	// "Invalid code" = the guess was compared; the rest were turned away first
	const rejected = results.filter((r) => r.data?.error === "Invalid code").length;
	assert.ok(rejected <= 5, `${rejected} guesses were checked (at most 5 may be)`);
	const right = await anon.post<"POST /api/auth/verify-code">("/api/auth/verify-code", { email, code });
	assert.notEqual(right.status, 200, "the right code no longer works after the tries are used up");
});
