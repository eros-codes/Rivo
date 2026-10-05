// How a chat's loaded messages are merged: pages, live events and catch-ups
// overlap in time, so nothing may be blindly replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWire, clearUpTo, mergeMessages, newerCopy, removeFromCache, withOlderPage } from "../../client/chat/state/chatModel";
import { at, cache, msg, tomb } from "./support/fixtures";

const ids = (c: { messages: { id: number }[] }) => c.messages.map((m) => m.id);

test("messages stay in order and appear once, whatever order they arrive in", () => {
	let c = cache([msg(1), msg(4)]);
	c = mergeMessages(c, [msg(3), msg(2), msg(3), msg(5)]);
	assert.deepEqual(ids(c), [1, 2, 3, 4, 5]);
});

test("an older copy never overwrites a newer one", () => {
	const edited = msg(1, { text: "edited", isEdited: true, updatedAt: at(30) });
	const stale = msg(1, { text: "original", updatedAt: at(1) });
	assert.equal(newerCopy(edited, stale).text, "edited");
	assert.equal(newerCopy(stale, edited).text, "edited");
});

test("seen only goes forward, even if an older copy arrives later", () => {
	const seen = msg(1, { isSeen: true, updatedAt: at(5) });
	const newerButUnseen = msg(1, { text: "edited", isSeen: false, updatedAt: at(9) });
	const merged = newerCopy(seen, newerButUnseen);
	assert.equal(merged.text, "edited");
	assert.equal(merged.isSeen, true);
});

test("an opened time capsule never locks again", () => {
	const opened = msg(1, { isTimeCapsule: true, isLocked: false, text: "secret", openedAt: at(9), updatedAt: at(9) });
	const lockedOld = msg(1, { isTimeCapsule: true, isLocked: true, text: null, updatedAt: at(9) });
	const merged = newerCopy(opened, lockedOld);
	assert.equal(merged.isLocked, false);
	assert.equal(merged.text, "secret");
});

test("the sender's clientId is kept when a copy without it arrives", () => {
	const mine = msg(1, { clientId: "abc12345" });
	const echoed = msg(1, { updatedAt: at(20) });
	assert.equal(newerCopy(mine, echoed).clientId, "abc12345");
});

test("a deleted message never comes back from an older copy", () => {
	let c = cache([msg(1), msg(2)]);
	c = applyWire(c, [tomb(2)]);
	assert.deepEqual(ids(c), [1]);
	c = applyWire(c, [msg(2)]);
	assert.deepEqual(ids(c), [1], "a page or event from before the deletion is ignored");
});

test("a message older than the loaded ones waits for its page", () => {
	const c = mergeMessages(cache([msg(10), msg(11)], { hasMore: true }), [msg(5)]);
	assert.deepEqual(ids(c), [10, 11]);
	const all = mergeMessages(cache([msg(10), msg(11)], { hasMore: false }), [msg(5)]);
	assert.deepEqual(ids(all), [5, 10, 11], "with the whole history loaded it belongs in the list");
});

test("an older page goes in front, without duplicates or deleted ones", () => {
	const c = cache([msg(5), msg(6)], { hasMore: true, gone: { 3: true } });
	const next = withOlderPage(c, { messages: [msg(2), msg(3), msg(4), msg(5)], hasMore: false, cursor: at(60) });
	assert.deepEqual(ids(next), [2, 4, 5, 6]);
	assert.equal(next.hasMore, false);
});

test("removing messages also takes them off the pinned list", () => {
	const c = cache([msg(1), msg(2)], { pinned: [{ id: 2, text: "m2", senderId: 2, createdAt: at(2) }] });
	const next = removeFromCache(c, [2]);
	assert.deepEqual(ids(next), [1]);
	assert.deepEqual(next.pinned, []);
	assert.equal(next.gone[2], true);
});

test("clearing a chat up to a message keeps what came after it", () => {
	const c = cache([msg(1), msg(2), msg(3)], {
		hasMore: true,
		pinned: [
			{ id: 1, text: "m1", senderId: 2, createdAt: at(1) },
			{ id: 3, text: "m3", senderId: 2, createdAt: at(3) },
		],
	});
	const next = clearUpTo(c, 2);
	assert.deepEqual(ids(next), [3]);
	assert.deepEqual(next.pinned?.map((p) => p.id), [3]);
	assert.equal(next.hasMore, false, "nothing older is left on the server");
});
