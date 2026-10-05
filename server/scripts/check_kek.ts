// Checks the message keys of this .env (or of Vault, with SECRET_PROVIDER=vault)
// without touching the database: the key new messages use (ACTIVE_KEY_ID)
// must work, and every KEK_V… that is set must be a valid key.
//
//   npm run check-kek
import "../env.ts";
import { generateDEK, initKeyStore, unwrapDEK, wrapDEK } from "../utils/encryption.ts";
import { messageOf } from "../utils/errors.ts";

const active = process.env.ACTIVE_KEY_ID || "v1";

/** Wraps a fresh DEK with the key and opens it again. */
function works(keyId: string): string | null {
	try {
		const dek = generateDEK();
		return unwrapDEK(wrapDEK(dek, keyId), keyId).equals(dek) ? null : "the key gave back a different DEK";
	} catch (e) {
		return messageOf(e) ?? String(e);
	}
}

async function main(): Promise<number> {
	try {
		await initKeyStore();
	} catch (e) {
		console.error(`Vault: ${messageOf(e) ?? e}`);
		return 2;
	}
	const ids = new Set([active]);
	for (const name of Object.keys(process.env)) {
		const m = /^KEK_(V\d+)$/i.exec(name);
		if (m && process.env[name]) ids.add((m[1] as string).toLowerCase());
	}
	let failed = 0;
	for (const id of [...ids].sort()) {
		const problem = works(id);
		const role = id === active ? " (ACTIVE_KEY_ID: new messages)" : "";
		if (problem) failed++;
		console.log(`${problem ? "✗" : "✓"} ${id}${role}${problem ? `: ${problem}` : ""}`);
	}
	console.log(failed ? "\nKEK check: FAILED" : "\nKEK check: OK");
	return failed ? 2 : 0;
}

main().then((code) => {
	process.exitCode = code;
});
