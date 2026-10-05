// The command-line tools in server/scripts on the test database: a key
// rotation from start to end, reading every message back, the encryption
// round trip, the key check. The rotation uses key ids of its own (t1 → t2),
// so it only ever touches the messages this test writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScript } from "./support/backend.mjs";

// the same on every run: the test database keeps what earlier runs moved
const key = (name) => createHash("sha256").update(`rivo-test-${name}`).digest("base64");
const KEYS = { KEK_T1: key("t1"), KEK_T2: key("t2") };

/** "… 12 would move …" → 12 */
function count(out, words) {
	const m = new RegExp(`(\\d+) ${words}`).exec(out);
	assert.ok(m, `"${words}" not in:\n${out}`);
	return Number(m[1]);
}

test("key rotation: dry run, the move, a second run with nothing left, the moved messages read", () => {
	for (let i = 0; i < 2; i++) {
		const ins = runScript("server/scripts/insert_test_message.ts", ["--key", "t1"], KEYS);
		assert.equal(ins.code, 0, ins.out);
	}

	const dry = runScript("server/scripts/rotate_keys.ts", ["--from", "t1", "--to", "t2", "--dry-run"], KEYS);
	assert.equal(dry.code, 0, dry.out);
	const planned = count(dry.out, "would move");
	assert.ok(planned >= 2, dry.out);

	const backups = mkdtempSync(join(tmpdir(), "rivo-rotation-"));
	const real = runScript("server/scripts/rotate_keys.ts", ["--from", "t1", "--to", "t2", "--batch", "1", "--backup", backups], KEYS);
	assert.equal(real.code, 0, real.out);
	assert.equal(count(real.out, "moved to"), planned, real.out);
	// every changed row's previous key was written down first
	const [file] = readdirSync(backups);
	assert.equal(readFileSync(join(backups, file), "utf8").trim().split("\n").length, planned);

	const again = runScript("server/scripts/rotate_keys.ts", ["--from", "t1", "--to", "t2", "--backup", backups], KEYS);
	assert.equal(again.code, 0, again.out);
	assert.equal(count(again.out, "moved to"), 0, again.out);
	assert.equal(readdirSync(backups).length, 1, "a run that changes nothing writes no backup");

	const moved = runScript("server/scripts/verify_messages.ts", ["--key", "t2"], KEYS);
	assert.equal(moved.code, 0, moved.out);
	assert.match(moved.out, /every one of them decrypts/);
	// without the new key they cannot be read: the check really decrypts
	const keyless = runScript("server/scripts/verify_messages.ts", ["--key", "t2"], { ...KEYS, KEK_T2: "" });
	assert.equal(keyless.code, 3, keyless.out);
});

test("rotation refuses before touching anything: the same key twice, a target key that is not set", () => {
	const same = runScript("server/scripts/rotate_keys.ts", ["--from", "t1", "--to", "t1"], KEYS);
	assert.equal(same.code, 2, same.out);
	const missing = runScript("server/scripts/rotate_keys.ts", ["--from", "t1", "--to", "t9"], { ...KEYS, KEK_T9: "" });
	assert.equal(missing.code, 3, missing.out);
	assert.match(missing.out, /does not work/);
});

test("every message in the test database reads back with the test keys", () => {
	const r = runScript("server/scripts/verify_messages.ts", [], KEYS);
	assert.equal(r.code, 0, r.out);
});

test("test:enc writes a message, reads it through the server's own path and removes it", () => {
	const r = runScript("server/scripts/test_message_encryption.ts");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /encryption test: OK/);
});

test("check-kek: the test key works; an active key that is not set fails", () => {
	const ok = runScript("server/scripts/check_kek.ts");
	assert.equal(ok.code, 0, ok.out);
	const r = runScript("server/scripts/check_kek.ts", [], { ACTIVE_KEY_ID: "v7", KEK_V7: "" });
	assert.equal(r.code, 2, r.out);
});
