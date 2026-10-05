// What every request goes through: ids, unknown paths, old addresses,
// push subscriptions, rate limits, health, request ids.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeDb, startServer } from "./support/backend.mjs";
import { Api, newUser } from "./support/client.mjs";

let srv;
before(async () => {
	srv = await startServer();
});
after(async () => {
	await srv?.stop();
	await closeDb();
});

test("ids out of range answer 400, unknown API paths 404 JSON", async () => {
	const a = await newUser(srv.base, "Yan");
	assert.equal((await a.patch("/api/contacts/1e3", { isMuted: true })).status, 400);
	assert.equal((await a.patch("/api/contacts/99999999999", { isMuted: true })).status, 400);
	const r = await a.get("/api/nothing-here");
	assert.equal(r.status, 404);
	assert.equal(r.data.error, "Not found");
	const sa = await a.socket().ready;
	assert.equal((await sa.request("message:pin", { messageId: "12abc" })).error, "Invalid messageId");
});

test("pages: redirects of old addresses", async () => {
	const r1 = await fetch(srv.base + "/chat/main.html?conversationId=5", { redirect: "manual" });
	assert.equal(r1.status, 301);
	assert.equal(r1.headers.get("location"), "/chat/?conversationId=5");
	const r2 = await fetch(srv.base + "/auth/auth.html", { redirect: "manual" });
	assert.equal(r2.headers.get("location"), "/auth/");
	const r3 = await fetch(srv.base + "/chat", { redirect: "manual" });
	assert.equal(r3.headers.get("location"), "/chat/");
});

test("push subscriptions: only real push services, one per device, a bounded number per account", async () => {
	const a = await newUser(srv.base, "Lou");
	const keys = { p256dh: "k", auth: "a" };
	for (const endpoint of [
		"https://10.0.0.5:8443/admin",
		"https://127.0.0.1/x",
		"https://evil.example/collect",
		"http://fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com:8443/fcm/send/x",
		"https://user:pw@fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com.evil.example/x",
	]) {
		assert.equal((await a.post("/api/push/subscribe", { endpoint, keys })).status, 400, endpoint);
	}
	assert.equal((await a.post("/api/push/subscribe", { endpoint: "https://web.push.apple.com/one", keys })).status, 200);
	assert.equal((await a.post("/api/push/subscribe", { endpoint: "https://wns2-par02p.notify.windows.com/w/?token=two", keys })).status, 200);
	const subs = await a.db("pushSubscription", "findMany", { where: { userId: a.me.id } });
	assert.deepEqual(subs.map((s) => s.endpoint), ["https://wns2-par02p.notify.windows.com/w/?token=two"], "the device's newer subscription replaced its older one");
	assert.equal((await a.post("/api/push/send", { payload: { title: "x" } })).status, 404, "the test-push route is gone");
});

test("the API rate limit cannot be skipped by changing the case of the path", async () => {
	const s = await startServer({ HTTP_RATE_MAX: "5", SOCKET_RATE_MAX: "200", VERIFICATION_SEND_LIMIT: "100000" });
	try {
		const anon = new Api(s.base);
		const statuses = [];
		for (let i = 0; i < 8; i++) statuses.push((await anon.get(i % 2 ? "/API/push/publicKey" : "/api/push/publicKey")).status);
		assert.ok(statuses.includes(429), statuses.join(","));
	} finally {
		s.stop();
	}
});

test("health: the server and its database answer; every response has a request id", async () => {
	const r = await fetch(srv.base + "/api/health");
	assert.equal(r.status, 200);
	const body = await r.json();
	assert.equal(body.status, "ok");
	assert.equal(body.db, "ok");
	assert.equal(typeof body.uptime, "number");
	assert.equal(r.headers.get("cache-control"), "no-store");
	assert.match(r.headers.get("x-request-id") ?? "", /^[\w-]{8,64}$/);
	// a proxy's own id is kept (so its log and ours can be matched); a strange one is not
	const own = await fetch(srv.base + "/api/users/me", { headers: { "X-Request-Id": "proxy-req-12345" } });
	assert.equal(own.headers.get("x-request-id"), "proxy-req-12345");
	const odd = await fetch(srv.base + "/api/users/me", { headers: { "X-Request-Id": "<script>" } });
	assert.notEqual(odd.headers.get("x-request-id"), "<script>");
});

test("a stopping server says so on /api/health, then exits cleanly", async () => {
	const s = await startServer({ LOG_LEVEL: "info" });
	const stopped = s.stop();
	// (the answer during the few milliseconds of stopping, if any, is 503)
	const r = await fetch(s.base + "/api/health").catch(() => null);
	if (r) assert.ok([200, 503].includes(r.status));
	await stopped;
	assert.match(s.log(), /shutting down[\s\S]*stopped/);
});
