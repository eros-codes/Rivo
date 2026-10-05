// Unsent messages are kept on the device. Two tabs of the same account keep
// them in the same place and must not wipe each other's.
import "./support/browser";
import { test } from "node:test";
import assert from "node:assert/strict";
import { persistOutbox, restoreOutbox } from "../../client/chat/services/outboxStore";
import { outbox } from "../../client/chat/state/stores";
import { localStore } from "./support/browser";
import { pending } from "./support/fixtures";

const KEY = "rivo.outbox.7";
const saved = () => (JSON.parse(localStore.getItem(KEY) ?? "[]") as { clientId: string }[]).map((p) => p.clientId).sort();
const settle = () => new Promise((r) => setTimeout(r, 350));

test("tabs keep each other's unsent messages", async () => {
	localStore.clear();
	outbox.set({});
	const stop = persistOutbox(7);
	try {
		outbox.set({ P: pending("P") });
		await settle();
		assert.deepEqual(saved(), ["P"]);

		// another tab of the same account stores its own
		localStore.setItem(KEY, JSON.stringify([...JSON.parse(localStore.getItem(KEY)!), pending("Q")]));

		outbox.set((s) => ({ ...s, R: pending("R") }));
		await settle();
		assert.deepEqual(saved(), ["P", "Q", "R"], "the other tab's Q is still there");

		// this tab's P is delivered: it goes, Q stays
		outbox.set((s) => {
			const next = { ...s };
			delete next.P;
			return next;
		});
		await settle();
		assert.deepEqual(saved(), ["Q", "R"]);
	} finally {
		stop();
	}
});

test("after a reload everything waiting is queued again, refused ones stay failed", () => {
	localStore.clear();
	outbox.set({});
	localStore.setItem(
		KEY,
		JSON.stringify([pending("A", { status: "sending" }), pending("B", { status: "failed", error: "Message could not be delivered" }), { junk: true }]),
	);
	restoreOutbox(7);
	const box = outbox.get();
	assert.equal(box.A?.status, "queued");
	assert.equal(box.B?.status, "failed");
	assert.equal(Object.keys(box).length, 2, "malformed entries are dropped");
});
