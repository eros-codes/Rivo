// Messages: sending (once, in order), seen, edits, deletes, pins, forwards,
// replies, time capsules, one-time messages, sync since a cursor, limits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeDb, startServer } from "./support/backend.mjs";
import { befriend, conv, newUser, sleep } from "./support/client.mjs";

let srv;
before(async () => {
	srv = await startServer();
});
after(async () => {
	await srv?.stop();
	await closeDb();
});

test("send: idempotent by clientId, delivered, unread counted, seen up to an id", async () => {
	const a = await newUser(srv.base, "Eve");
	const b = await newUser(srv.base, "Fay");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	const r1 = await sa.request("message:send", { conversationId: conv(row), text: "one", clientId: "clientid0001" });
	assert.equal(r1.success, true);
	assert.equal(r1.message.clientId, "clientid0001");
	const again = await sa.request("message:send", { conversationId: conv(row), text: "one", clientId: "clientid0001" });
	assert.equal(again.message.id, r1.message.id, "retry returns the stored message");
	const got = await sb.waitFor("message:new");
	assert.equal(got.text, "one");
	assert.equal(got.clientId, undefined, "recipient never sees the sender's client id");
	await sleep(100);
	assert.equal(sb.of("message:new").length, 1, "delivered once");
	const r2 = await sa.request("message:send", { conversationId: conv(row), text: "two", clientId: "clientid0002" });
	const r3 = await sa.request("message:send", { conversationId: conv(row), text: "three", clientId: "clientid0003" });
	let bRow = (await b.get("/api/contacts")).data.find((c) => !c.isSaved);
	assert.equal(bRow.unreadCount, 3);
	assert.equal(bRow.lastMessage.text, "three");

	// not joined → nothing marked
	let seen = await sb.request("message:seen", { conversationId: conv(row), upToId: r2.message.id });
	assert.deepEqual(seen.marked, []);
	sb.emit("conversation:join", { conversationId: conv(row) });
	await sleep(50);
	seen = await sb.request("message:seen", { conversationId: conv(row), upToId: r2.message.id });
	assert.deepEqual(seen.marked, [r1.message.id, r2.message.id]);
	assert.equal(seen.unreadCount, 1);
	const ev = await sa.waitFor("message:seen");
	assert.equal(ev.seenBy, b.me.id);
	bRow = (await b.get("/api/contacts")).data.find((c) => !c.isSaved);
	assert.equal(bRow.unreadCount, 1, "the message after upToId stays unread");
	seen = await sb.request("message:seen", { conversationId: conv(row) });
	assert.deepEqual(seen.marked, [r3.message.id]);

	const bad = await sa.request("message:send", { conversationId: conv(row), text: "x", clientId: "bad id!" });
	assert.equal(bad.error, "Invalid clientId");
	const empty = await sa.request("message:send", { conversationId: conv(row), text: "   " });
	assert.equal(empty.error, "Invalid data");
	const stranger = await newUser(srv.base, "Gus");
	const sg = await stranger.socket().ready;
	const forbidden = await sg.request("message:send", { conversationId: conv(row), text: "hi" });
	assert.equal(forbidden.error, "Forbidden");
});

test("pages and changes since a cursor (edits, deletes, reactions, pins, seen)", async () => {
	const a = await newUser(srv.base, "Hal");
	const b = await newUser(srv.base, "Ivy");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const ids = [];
	for (let i = 1; i <= 5; i++) ids.push((await sa.request("message:send", { conversationId: conv(row), text: `m${i}`, clientId: `cid-pages-${i}x` })).message.id);
	const page = (await b.get(`/api/conversations/${conv(row)}/messages?limit=3`)).data;
	assert.deepEqual(page.messages.map((m) => m.text), ["m3", "m4", "m5"]);
	assert.equal(page.hasMore, true);
	const older = (await b.get(`/api/conversations/${conv(row)}/messages?limit=3&before=${encodeURIComponent(page.messages[0].createdAt)}&beforeId=${page.messages[0].id}`)).data;
	assert.deepEqual(older.messages.map((m) => m.text), ["m1", "m2"]);
	assert.equal(older.hasMore, false);

	// a cursor re-sends the last 10 seconds (writes in flight); taken later, nothing is old news
	let ch = (await b.get(`/api/conversations/${conv(row)}/changes?since=${encodeURIComponent(page.cursor)}`)).data;
	assert.equal(ch.messages.length, 5, "overlap window re-sends recent writes");
	await sleep(11_000);
	const cursor = (await b.get(`/api/conversations/${conv(row)}/messages?limit=1`)).data.cursor;
	ch = (await b.get(`/api/conversations/${conv(row)}/changes?since=${encodeURIComponent(cursor)}`)).data;
	assert.deepEqual(ch.messages, [], "nothing changed");

	await sa.request("message:edit", { messageId: ids[4], text: "m5 edited" });
	await sa.request("message:delete", { messageId: ids[3] });
	const sb = await b.socket().ready;
	await sb.request("reaction:add", { messageId: ids[2], emoji: "👍" });
	await sb.request("message:pin", { messageId: ids[1] });
	const r6 = await sa.request("message:send", { conversationId: conv(row), text: "m6", clientId: "cid-pages-6x" });
	ch = (await b.get(`/api/conversations/${conv(row)}/changes?since=${encodeURIComponent(cursor)}`)).data;
	const byId = new Map(ch.messages.map((m) => [m.id, m]));
	assert.equal(byId.get(ids[4]).text, "m5 edited");
	assert.equal(byId.get(ids[4]).isEdited, true);
	assert.equal(byId.get(ids[3]).isDeleted, true);
	assert.equal(byId.get(ids[3]).text, undefined, "tombstone has no content");
	assert.deepEqual(byId.get(ids[2]).reactions, [{ userId: b.me.id, emoji: "👍" }]);
	assert.equal(byId.get(ids[1]).isPinned, true);
	assert.equal(byId.get(r6.message.id).text, "m6");
	assert.equal(ch.reset, false);
	const deleted = await a.db("message", "findUnique", { where: { id: ids[3] } });
	assert.equal(deleted.ciphertext, null, "deleted content is wiped");

	// sync window bounded
	assert.equal((await b.get(`/api/conversations/${conv(row)}/changes?since=nope`)).status, 400);
	const stranger = await newUser(srv.base, "Jon");
	assert.equal((await stranger.get(`/api/conversations/${conv(row)}/changes?since=${encodeURIComponent(cursor)}`)).status, 403);
	assert.equal((await stranger.get(`/api/conversations/${conv(row)}/messages`)).status, 403);
	assert.equal((await b.get(`/api/conversations/99999999999/messages`)).status, 400);

	const pinned = (await b.get(`/api/conversations/${conv(row)}/pinned`)).data.pinned;
	assert.deepEqual(pinned.map((p) => p.text), ["m2"]);
	// the older endpoints still answer
	assert.deepEqual((await b.get(`/api/messages/${conv(row)}?limit=2`)).data.map((m) => m.text), ["m5 edited", "m6"]);
	assert.equal((await b.get(`/api/messages/${conv(row)}/pinned`)).data.pinned.length, 1);
});

test("too many changes → reset", { timeout: 60_000 }, async () => {
	const a = await newUser(srv.base, "Kim");
	const row = (await a.get("/api/contacts")).data.find((c) => c.isSaved);
	const cursor = new Date(Date.now() - 60_000).toISOString();
	const many = [];
	for (let i = 0; i < 501; i++) {
		many.push({ conversationId: conv(row), senderId: a.me.id, text: `x${i}` });
	}
	await a.db("message", "createMany", { data: many });
	const ch = (await a.get(`/api/conversations/${conv(row)}/changes?since=${encodeURIComponent(cursor)}`)).data;
	assert.equal(ch.reset, true);
});

test("batch delete and forward; only own messages; blocked chats refuse", async () => {
	const a = await newUser(srv.base, "Lea");
	const b = await newUser(srv.base, "Max");
	const c = await newUser(srv.base, "Ned");
	const ab = await befriend(a, b);
	const ac = await befriend(a, c);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	const mine = [];
	for (let i = 0; i < 30; i++) mine.push((await sa.request("message:send", { conversationId: conv(ab), text: `t${i}`, clientId: `cid-batch-${i}xx` })).message.id);
	const theirs = (await sb.request("message:send", { conversationId: conv(ab), text: "from b" })).message.id;
	const notMine = await sa.request("messages:delete", { messageIds: [mine[0], theirs] });
	assert.equal(notMine.error, "Forbidden");
	const del = await sa.request("messages:delete", { messageIds: mine.slice(0, 25) });
	assert.equal(del.success, true);
	assert.equal(del.deleted.length, 25);
	await sleep(100);
	assert.equal(sb.of("message:deleted").length, 25);
	const left = (await a.get(`/api/conversations/${conv(ab)}/messages`)).data.messages.map((m) => m.text);
	assert.deepEqual(left, ["t25", "t26", "t27", "t28", "t29", "from b"]);

	const fwd = await sa.request("messages:forward", {
		conversationId: conv(ac),
		items: Array.from({ length: 30 }, (_, i) => ({ forwardOf: theirs, clientId: `cid-fwd-${i}xxx` })),
	});
	assert.equal(fwd.success, true);
	assert.equal(fwd.messages.length, 30);
	// text and author come from the original, never from the client
	assert.equal(fwd.messages[0].forwardedFrom, "Max");
	assert.equal(fwd.messages[0].text, "from b");
	assert.equal(fwd.messages[0].forwardedText, "from b");
	const forged = await sa.request("message:send", { conversationId: conv(ac), text: "I owe you $500", forwardedFrom: "Max", forwardedText: "I owe you $500" });
	assert.equal(forged.message.forwardedFrom, null, "a made-up forward label is ignored");
	// a forward of a forward keeps the original author
	const again = await sa.request("message:send", { conversationId: conv(ab), forwardOf: fwd.messages[0].id, text: "" });
	assert.equal(again.message.forwardedFrom, "Max");
	// only messages of chats the forwarder is in
	const cRow = (await c.get("/api/contacts")).data.find((r) => r.isSaved);
	const sc = await c.socket().ready;
	const secret = (await sc.request("message:send", { conversationId: conv(cRow), text: "c's note" })).message.id;
	const stolen = await sa.request("message:send", { conversationId: conv(ab), forwardOf: secret, text: "" });
	assert.equal(stolen.error, "This message can't be forwarded");
	// someone else's one-time message cannot be passed on
	const once = (await sb.request("message:send", { conversationId: conv(ab), text: "once", isOneTime: true })).message.id;
	assert.equal((await sa.request("message:send", { conversationId: conv(ac), forwardOf: once, text: "" })).error, "This message can't be forwarded");
	// REST variant used with keepalive
	const rest = await a.post("/api/messages/delete", { messageIds: [mine[25]] });
	assert.equal(rest.status, 200);

	// block: Ben blocks Ann → Ann cannot send
	const bRow = (await b.get("/api/contacts")).data.find((r) => r.conversationId === conv(ab));
	await b.patch(`/api/contacts/${bRow.id}`, { isBlocked: true });
	const refused = await sa.request("message:send", { conversationId: conv(ab), text: "hello?" });
	assert.equal(refused.error, "Message could not be delivered");
	const refusedFwd = await sa.request("messages:forward", { conversationId: conv(ab), items: [{ forwardOf: theirs }] });
	assert.equal(refusedFwd.error, "Message could not be delivered");
	const own = await sb.request("message:send", { conversationId: conv(ab), text: "x" });
	assert.equal(own.error, "Unblock this contact to send messages");
	// nor can old messages be changed or pinned across the block
	assert.equal((await sa.request("message:edit", { messageId: mine[29], text: "edited after the block" })).error, "Message could not be delivered");
	assert.equal((await sa.request("message:pin", { messageId: mine[29] })).error, "Message could not be delivered");
	assert.equal((await sb.request("message:pin", { messageId: mine[29] })).error, "Unblock this contact to send messages");
	// and the blocked one cannot wipe the chat for the one who blocked them
	assert.equal((await a.del(`/api/conversations/${conv(ab)}/messages`)).status, 403);
});

test("socket actions are rate limited by cost", async () => {
	const s = await startServer({ HTTP_RATE_MAX: "100000", SOCKET_RATE_MAX: "20", VERIFICATION_SEND_LIMIT: "100000" });
	try {
		const a = await newUser(s.base, "Ola");
		const row = (await a.get("/api/contacts")).data.find((c) => c.isSaved);
		const sa = await a.socket().ready;
		const src = (await sa.request("message:send", { conversationId: conv(row), text: "source" })).message.id;
		const big = await sa.request("messages:forward", { conversationId: conv(row), items: Array.from({ length: 50 }, () => ({ forwardOf: src })) });
		assert.equal(big.messages.length, 50, "50 forwarded messages cost 10");
		const results = [];
		for (let i = 0; i < 11; i++) results.push(await sa.request("message:send", { conversationId: conv(row), text: `r${i}` }));
		assert.ok(results.slice(0, 9).every((r) => r.success));
		assert.equal(results[9].error, "Rate limit exceeded");
		// the REST routes take from the same budget
		const viaRest = await a.post("/api/messages", { conversationId: conv(row), text: "rest" });
		assert.equal(viaRest.status, 429);
	} finally {
		s.stop();
	}
});

test("time capsule: hidden until due, opened with the full message", async () => {
	const a = await newUser(srv.base, "Pat");
	const b = await newUser(srv.base, "Quin");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	const early = await sa.request("message:send", { conversationId: conv(row), text: "too soon", isTimeCapsule: true, scheduledFor: new Date(Date.now() + 60_000).toISOString() });
	assert.equal(early.error, "scheduledFor out of range");
	const ok = await sa.request("message:send", {
		conversationId: conv(row),
		text: "future secret",
		isTimeCapsule: true,
		scheduledFor: new Date(Date.now() + 10 * 60_000).toISOString(),
	});
	assert.equal(ok.message.text, "future secret", "the sender sees it");
	const got = await sb.waitFor("message:new");
	assert.equal(got.text, null);
	assert.equal(got.isLocked, true);
	const preview = (await b.get("/api/contacts")).data.find((c) => !c.isSaved).lastMessage;
	assert.equal(preview.text, null);
	assert.equal(preview.isLocked, true);
	assert.equal((await b.get(`/api/messages/search?q=secret`)).data.results.length, 0);
	await a.db("message", "update", { where: { id: ok.message.id }, data: { scheduledFor: new Date(Date.now() - 1000).toISOString() } });
	const opened = await sb.waitFor("message:capsule:opened", null, 40_000);
	assert.equal(opened.text, "future secret");
	assert.equal(opened.message.isLocked, false);
	assert.ok(opened.message.openedAt);
	const forSender = await sa.waitFor("message:capsule:opened", null, 5000);
	assert.equal(forSender.message.text, "future secret");
});

test("one-time message: gone after the reader leaves; both sides told", async () => {
	const a = await newUser(srv.base, "Ray");
	const b = await newUser(srv.base, "Sue");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	const m = (await sa.request("message:send", { conversationId: conv(row), text: "read once", isOneTime: true })).message;
	assert.equal((await sa.request("message:edit", { messageId: m.id, text: "changed" })).error, "One-time messages cannot be edited");
	const preview = (await b.get("/api/contacts")).data.find((c) => !c.isSaved).lastMessage;
	assert.equal(preview.text, null, "one-time preview hidden from the reader");
	sb.emit("conversation:join", { conversationId: conv(row) });
	await sleep(50);
	await sb.request("message:seen", { conversationId: conv(row) });
	sb.emit("conversation:leave", { conversationId: conv(row) });
	const ev = await sa.waitFor("message:onetime-deleted");
	assert.deepEqual(ev.messageIds, [m.id]);
	const stored = await a.db("message", "findUnique", { where: { id: m.id } });
	assert.equal(stored.isDeleted, true);
	assert.equal(stored.ciphertext, null);
});

test("a reply quotes the real message, never text the client made up", async () => {
	const a = await newUser(srv.base, "Fay");
	const b = await newUser(srv.base, "Gus");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	const said = (await sa.request("message:send", { conversationId: conv(row), text: "see you at 8" })).message;
	const reply = await sb.request("message:send", { conversationId: conv(row), text: "ok", replyToId: said.id, replyToText: "I hate you", replyToName: "Someone" });
	assert.equal(reply.message.replyToText, "see you at 8");
	assert.equal(reply.message.replyToSenderId, a.me.id);
	const got = await sa.waitFor("message:new", (m) => m.id === reply.message.id);
	assert.equal(got.replyToText, "see you at 8");
	// a one-time message is never kept in a quote
	const once = (await sa.request("message:send", { conversationId: conv(row), text: "secret once", isOneTime: true })).message;
	const r2 = await sb.request("message:send", { conversationId: conv(row), text: "?", replyToId: once.id, replyToText: "secret once" });
	assert.equal(r2.message.replyToText, null);
	// nor a sealed capsule of someone else
	const cap = (await sa.request("message:send", { conversationId: conv(row), text: "future", isTimeCapsule: true, scheduledFor: new Date(Date.now() + 10 * 60_000).toISOString() })).message;
	const r3 = await sb.request("message:send", { conversationId: conv(row), text: "?", replyToId: cap.id, replyToText: "future" });
	assert.equal(r3.message.replyToText, null);
});

test("typing goes only to the chat this device has joined", async () => {
	const a = await newUser(srv.base, "Ida");
	const b = await newUser(srv.base, "Jon");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	sa.emit("typing:start", { conversationId: conv(row) });
	await sleep(150);
	assert.equal(sb.of("typing:start").length, 0, "not joined: nothing is relayed");
	sa.emit("conversation:join", { conversationId: conv(row) });
	await sleep(100);
	sa.emit("typing:start", { conversationId: conv(row) });
	const ev = await sb.waitFor("typing:start");
	assert.equal(ev.userId, a.me.id);
});

test("re-sending a message deleted meanwhile answers with its tombstone (and the clientId)", async () => {
	const a = await newUser(srv.base, "Mia");
	const b = await newUser(srv.base, "Nik");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const first = await sa.request("message:send", { conversationId: conv(row), text: "oops", clientId: "cid-oops-12345" });
	assert.equal((await sa.request("messages:delete", { messageIds: [first.message.id] })).success, true);
	const again = await sa.request("message:send", { conversationId: conv(row), text: "oops", clientId: "cid-oops-12345" });
	assert.equal(again.duplicate, true);
	assert.equal(again.message.isDeleted, true);
	assert.equal(again.message.clientId, "cid-oops-12345");
	// the other person's copy of the tombstone does not carry it
	const changes = await b.get(`/api/conversations/${conv(row)}/changes?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
	const tomb = changes.data.messages.find((m) => m.id === first.message.id);
	assert.equal(tomb.isDeleted, true);
	assert.equal(tomb.clientId, undefined);
});
