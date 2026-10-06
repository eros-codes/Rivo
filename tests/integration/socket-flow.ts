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
//
// It uses the same typed client as the API tests (tests/support/client.ts),
// so it speaks exactly the protocol in shared/.
import { randomUUID } from "node:crypto";
import type { ContactRow } from "../../shared/api.ts";
import { Api, live, ok, sleep, type TestSocket } from "../support/client.ts";

const SERVER = (process.env.TEST_SERVER_URL || "http://localhost:3000").replace(/\/+$/, "");
function accounts(): [userA: string, passA: string, userB: string, passB: string] {
	const { TEST_USER_A: ua, TEST_PASS_A: pa, TEST_USER_B: ub, TEST_PASS_B: pb } = process.env;
	if (!ua || !pa || !ub || !pb) {
		console.error("Set TEST_USER_A, TEST_PASS_A, TEST_USER_B and TEST_PASS_B (and TEST_SERVER_URL if not http://localhost:3000).");
		process.exit(1);
	}
	return [ua, pa, ub, pb];
}
const [USER_A, PASS_A, USER_B, PASS_B] = accounts();

let passed = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
	try {
		const result = await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
		return result;
	} catch (e) {
		throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const newClientId = () => randomUUID().replace(/-/g, "");

/** A's contact row for B: added now, or found among A's contacts. */
async function contactRow(a: Api, username: string): Promise<ContactRow> {
	const added = await a.post<"POST /api/contacts">("/api/contacts", { username });
	if (added.status === 201 || added.status === 200) return added.data;
	if (added.status !== 409) throw new Error(`adding the contact failed (${added.status})`);
	for (let skip = 0; skip < 5000; skip += 100) {
		const page = await a.get<"GET /api/contacts">(`/api/contacts?limit=100&skip=${skip}`);
		if (page.status !== 200) throw new Error(`listing contacts failed (${page.status})`);
		const row = page.data.find((r) => !r.isSaved && r.contact?.username?.toLowerCase() === username.toLowerCase());
		if (row) return row;
		if (page.data.length < 100) break;
	}
	throw new Error("the server says the contact exists but it is not in the list");
}

async function main(): Promise<number> {
	const a = new Api(SERVER, { userAgent: "RivoIntegrationTest/1.0" });
	const b = new Api(SERVER, { userAgent: "RivoIntegrationTest/1.0" });
	let sockA: TestSocket | null = null;
	let sockB: TestSocket | null = null;
	const signOut = (api: Api) => api.post<"POST /api/auth/logout">("/api/auth/logout", {}).catch(() => null);
	try {
		console.log(`Rivo integration test against ${SERVER}`);
		const [{ user: userA }, { user: userB }] = await step("both accounts sign in", () => Promise.all([a.login(USER_A, PASS_A), b.login(USER_B, PASS_B)]));
		check(userA.id !== userB.id, "TEST_USER_A and TEST_USER_B are the same account");
		check(a.csrf(), "the server set no CSRF cookie");

		await step("a request without the CSRF token is refused", async () => {
			const r = await a.req("PATCH", "/api/users/me", { bio: "x" }, { "X-CSRF-Token": "" });
			check(r.status === 403, `expected 403, got ${r.status}`);
		});

		const row = await step("A and B are contacts", () => contactRow(a, USER_B));
		const conversationId = row.conversationId;
		check(Number.isInteger(conversationId), "the contact row has no conversation");
		check(!row.isBlocked, "A has blocked B: unblock to run this test");

		const [sa, sb] = await step("both connect live", () => Promise.all([a.socket().ready, b.socket().ready]));
		sockA = sa;
		sockB = sb;
		sa.emit("conversation:join", { conversationId });
		sb.emit("conversation:join", { conversationId });
		const cursor = new Date().toISOString();
		await sleep(300);

		const clientId = newClientId();
		const text = `integration test ${new Date().toISOString()}`;
		const sent = await step("A sends, B receives it", async () => {
			const ack = ok(await sa.request("message:send", { conversationId, text, clientId }, 6000));
			const got = await sb.waitFor("message:new", (m) => m.id === ack.message.id, 6000);
			check(got.text === text, "B got different text");
			check(got.clientId === undefined, "B got the sender's clientId");
			return ack.message;
		});

		await step("sending the same message again does not duplicate it", async () => {
			const ack = ok(await sa.request("message:send", { conversationId, text, clientId }, 6000));
			check(ack.duplicate === true && ack.message.id === sent.id, `expected the first message back: ${JSON.stringify(ack)}`);
			await sleep(300);
			check(sb.of("message:new").filter((m) => m.id === sent.id).length === 1, "B was sent the message twice");
		});

		await step("A edits, B sees the edit", async () => {
			ok(await sa.request("message:edit", { messageId: sent.id, text: `${text} (edited)` }, 6000));
			const ev = await sb.waitFor("message:edited", (e) => e.messageId === sent.id, 6000);
			check(ev.text === `${text} (edited)` && ev.isEdited, "the edit B got is wrong");
		});

		await step("B cannot edit A's message", async () => {
			const ack = await sb.request("message:edit", { messageId: sent.id, text: "not mine" }, 6000);
			check(ack.error, "the server let B edit A's message");
		});

		const reply = await step("a reply quotes the real message, not what the client claims", async () => {
			// (replyToText: not part of the protocol; a client that sends it anyway is not believed)
			const ack = ok(
				await sb.requestRaw("message:send", { conversationId, text: "integration reply", clientId: newClientId(), replyToId: sent.id, replyToText: "something A never said" }, 6000),
			);
			const got = await sa.waitFor("message:new", (m) => m.id === ack.message.id, 6000);
			check(got.replyToText === `${text} (edited)`, `A got the quote "${got.replyToText}"`);
			return live(ack.message);
		});

		await step("A pins, B sees the pin", async () => {
			ok(await sa.request("message:pin", { messageId: sent.id }, 6000));
			const ev = await sb.waitFor("message:pinned", (e) => e.messageId === sent.id, 6000);
			// leave the chat's pins as they were
			if (ev.isPinned) await sa.request("message:pin", { messageId: sent.id }, 6000);
		});

		await step("A types, B sees it", async () => {
			sa.emit("typing:start", { conversationId });
			const ev = await sb.waitFor("typing:start", (e) => e.conversationId === conversationId, 6000);
			check(ev.userId === userA.id, "typing came from the wrong user");
			sa.emit("typing:stop", { conversationId });
		});

		await step("B reads, A sees it read", async () => {
			const ack = ok(await sb.request("message:seen", { conversationId, upToId: sent.id }, 6000));
			if (ack.marked.length) {
				const ev = await sa.waitFor("message:seen", (e) => e.messageIds.includes(sent.id), 6000);
				check(ev.seenBy === userB.id, "seen by the wrong user");
			}
		});

		const changes = () => b.get<"GET /api/conversations/:id/changes">(`/api/conversations/${conversationId}/changes?since=${encodeURIComponent(cursor)}`);
		await step("a device that was away catches up through /changes", async () => {
			const r = await changes();
			check(r.status === 200, `changes failed (${r.status})`);
			check(typeof r.data.cursor === "string", "no new cursor");
			if (!r.data.reset) {
				const m = r.data.messages.find((x) => x.id === sent.id);
				check(m && !m.isDeleted, "the message is not among the changes");
				check(m.isEdited, "the change has the old version");
			}
		});

		await step("A deletes the message for both, B sees it go", async () => {
			ok(await sa.request("messages:delete", { messageIds: [sent.id] }, 6000));
			ok(await sb.request("messages:delete", { messageIds: [reply.id] }, 6000));
			await sb.waitFor("message:deleted", (e) => e.messageId === sent.id, 6000);
			const r = await changes();
			const m = r.data.messages.find((x) => x.id === sent.id);
			if (!r.data.reset) check(m?.isDeleted && !("text" in m), "the deletion is not in the changes, or it kept its text");
		});

		await step("a signed-out session loses its connection", async () => {
			const closed = new Promise((resolve) => sb.io.once("disconnect", resolve));
			await signOut(b);
			await Promise.race([closed, sleep(4000).then(() => Promise.reject(new Error("B's socket stayed connected")))]);
			const r = await b.get("/api/users/me");
			check(r.status === 401, `expected 401 after signing out, got ${r.status}`);
		});

		console.log(`\nAll ${passed} checks passed.`);
		return 0;
	} catch (e) {
		console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	} finally {
		sockA?.close();
		sockB?.close();
		await Promise.all([signOut(a), signOut(b)]);
	}
}

process.exit(await main());
