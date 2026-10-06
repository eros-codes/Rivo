// The input schemas (shared/schemas): what the server accepts from a client,
// what it makes of it, and the words it answers a bad request with. Checked
// the way the server checks (server/http/validate.ts: the first problem, or
// "Invalid data").
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../../server/http/validate.ts";
import { toId } from "../../shared/schemas/common.ts";
import { DeleteMessages, ForwardMessages, MarkSeen, React, SendMessage } from "../../shared/schemas/messages.ts";
import { Register, VerifyCode } from "../../shared/schemas/auth.ts";
import { SearchUsers, UpdateProfile } from "../../shared/schemas/account.ts";
import { UpdateContact } from "../../shared/schemas/contacts.ts";
import { ClearChat, messagesPage } from "../../shared/schemas/conversations.ts";
import { BATCH_MAX, MESSAGE_MAX_LENGTH } from "../../shared/limits.ts";

/** The answer to a bad input (null when it is accepted). */
function refusal(schema: Parameters<typeof check>[0], input: unknown): string | null {
	const r = check(schema, input);
	return r.ok ? null : r.error;
}
function accepted<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
	if (!r.ok) throw new Error(`refused: ${r.error}`);
	return r.data;
}

test("ids: whole numbers 1…2³¹−1, as numbers or digits; nothing else reaches the database", () => {
	for (const ok of [1, 12, "12", " 12 ", 2147483647]) assert.notEqual(toId(ok), null, String(ok));
	for (const bad of [0, -1, 1.5, 2147483648, "12abc", "1.5", "1e3", "", "0x10", null, undefined, {}, [], true]) {
		assert.equal(toId(bad), null, JSON.stringify(bad));
	}
});

test("a new message: trimmed and checked", () => {
	const m = accepted(check(SendMessage, { conversationId: "7", text: "  hi  ", clientId: "abcdefgh" }));
	assert.deepEqual(m, { conversationId: 7, forwardOf: null, text: "hi", isOneTime: false, isTimeCapsule: false, clientId: "abcdefgh", replyToId: null, scheduledFor: null });
	// a quote of "" is no quote; nothing that is not a flag counts as one
	assert.equal(accepted(check(SendMessage, { conversationId: 7, text: "x", replyToId: "" })).replyToId, null);
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x", isOneTime: "yes" }), "Invalid data");
	assert.equal(refusal(SendMessage, { text: "x" }), "Invalid conversationId");
	assert.equal(refusal(SendMessage, { conversationId: "7a", text: "x" }), "Invalid conversationId");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "   " }), "Invalid data");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x".repeat(MESSAGE_MAX_LENGTH + 1) }), "Invalid data");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x", clientId: "bad id!" }), "Invalid clientId");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x", replyToId: "abc" }), "Invalid replyToId");
	assert.equal(refusal(SendMessage, "not an object"), "Invalid data");
	// a name the schema does not know is dropped, not read (the first version's clientMessageId)
	assert.equal(accepted(check(SendMessage, { conversationId: 7, text: "x", clientMessageId: "abcdefgh" })).clientId, null);
	assert.equal("clientMessageId" in accepted(check(SendMessage, { conversationId: 7, text: "x", clientMessageId: "abcdefgh" })), false);
});

test("forwards, one-time messages and capsules: what goes together", () => {
	// a forward needs no text (it is copied from the original)
	assert.equal(accepted(check(SendMessage, { conversationId: 7, forwardOf: 3 })).forwardOf, 3);
	// (a blank is not "no forward": it would send whatever text came with it)
	assert.equal(refusal(SendMessage, { conversationId: 7, forwardOf: "", text: "x" }), "Invalid forwardOf");
	assert.equal(refusal(SendMessage, { conversationId: 7, forwardOf: 3, isOneTime: true }), "Invalid data");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x", isOneTime: true, isTimeCapsule: true }), "Invalid data");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x", isTimeCapsule: true }), "scheduledFor required");
	assert.equal(refusal(SendMessage, { conversationId: 7, text: "x", isTimeCapsule: true, scheduledFor: "soon" }), "scheduledFor invalid");
	const at = new Date(Date.now() + 3600_000).toISOString();
	assert.equal(accepted(check(SendMessage, { conversationId: 7, text: "x", isTimeCapsule: true, scheduledFor: at })).scheduledFor?.toISOString(), at);
	// a date without the capsule means nothing (not even a bad one)
	assert.equal(accepted(check(SendMessage, { conversationId: 7, text: "x", scheduledFor: at })).scheduledFor, null);
	assert.equal(accepted(check(SendMessage, { conversationId: 7, text: "x", scheduledFor: "soon" })).scheduledFor, null);
});

test("batches: at least one, at most BATCH_MAX, repeated ids count once", () => {
	assert.deepEqual(accepted(check(DeleteMessages, { messageIds: [3, "3", 4] })).messageIds, [3, 4]);
	assert.equal(refusal(DeleteMessages, { messageIds: [] }), "Invalid data");
	assert.equal(refusal(DeleteMessages, { messageIds: [3, "x"] }), "Invalid data");
	assert.equal(refusal(DeleteMessages, { messageIds: Array.from({ length: BATCH_MAX + 1 }, (_, i) => i + 1) }), "Invalid data");
	assert.equal(refusal(ForwardMessages, { conversationId: 1, items: [] }), "Invalid data");
	assert.equal(refusal(ForwardMessages, { conversationId: 1, items: [{ forwardOf: "x" }] }), "Invalid forwardOf");
	assert.equal(refusal(React, { messageId: 1, emoji: "a b" }), "Invalid data");
	assert.equal(refusal(React, { messageId: 1, emoji: "x".repeat(17) }), "Invalid data");
});

test("sign-up: the first problem, in the form's words", () => {
	const ok = { name: " Sara ", email: " sara@rivo.ir ", username: "sara_k", password: "12345678" };
	assert.deepEqual(accepted(check(Register, ok)), { name: "Sara", email: "sara@rivo.ir", username: "sara_k", password: "12345678" });
	assert.equal(refusal(Register, { ...ok, name: undefined }), "All fields are required");
	assert.equal(refusal(Register, { ...ok, password: "" }), "All fields are required");
	assert.equal(refusal(Register, { ...ok, email: 5 }), "Invalid fields");
	assert.equal(refusal(Register, { ...ok, name: "   " }), "Name must be between 2 and 100 characters");
	assert.equal(refusal(Register, { ...ok, name: "S" }), "Name must be between 2 and 100 characters");
	assert.equal(refusal(Register, { ...ok, email: "sara@" }), "Please enter a valid email address");
	assert.equal(refusal(Register, { ...ok, username: "sa" }), "Username must be 3-30 letters, numbers or underscores");
	assert.equal(refusal(Register, { ...ok, password: "1234567" }), "Password must be at least 8 characters");
	assert.equal(refusal(Register, { ...ok, password: "x".repeat(129) }), "Password is too long");
	assert.equal(accepted(check(VerifyCode, { email: "a@b.co", code: 123456 })).code, "123456");
	assert.equal(refusal(VerifyCode, { email: "a@b.co", code: "12345" }), "Invalid or expired code");
});

test("a long crafted address is refused quickly (the pattern cannot backtrack)", () => {
	const t = Date.now();
	assert.equal(refusal(Register, { name: "Sara", email: `${"a.".repeat(5000)}@`, username: "sara_k", password: "12345678" }), "Please enter a valid email address");
	assert.ok(Date.now() - t < 200);
});

test("profile changes: only what was sent, at least one thing", () => {
	assert.equal(refusal(UpdateProfile, {}), "Nothing to change");
	assert.deepEqual(accepted(check(UpdateProfile, { bio: null })), { bio: "" });
	assert.equal(accepted(check(UpdateProfile, { username: " @Sara_1 " })).username, "Sara_1");
	assert.equal(refusal(UpdateProfile, { bio: "x".repeat(301) }), "Bio must be 300 characters or fewer");
	assert.equal(refusal(UpdateProfile, { bio: 5 }), "Invalid bio");
	assert.equal(refusal(UpdateProfile, { privacyOnline: "friends" }), "Invalid value for privacyOnline");
	assert.equal(refusal(UpdateProfile, { profilePics: ["/x.jpg"] }), "Upload pictures through /me/avatar");
	assert.equal(refusal(UpdateProfile, { profilePics: [1] }), "Upload pictures through /me/avatar");
	assert.equal(refusal(SearchUsers, { q: "@a" }), "Query too short");
	assert.equal(accepted(check(SearchUsers, { q: " @sara " })).q, "sara");
});

test("contact changes: names are trimmed and cut, an empty one takes it away", () => {
	assert.equal(refusal(UpdateContact, {}), "Nothing to change");
	assert.equal(accepted(check(UpdateContact, { nickname: "   " })).nickname, null);
	assert.equal(accepted(check(UpdateContact, { nickname: "x".repeat(150) })).nickname?.length, 100);
	assert.equal(refusal(UpdateContact, { isMuted: "true" }), "isMuted must be a boolean");
	assert.equal(refusal(UpdateContact, { pinOrder: 10000 }), "pinOrder must be an integer between 0 and 9999");
	assert.equal(accepted(check(UpdateContact, { pinOrder: null })).pinOrder, null);
});

test("pages and clearing a chat", () => {
	const page = messagesPage(50, 100);
	assert.deepEqual(accepted(check(page, { limit: "abc" })), { limit: 50, before: null, beforeId: null });
	assert.equal(accepted(check(page, { limit: "500" })).limit, 100);
	assert.equal(refusal(page, { before: "yesterday" }), "Invalid before date");
	assert.equal(accepted(check(ClearChat, {})).upToId, null);
	// a blank must not mean "delete everything" / "read everything"
	assert.equal(refusal(ClearChat, { upToId: "" }), "Invalid upToId");
	assert.equal(refusal(MarkSeen, { conversationId: 1, upToId: "" }), "Invalid data");
	assert.equal(accepted(check(MarkSeen, { conversationId: 1 })).upToId, null);
});
