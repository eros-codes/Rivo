// Contacts and people: adding, changing, removing, privacy, profiles and
// deleting an account.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeDb, startServer, type TestServer } from "../support/backend.ts";
import { Api, befriend, conv, newUser, ok, sleep, type TestUser } from "../support/client.ts";

let srv: TestServer;
before(async () => {
	srv = await startServer();
});
after(async () => {
	await srv?.stop();
	await closeDb();
});

const contacts = async (u: Api) => (await u.get<"GET /api/contacts">("/api/contacts")).data;
const savedRow = async (u: Api) => (await contacts(u)).find((c) => c.isSaved)!;
const otherRow = async (u: Api) => (await contacts(u)).find((c) => !c.isSaved)!;

test("adding a contact tells both people live", async () => {
	const a = await newUser(srv.base, "Ann");
	const b = await newUser(srv.base, "Ben");
	const sa2 = await a.socket().ready; // Ann's other device
	const sb = await b.socket().ready;
	const row = await befriend(a, b);
	assert.equal(row.contact?.username, b.username);
	assert.equal(row.isSaved, false);
	assert.equal(row.lastMessage, null);
	const mine = await sa2.waitFor("contact:upsert");
	assert.equal(mine.id, row.id);
	const theirs = await sb.waitFor("contact:upsert");
	assert.equal(theirs.contact?.username, a.username);
	assert.equal(theirs.conversationId, row.conversationId);
	const dup = await a.post<"POST /api/contacts">("/api/contacts", { username: b.username });
	assert.equal(dup.status, 409);
	const list = await contacts(a);
	assert.equal(list[0]!.isSaved, true, "saved first");
	assert.equal(list[0]!.contact?.id, a.me.id);
});

test("contact changes: serialized answer, other devices told, acting socket skipped", async () => {
	const a = await newUser(srv.base, "Cat");
	const b = await newUser(srv.base, "Dan");
	const row = await befriend(a, b);
	const s1 = await a.socket().ready;
	const s2 = await a.socket().ready;
	const r = await a.patch<"PATCH /api/contacts/:id">(`/api/contacts/${row.id}`, { isPinned: true, nickname: "  Danny  " }, { "X-Socket-Id": s1.id! });
	assert.equal(r.status, 200);
	assert.equal(r.data.isPinned, true);
	assert.equal(r.data.nickname, "Danny");
	assert.equal(r.data.contact?.username, b.username);
	const ev = await s2.waitFor("contact:upsert");
	assert.equal(ev.nickname, "Danny");
	await sleep(150);
	assert.equal(s1.of("contact:upsert").length, 0, "acting device not echoed");
	assert.equal((await a.patch(`/api/contacts/${row.id}`, { isPinned: "yes" })).status, 400);
	const saved = await savedRow(a);
	assert.equal((await a.patch<"PATCH /api/contacts/:id">(`/api/contacts/${saved.id}`, { isBlocked: true })).status, 400);
	assert.equal((await a.patch<"PATCH /api/contacts/:id">(`/api/contacts/${saved.id}`, { isPinned: true })).status, 200);
	const notMine = await otherRow(b);
	assert.equal((await a.patch<"PATCH /api/contacts/:id">(`/api/contacts/${notMine.id}`, { isMuted: true })).status, 404);
});

test("contacts-only privacy: being added by someone does not make them your contact", async () => {
	const a = await newUser(srv.base, "Abe");
	const b = await newUser(srv.base, "Bea");
	// Bea shares her email and status with her contacts only
	await b.patch<"PATCH /api/users/me">("/api/users/me", { privacyEmail: "contacts", privacyOnline: "contacts" });
	await b.socket().ready;
	const ab = await befriend(a, b);
	// Abe added Bea; Bea never chose Abe
	assert.equal(ab.contact?.email, null);
	const seenByAbe = async () => (await contacts(a)).find((c) => c.conversationId === conv(ab))!.contact;
	assert.equal((await seenByAbe())?.email, null);
	// (a search result has no email at all)
	const found = (await a.get(`/api/users/search?q=${b.username}`)).data;
	assert.equal(found.find?.((u: { username: string }) => u.username === b.username)?.email ?? null, null);
	// Bea's list has Abe (so she can answer) ...
	const bRow = (await contacts(b)).find((c) => c.conversationId === conv(ab));
	assert.ok(bRow);
	// ... and adding him herself now makes it her choice (not "already exists")
	const adopt = await b.post<"POST /api/contacts">("/api/contacts", { username: a.username, name: "Abe from work" });
	assert.equal(adopt.status, 200);
	assert.equal(adopt.data.id, bRow.id);
	assert.equal(adopt.data.nickname, "Abe from work");
	assert.equal((await seenByAbe())?.email, b.email);
	assert.equal((await b.post<"POST /api/contacts">("/api/contacts", { username: a.username })).status, 409);

	// writing to someone also makes them a contact
	const c = await newUser(srv.base, "Cal");
	const d = await newUser(srv.base, "Dee");
	await d.patch<"PATCH /api/users/me">("/api/users/me", { privacyEmail: "contacts" });
	const cd = await befriend(c, d);
	const seenByCal = async () => (await contacts(c)).find((x) => x.conversationId === conv(cd))!.contact;
	assert.equal((await seenByCal())?.email, null);
	const sd = await d.socket().ready;
	ok(await sd.request("message:send", { conversationId: conv(cd), text: "hi Cal" }));
	assert.equal((await seenByCal())?.email, d.email);

	// new accounts share their email with contacts only
	const e = await newUser(srv.base, "Eve");
	assert.equal(e.me.privacyEmail, "contacts");
});

test("clear chat for both; contact removal; message to someone who removed you restores their row", async () => {
	const a = await newUser(srv.base, "Tom");
	const b = await newUser(srv.base, "Uma");
	const row = await befriend(a, b);
	const sa = await a.socket().ready;
	const sb = await b.socket().ready;
	const send = async (text: string) => ok(await sa.request("message:send", { conversationId: conv(row), text })).message.id;
	const page = async () => (await a.get<"GET /api/conversations/:id/messages">(`/api/conversations/${conv(row)}/messages`)).data.messages;
	await send("a");
	const seenB = await send("b");
	// written while B's "Chat deleted" could still be undone: not B's to delete
	const late = await send("late");
	assert.equal((await b.del(`/api/conversations/${conv(row)}/messages?upToId=abc`)).status, 400);
	const cleared = await b.del<"DELETE /api/conversations/:id/messages">(`/api/conversations/${conv(row)}/messages?upToId=${seenB}`);
	assert.equal(cleared.status, 200);
	const ev = await sa.waitFor("messages:bulk-deleted");
	assert.equal(ev.upToId, seenB);
	assert.deepEqual(
		(await page()).map((m) => m.id),
		[late],
	);
	assert.equal((await otherRow(b)).unreadCount, 1, "only the message that stayed is unread");
	assert.equal((await b.del<"DELETE /api/conversations/:id/messages">(`/api/conversations/${conv(row)}/messages`)).status, 200);
	assert.equal((await page()).length, 0);

	const bRow = await otherRow(b);
	const sb2 = await b.socket().ready;
	assert.equal((await b.del<"DELETE /api/contacts/:id">(`/api/contacts/${bRow.id}`)).status, 200);
	await sb2.waitFor("contact:removed");
	await send("are you there?");
	const back = await sb.waitFor("contact:upsert", (d) => d.conversationId === conv(row));
	assert.equal(back.contact?.username, a.username);
	const msg = await sb.waitFor("message:new", (d) => d.text === "are you there?");
	assert.equal(msg.text, "are you there?");
});

test("profile updates reach contacts (privacy applied); account deletion", async () => {
	const a = await newUser(srv.base, "Vic");
	const b = await newUser(srv.base, "Wes");
	await befriend(a, b);
	const sb = await b.socket().ready;
	await a.patch<"PATCH /api/users/me">("/api/users/me", { privacyEmail: "nobody" });
	const upd = await sb.waitFor("user:updated");
	assert.equal(upd.email, null);
	assert.equal((await a.patch<"PATCH /api/users/me">("/api/users/me", { name: "V" })).status, 400, "names are 2-100 like at sign-up");
	await a.patch<"PATCH /api/users/me">("/api/users/me", { name: "Victor" });
	const upd2 = await sb.waitFor("user:updated", (d) => d.name === "Victor");
	assert.equal(upd2.username, a.username);

	assert.equal((await a.del<"DELETE /api/users/me">("/api/users/me", { password: "nope" })).status, 403);
	assert.equal((await a.del<"DELETE /api/users/me">("/api/users/me", { password: "password123" })).status, 200);
	const gone = await sb.waitFor("user:updated", (d) => d.isDeleted === true);
	assert.equal(gone.name, "Deleted account");
	assert.equal((await a.get("/api/users/me")).status, 401);
	assert.equal((await new Api(srv.base).post<"POST /api/auth/login">("/api/auth/login", { identifier: a.username, password: "password123" })).status, 401);
	const bRow = await otherRow(b);
	assert.equal(bRow.contact?.isDeleted, true);
	const sb2 = await b.socket().ready;
	const refused = await sb2.request("message:send", { conversationId: bRow.conversationId, text: "hi" });
	assert.equal(refused.error, "This account no longer exists");
});

test("deleting an account wipes its Saved Messages", async () => {
	const a = await newUser(srv.base, "Kim");
	const saved = await savedRow(a);
	const sa = await a.socket().ready;
	const note = ok(await sa.request("message:send", { conversationId: conv(saved), text: "my bank pin hint" })).message;
	assert.equal((await a.del<"DELETE /api/users/me">("/api/users/me", { password: "password123" })).status, 200);
	const stored = await a.db<{ isDeleted: boolean; ciphertext: string | null }>("message", "findUnique", { where: { id: note.id } });
	assert.equal(stored.isDeleted, true);
	assert.equal(stored.ciphertext, null);
});

test("the database itself keeps one row per person in a list", async () => {
	const a = await newUser(srv.base, "Uno");
	const b: TestUser = await newUser(srv.base, "Dos");
	// the same contact added from two devices at the same moment
	const add = () => a.post<"POST /api/contacts">("/api/contacts", { username: b.username });
	const [r1, r2] = await Promise.all([add(), add()]);
	assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
	type Row = { conversationId: number };
	const rows = await a.db<Row[]>("contact", "findMany", { where: { ownerId: a.me.id, contactId: b.me.id } });
	assert.equal(rows.length, 1);
	// and a second row cannot be written even bypassing the app
	await assert.rejects(a.db("contact", "create", { data: { ownerId: a.me.id, contactId: b.me.id, conversationId: rows[0]!.conversationId } }), /Unique constraint/);
	// one Saved Messages per user, too
	const saved = await a.db<Row>("contact", "findFirst", { where: { ownerId: a.me.id, isSaved: true } });
	await assert.rejects(a.db("contact", "create", { data: { ownerId: a.me.id, contactId: a.me.id, conversationId: saved.conversationId, isSaved: true } }), /Unique constraint/);
});
