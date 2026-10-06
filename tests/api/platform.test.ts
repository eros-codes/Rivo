// What every request goes through: ids, unknown paths, page addresses,
// security headers, push subscriptions, rate limits, health, request ids,
// input checking, uploading a picture, and sending email for real (SMTP).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, ROOT, startServer, type TestServer } from "../support/backend.ts";
import { Api, live, newUser, ok, uniq } from "../support/client.ts";
import { readMail, smtpSink } from "../support/smtp.ts";

let srv: TestServer;
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

test("pages: a missing slash is added (the query kept); the first version's addresses are gone", async () => {
	const r1 = await fetch(srv.base + "/chat?conversationId=5", { redirect: "manual" });
	assert.equal(r1.status, 301);
	assert.equal(r1.headers.get("location"), "/chat/?conversationId=5");
	const r2 = await fetch(srv.base + "/auth", { redirect: "manual" });
	assert.equal(r2.headers.get("location"), "/auth/");
	for (const old of ["/chat/main.html", "/auth/auth.html", "/reset-password"]) {
		assert.equal((await fetch(srv.base + old, { redirect: "manual" })).status, 404, old);
	}
});

test("security headers (helmet) and the content policy; no HSTS outside production", async () => {
	const r = await fetch(srv.base + "/api/health");
	const h = (name: string) => r.headers.get(name);
	assert.equal(h("x-content-type-options"), "nosniff");
	assert.equal(h("x-frame-options"), "SAMEORIGIN");
	assert.equal(h("referrer-policy"), "no-referrer");
	assert.equal(h("cross-origin-opener-policy"), "same-origin");
	assert.equal(h("x-powered-by"), null);
	assert.equal(h("cross-origin-embedder-policy"), null, "nothing here is embedded from elsewhere");
	assert.equal(h("strict-transport-security"), null, "HSTS only in production (over https)");
	assert.match(h("content-security-policy") ?? "", /default-src 'self'.*object-src 'none'/);
});

test("push subscriptions: only real push services, one per device, a bounded number per account", async () => {
	const a = await newUser(srv.base, "Lou");
	const keys = { p256dh: "k", auth: "a" };
	const subscribe = (endpoint: string) => a.post<"POST /api/push/subscribe">("/api/push/subscribe", { endpoint, keys });
	for (const endpoint of [
		"https://10.0.0.5:8443/admin",
		"https://127.0.0.1/x",
		"https://evil.example/collect",
		"http://fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com:8443/fcm/send/x",
		"https://user:pw@fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com.evil.example/x",
	]) {
		assert.equal((await subscribe(endpoint)).status, 400, endpoint);
	}
	assert.equal((await subscribe("https://web.push.apple.com/one")).status, 200);
	assert.equal((await subscribe("https://wns2-par02p.notify.windows.com/w/?token=two")).status, 200);
	const subs = await a.db<{ endpoint: string }[]>("pushSubscription", "findMany", { where: { userId: a.me.id } });
	assert.deepEqual(
		subs.map((s) => s.endpoint),
		["https://wns2-par02p.notify.windows.com/w/?token=two"],
		"the device's newer subscription replaced its older one",
	);
	assert.equal((await a.post("/api/push/send", { payload: { title: "x" } })).status, 404, "the test-push route is gone");
});

test("the API rate limit cannot be skipped by changing the case of the path", async () => {
	const s = await startServer({ HTTP_RATE_MAX: "5", SOCKET_RATE_MAX: "200", VERIFICATION_SEND_LIMIT: "100000" });
	try {
		const anon = new Api(s.base);
		const statuses: number[] = [];
		for (let i = 0; i < 8; i++) statuses.push((await anon.get(i % 2 ? "/API/push/publicKey" : "/api/push/publicKey")).status);
		assert.ok(statuses.includes(429), statuses.join(","));
		// the limit is announced the standard way
		const r = await anon.get("/api/push/publicKey");
		assert.equal(r.headers.get("ratelimit-limit"), "5");
		assert.equal(r.headers.get("ratelimit-remaining"), "0");
	} finally {
		await s.stop();
	}
});

test("health: the server and its database answer; every response has a request id", async () => {
	const r = await fetch(srv.base + "/api/health");
	assert.equal(r.status, 200);
	const body = (await r.json()) as { status: string; db: string; uptime: number };
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

test("every input is checked against its schema: bad ones get the schema's words and change nothing", async () => {
	const a = await newUser(srv.base, "Vic");
	const sa = await a.socket().ready;
	const saved = (await a.get<"GET /api/contacts">("/api/contacts")).data.find((c) => c.isSaved)!;
	const kept = ok(await sa.request("message:send", { conversationId: saved.conversationId, text: "keep me", clientId: "keepme0001" })).message;

	// over the socket (shapes the app never sends: requestRaw)
	assert.equal((await sa.requestRaw("message:send", "hello")).error, "Invalid data");
	assert.equal((await sa.requestRaw("message:send", { conversationId: saved.conversationId, text: "x", isOneTime: "yes" })).error, "Invalid data");
	assert.equal((await sa.request("message:edit", { messageId: kept.id, text: "   " })).error, "Invalid data");
	assert.equal((await sa.requestRaw("messages:delete", { messageIds: [kept.id, "x"] })).error, "Invalid data");
	assert.equal((await sa.request("messages:forward", { conversationId: saved.conversationId, items: [] })).error, "Invalid data");
	assert.equal((await sa.request("reaction:add", { messageId: kept.id, emoji: "a b" })).error, "Invalid data");
	assert.equal((await sa.request("message:seen", { conversationId: "x" })).error, "Invalid conversationId");

	// over REST
	const bad = async (method: string, path: string, body: unknown, error: string) => {
		const r = await a.req(method, path, body);
		assert.equal(r.status, 400, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
		assert.equal(r.data.error, error, `${method} ${path}`);
	};
	await bad("PATCH", "/api/users/me", {}, "Nothing to change");
	await bad("PATCH", "/api/users/me", { privacyOnline: "friends" }, "Invalid value for privacyOnline");
	await bad("POST", "/api/contacts", { username: "   " }, "Username is required");
	await bad("PATCH", `/api/contacts/${saved.id}`, { isMuted: "true" }, "isMuted must be a boolean");
	await bad("GET", "/api/users/search?q=a", undefined, "Query too short");
	await bad("POST", "/api/messages", { conversationId: saved.conversationId, text: "x", clientId: "no!" }, "Invalid clientId");
	await bad("PATCH", `/api/messages/${kept.id}`, { text: "" }, "Invalid data");
	await bad("GET", `/api/conversations/${saved.conversationId}/messages?before=yesterday`, undefined, "Invalid before date");
	// a blank upToId must not mean "clear everything"
	await bad("DELETE", `/api/conversations/${saved.conversationId}/messages?upToId=`, undefined, "Invalid upToId");
	await bad("POST", "/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: 1, auth: "a" } }, "Invalid subscription");
	await bad("DELETE", "/api/sessions/short", undefined, "Invalid session id");

	const page = (await a.get<"GET /api/conversations/:id/messages">(`/api/conversations/${saved.conversationId}/messages`)).data;
	const still = live(page.messages.find((m) => m.id === kept.id));
	assert.equal(still.text, "keep me");
	sa.close();
});

test("profile picture: stored as the server's own JPEG, the previous one deleted; anything else refused, saying why", async () => {
	const a = await newUser(srv.base, "Pia");
	const face = readFileSync(join(ROOT, "tests", "e2e", "fixtures", "face.png"));
	const form = (...parts: [field: string, value: Blob | string, name?: string][]) => {
		const f = new FormData();
		for (const [field, value, name] of parts) {
			if (typeof value === "string") f.append(field, value);
			else f.append(field, value, name ?? "avatar.png");
		}
		return f;
	};
	const png = (bytes: Uint8Array<ArrayBuffer> = face, type = "image/png") => new Blob([bytes], { type });
	const upload = (body: FormData) => a.post<"POST /api/users/me/avatar">("/api/users/me/avatar", body);
	const fetched = async (url: string) => {
		const r = await fetch(srv.base + url);
		return { status: r.status, type: r.headers.get("content-type") ?? "", bytes: new Uint8Array(await r.arrayBuffer()) };
	};

	const first = await upload(form(["avatar", png()]));
	assert.equal(first.status, 200, JSON.stringify(first.data));
	const url = first.data.url;
	assert.match(url, /^\/assets\/images\/user-profiles\/av-\d+-[0-9a-f]{24}\.jpg$/);
	const stored = await fetched(url);
	assert.equal(stored.status, 200);
	assert.match(stored.type, /image\/jpeg/);
	assert.deepEqual([...stored.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], "re-encoded: a JPEG whatever came in");
	assert.deepEqual((await a.get<"GET /api/users/me">("/api/users/me")).data.profilePics, [url]);

	const second = await upload(form(["avatar", png()]));
	assert.equal(second.status, 200, JSON.stringify(second.data));
	const url2 = second.data.url;
	assert.notEqual(url2, url);
	assert.equal((await fetched(url)).status, 404, "the previous picture is deleted");

	const refused = async (body: FormData, status: number, error: string) => {
		const r = await a.req("POST", "/api/users/me/avatar", body);
		assert.equal(r.status, status, `${error}: ${JSON.stringify(r.data)}`);
		assert.equal(r.data.error, error);
	};
	await refused(form(["avatar", png(new TextEncoder().encode("not a picture at all"))]), 400, "Invalid image file");
	await refused(form(["avatar", png(face, "text/plain")]), 400, "Only images are allowed");
	await refused(form(["avatar", png()], ["avatar", png()]), 400, 'Send one picture, as the field "avatar"');
	await refused(form(["caption", "hi"], ["avatar", png()]), 400, 'Send one picture, as the field "avatar"');
	await refused(form(["picture", png()]), 400, 'Send one picture, as the field "avatar"');
	await refused(form(["avatar", png(new Uint8Array(5 * 1024 * 1024 + 1))]), 413, "Image is too large (max 5 MB)");
	assert.deepEqual((await a.get<"GET /api/users/me">("/api/users/me")).data.profilePics, [url2], "nothing refused changed the picture");

	// removed: the file goes too
	assert.equal((await a.patch<"PATCH /api/users/me">("/api/users/me", { profilePics: [] })).status, 200);
	assert.equal((await fetched(url2)).status, 404);
});

test("emails go out over SMTP: signed in, from SMTP_FROM, the code readable in the text and the HTML", async () => {
	const smtp = await smtpSink({ user: "rivo-mailer", pass: "mail-secret-1" });
	// (no capture file: the server sends for real, to the test's mail server)
	const s = await startServer({
		MAIL_CAPTURE_FILE: "",
		SMTP_HOST: "127.0.0.1",
		SMTP_PORT: String(smtp.port),
		SMTP_USER: "rivo-mailer",
		SMTP_PASS: "mail-secret-1",
		SMTP_FROM: "Rivo <no-reply@rivo.test>",
	});
	try {
		const anon = new Api(s.base);
		const email = `${uniq("smtp")}@test.io`;
		assert.equal((await anon.post<"POST /api/auth/send-code">("/api/auth/send-code", { email })).status, 200);
		const sent = await smtp.next((m) => m.to.includes(email));
		assert.equal(sent.user, "rivo-mailer", "signed in with SMTP_USER / SMTP_PASS");
		assert.equal(sent.from, "no-reply@rivo.test");
		const mail = readMail(sent.raw);
		assert.match(mail.headers.from ?? "", /Rivo <no-reply@rivo\.test>/);
		assert.equal(mail.headers.to, email);
		const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
		assert.ok(code, `a code in the text:\n${mail.text}`);
		assert.ok(mail.html.includes(code), "and in the HTML");
		// the code that went out is the one the server takes
		assert.equal((await anon.post<"POST /api/auth/verify-code">("/api/auth/verify-code", { email, code })).status, 200);
		assert.ok(smtp.logins.every((l) => l.ok));
	} finally {
		await s.stop();
		await smtp.close();
	}
});

test("a mail server that refuses the password: the request says so, and no retry with the same password", async () => {
	const smtp = await smtpSink({ user: "rivo-mailer", pass: "the-right-one" });
	const s = await startServer({ MAIL_CAPTURE_FILE: "", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_USER: "rivo-mailer", SMTP_PASS: "a-wrong-one" });
	try {
		const r = await new Api(s.base).post("/api/auth/send-code", { email: `${uniq("smtp")}@test.io` });
		assert.equal(r.status, 500);
		assert.equal(r.data.error, "Failed to send email");
		assert.equal(smtp.messages.length, 0);
		// (one try for the email; the mailer's own check when it starts may make one more)
		assert.ok(smtp.logins.length <= 2 && smtp.logins.every((l) => !l.ok), JSON.stringify(smtp.logins));
	} finally {
		await s.stop();
		await smtp.close();
	}
});
