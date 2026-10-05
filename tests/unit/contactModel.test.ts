// Where each chat is listed, in what order, and what its preview says.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	contactsRev,
	effectiveLast,
	getRow,
	patchRow,
	previewText,
	removeRow,
	sectionOf,
	setAllRows,
	sortActive,
	sortContacts,
	upsertRow,
} from "../../client/chat/state/contactModel";
import { contacts } from "../../client/chat/state/stores";
import { at, pending, preview, row } from "./support/fixtures";

const ME = 1;

test("sections: Saved, pinned, open and unread chats are active; archived apart", () => {
	assert.equal(sectionOf(row(1, { isSaved: true }), null, ME), "active");
	assert.equal(sectionOf(row(2, { isPinned: true }), null, ME), "active");
	assert.equal(sectionOf(row(3), 3, ME), "active", "the open chat");
	assert.equal(sectionOf(row(4, { unreadCount: 2 }), null, ME), "active");
	assert.equal(sectionOf(row(5, { lastMessage: preview(9, { senderId: ME, isSeen: false }) }), null, ME), "active", "my message not seen yet");
	assert.equal(sectionOf(row(6, { lastMessage: preview(9, { senderId: ME, isSeen: true }) }), null, ME), "contacts");
	assert.equal(sectionOf(row(7), null, ME, pending("x")), "active", "something being sent");
	assert.equal(sectionOf(row(8, { isArchived: true, unreadCount: 3 }), null, ME), "archived");
});

test("active chats: Saved first, then pinned in their order, then the most recent", () => {
	const rows = [
		row(1, { lastMessage: preview(50) }),
		row(2, { isPinned: true, pinOrder: 2 }),
		row(3, { isSaved: true }),
		row(4, { isPinned: true, pinOrder: 1 }),
		row(5, { lastMessage: preview(70) }),
	];
	assert.deepEqual(
		sortActive(rows, {}).map((r) => r.conversationId),
		[3, 4, 2, 5, 1],
	);
});

test("a message being sent counts as the newest in the order", () => {
	const rows = [row(1, { lastMessage: preview(50) }), row(2, { lastMessage: preview(40) })];
	const sending = { 2: pending("p", { conversationId: 2, createdAt: at(59) }) };
	assert.deepEqual(sortActive(rows, sending).map((r) => r.conversationId), [2, 1]);
});

test("contacts: talked-to first (most recent), then never written to, blocked last", () => {
	const rows = [row(1), row(2, { isBlocked: true, lastMessage: preview(90) }), row(3, { lastMessage: preview(10) }), row(4, { lastMessage: preview(20) })];
	assert.deepEqual(sortContacts(rows).map((r) => r.conversationId), [4, 3, 1, 2]);
});

test("previews never reveal a sealed capsule or someone else's one-time message", () => {
	assert.equal(previewText(preview(1, { isTimeCapsule: true, isLocked: true, text: null }), ME), "Time capsule 🔒");
	assert.equal(previewText(preview(1, { isOneTime: true, text: "secret" }), ME), "One-time message");
	assert.equal(previewText(preview(1, { senderId: ME, isOneTime: true, text: "mine" }), ME), "mine");
	assert.equal(previewText(preview(1, { text: "two\n\nlines" }), ME), "two lines");
});

test("the list shows a failed send as failed, a newer one as pending", () => {
	const r = row(1, { lastMessage: preview(10) });
	const shown = effectiveLast(r, pending("p", { createdAt: at(20), status: "failed" }), ME);
	assert.equal(shown?.failed, true);
	assert.equal(shown?.pending, false);
	const older = effectiveLast(r, pending("p", { createdAt: at(5) }), ME);
	assert.equal(older?.text, "m10", "an older pending message does not replace the preview");
});

test("a full list does not undo live changes made while it was loading", () => {
	contacts.set({ byConv: {}, loaded: false, failed: false });
	setAllRows([row(1), row(2), row(3)]);
	const askedAt = contactsRev();
	// while the list is on its way: a new message, a removal, a new chat
	patchRow(1, { unreadCount: 5, lastMessage: preview(80) });
	removeRow(2);
	upsertRow(row(9));
	// the server's answer, from before those changes
	setAllRows([row(1, { unreadCount: 0 }), row(2), row(3, { nickname: "renamed" })], askedAt);
	assert.equal(getRow(1)?.unreadCount, 5, "the live change wins");
	assert.equal(getRow(2), null, "removed meanwhile: stays removed");
	assert.equal(getRow(9)?.conversationId, 9, "added meanwhile: kept");
	assert.equal(getRow(3)?.nickname, "renamed", "untouched rows take the server's version");
});
