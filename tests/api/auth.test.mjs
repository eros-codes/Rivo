// Accounts and sessions: sign-in, CSRF, devices, password change and reset,
// sign-up by email code (and what it must not reveal).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeDb, startServer } from "./support/backend.mjs";
import { Api, newUser, sleep, uniq } from "./support/client.mjs";
import jwt from "jsonwebtoken";

let srv;
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
	const r1 = await a.req("PATCH", "/api/users/me", { bio: "x" }, { "X-CSRF-Token": "" });
	const noHeader = await fetch(srv.base + "/api/users/me", {
		method: "PATCH",
		headers: { Cookie: a.cookieHeader(), "Content-Type": "application/json" },
		body: JSON.stringify({ bio: "x" }),
	});
	assert.equal(noHeader.status, 403);
	// a forged value
	const forged = await fetch(srv.base + "/api/users/me", {
		method: "PATCH",
		headers: { Cookie: a.cookieHeader(), "Content-Type": "application/json", "X-CSRF-Token": "abc" },
		body: JSON.stringify({ bio: "x" }),
	});
	assert.equal(forged.status, 403);
	void r1;
	const ok = await a.patch("/api/users/me", { bio: "hello" });
	assert.equal(ok.status, 200);
	assert.equal(ok.data.bio, "hello");
});

test("old cookies (before sessions) are not accepted", async () => {
	const a = await newUser(srv.base, "Legacy");
	const legacy = jwt.sign({ userId: a.me.id }, srv.jwtSecret, { expiresIn: "7d" });
	const r = await fetch(srv.base + "/api/users/me", { headers: { Cookie: `token=${legacy}` } });
	assert.equal(r.status, 401);
});

test("devices: list, revoke one, revoke others; revoked device loses API and socket", async () => {
	const a1 = await newUser(srv.base, "Dev");
	const a2 = new Api(srv.base, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" });
	await a2.login(a1.username, "password123");
	const a3 = new Api(srv.base, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0" });
	await a3.login(a1.email, "password123");
	const s2 = await a2.socket().ready;

	let list = (await a1.get("/api/sessions")).data.sessions;
	assert.equal(list.length, 3);
	assert.equal(list[0].current, true);
	assert.ok(list.some((s) => s.userAgent.includes("iPhone")));

	const target = (await a2.get("/api/sessions")).data.sessions.find((s) => s.current).id;
	const self = await a1.del(`/api/sessions/${list.find((s) => s.current).id}`);
	assert.equal(self.status, 400, "current session cannot be revoked here");
	const r = await a1.del(`/api/sessions/${target}`);
	assert.equal(r.status, 200);
	await s2.waitFor("session:ended");
	assert.equal((await a2.get("/api/users/me")).status, 401);
	assert.equal((await a3.get("/api/users/me")).status, 200);

	const rr = await a1.post("/api/sessions/revoke-others");
	assert.equal(rr.data.revoked, 1);
	assert.equal((await a3.get("/api/users/me")).status, 401);
	assert.equal((await a1.get("/api/users/me")).status, 200);
	list = (await a1.get("/api/sessions")).data.sessions;
	assert.equal(list.length, 1);
	// someone else's session id
	const b = await newUser(srv.base, "Other");
	const bs = (await b.get("/api/sessions")).data.sessions[0].id;
	assert.equal((await a1.del(`/api/sessions/${bs}`)).status, 404);
	assert.equal((await b.get("/api/users/me")).status, 200);
});

test("password change keeps this device, signs out the others and their push", async () => {
	const a = await newUser(srv.base, "Pw");
	const other = new Api(srv.base);
	await other.login(a.username, "password123");
	await other.post("/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/other", keys: { p256dh: "k", auth: "a" } });
	await a.post("/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/mine", keys: { p256dh: "k", auth: "a" } });
	const so = await other.socket().ready;
	const wrong = await a.patch("/api/users/me/password", { currentPassword: "nope", newPassword: "newpassword1" });
	assert.equal(wrong.status, 403);
	const r = await a.patch("/api/users/me/password", { currentPassword: "password123", newPassword: "newpassword1" });
	assert.equal(r.status, 200);
	assert.equal(r.data.signedOut, 1);
	await so.waitFor("session:ended");
	assert.equal((await a.get("/api/users/me")).status, 200);
	assert.equal((await other.get("/api/users/me")).status, 401);
	const subs = await a.db("pushSubscription", "findMany", { where: { userId: a.me.id } });
	assert.deepEqual(subs.map((s) => s.endpoint), ["https://fcm.googleapis.com/fcm/send/mine"]);
	await a.post("/api/auth/logout", {});
	const login = await new Api(srv.base).post("/api/auth/login", { identifier: a.username, password: "newpassword1" });
	assert.equal(login.status, 200);
});

test("logout ends the session and this device's push", async () => {
	const a = await newUser(srv.base, "Out");
	await a.post("/api/push/subscribe", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/out", keys: { p256dh: "k", auth: "a" } });
	const jar = new Map(a.jar);
	await a.post("/api/auth/logout", {});
	assert.equal(a.jar.has("rivo_session"), false);
	const replay = new Api(srv.base);
	replay.jar = jar;
	assert.equal((await replay.get("/api/users/me")).status, 401, "a copied cookie is dead after logout");
	assert.equal((await a.db("pushSubscription", "count", { where: { userId: a.me.id } })), 0);
});

test("password reset by email signs out everywhere", async () => {
	const a = await newUser(srv.base, "Xia");
	const other = new Api(srv.base);
	await other.login(a.username, "password123");
	const anon = new Api(srv.base);
	assert.equal((await anon.post("/api/auth/request-password-reset", { identifier: a.email })).status, 200);
	// (sent after the answer, so the answer's timing tells nothing)
	let mail;
	for (let i = 0; i < 40 && !mail; i++) {
		await sleep(50);
		mail = (await anon.mails()).filter((m) => m.to === a.email && /Reset/.test(m.subject)).pop();
	}
	assert.equal((await anon.post("/api/auth/request-password-reset", { identifier: "nobody_here_at_all" })).status, 200);
	assert.match(mail.subject, /Reset your Rivo password/);
	assert.match(mail.html, /#fa5f1a/, "the email uses Rivo's accent");
	const token = /token=([a-f0-9]+)/.exec(mail.text)[1];
	assert.equal((await anon.post("/api/auth/reset-password-with-token", { token, newPassword: "short" })).status, 400);
	assert.equal((await anon.post("/api/auth/reset-password-with-token", { token, newPassword: "brandnew123" })).status, 200);
	assert.equal((await anon.post("/api/auth/reset-password-with-token", { token, newPassword: "brandnew123" })).status, 400, "used once");
	assert.equal((await a.get("/api/users/me")).status, 401);
	assert.equal((await other.get("/api/users/me")).status, 401);
	assert.equal((await anon.post("/api/auth/login", { identifier: a.email, password: "brandnew123" })).status, 200);
});

test("sign-up never tells whether an email has an account", async () => {
	const a = await newUser(srv.base, "Hal");
	const anon = new Api(srv.base);
	const avail = await anon.post("/api/auth/check-availability", { email: a.email, username: a.username });
	assert.equal(avail.status, 200);
	assert.equal(avail.data.usernameTaken, true);
	assert.equal(avail.data.emailTaken, undefined);
	const before = (await anon.mails()).length;
	const sent = await anon.post("/api/auth/send-code", { email: a.email });
	assert.equal(sent.status, 200, "same answer as for a new address");
	const mails = (await anon.mails()).slice(before).filter((m) => m.to === a.email);
	assert.equal(mails.length, 1);
	assert.match(mails[0].subject, /already have/);
	assert.doesNotMatch(mails[0].text, /\b\d{6}\b/, "no code in it");
	assert.match(mails[0].text, /\/auth\/\?forgot=1/);
	// send-code only takes an email address now
	assert.equal((await anon.post("/api/auth/send-code", { identifier: a.username })).status, 400);
	assert.equal((await anon.post("/api/auth/verify-code", { email: a.email, code: "123456" })).status, 400);
});

test("a long crafted email address is refused at once (no catastrophic backtracking)", async () => {
	const anon = new Api(srv.base);
	const evil = "a@" + ".".repeat(60_000) + "@";
	const t = Date.now();
	const r = await anon.post("/api/auth/send-code", { email: evil });
	assert.equal(r.status, 400);
	const r2 = await anon.post("/api/auth/register", { name: "Evil", email: "a@" + "a.".repeat(30_000) + "@", username: "evil_one", password: "password123" });
	assert.equal(r2.status, 400);
	assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

test("verification codes: guesses sent all at once still use up the tries", async () => {
	const anon = new Api(srv.base);
	const email = `${uniq("guess")}@test.io`;
	await anon.post("/api/auth/send-code", { email });
	const mail = (await anon.mails()).filter((m) => m.to === email).pop();
	const code = /(\d{6})/.exec(mail.text)[1];
	const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
	const results = await Promise.all(Array.from({ length: 12 }, (_, i) => new Api(srv.base).post("/api/auth/verify-code", { email, code: wrong, identifier: `random${i}` })));
	// "Invalid code" = the guess was compared; the rest were turned away first
	const rejected = results.filter((r) => r.data?.error === "Invalid code").length;
	assert.ok(rejected <= 5, `${rejected} guesses were checked (at most 5 may be)`);
	const right = await anon.post("/api/auth/verify-code", { email, code });
	assert.notEqual(right.status, 200, "the right code no longer works after the tries are used up");
});
