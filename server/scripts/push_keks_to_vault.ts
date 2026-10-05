// Puts the message keys of this .env (KEK_V1, KEK_V2, …) into Vault, KV
// version 2, at VAULT_KV_MOUNT / VAULT_KV_PATH, next to whatever is already
// stored there (nothing else at that path is lost).
//
//   npm run push-keks -- --dry-run    what would be written (names only)
//   npm run push-keks
//
// A key that is already in Vault with a different value is never replaced
// without --force: messages wrapped with the old value could not be read again.
import "../env.ts";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { messageOf } from "../utils/errors.ts";

const USAGE = "usage: npm run push-keks -- [--dry-run] [--force]";

type Secret = Record<string, unknown>;
interface Stored {
	data: Secret;
	/** 0 when nothing is stored there yet */
	version: number;
}

function isKey(value: string): boolean {
	return Buffer.from(value, "base64").length === 32 || /^[0-9a-f]{64}$/i.test(value);
}

function ask(question: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

class Vault {
	readonly url: string;
	readonly token: string;
	constructor(addr: string, token: string, mount: string, secretPath: string) {
		this.url = `${addr.replace(/\/+$/, "")}/v1/${mount}/data/${secretPath}`;
		this.token = token;
	}

	async read(): Promise<Stored> {
		const res = await fetch(this.url, { headers: { "X-Vault-Token": this.token, Accept: "application/json" } });
		// nothing at this path yet
		if (res.status === 404) return { data: {}, version: 0 };
		if (!res.ok) throw new Error(`Vault answered ${res.status} when reading ${this.url}: ${await res.text()}`);
		const body = (await res.json()) as { data?: { data?: Secret | null; metadata?: { version?: number } } };
		return { data: body.data?.data ?? {}, version: body.data?.metadata?.version ?? 0 };
	}

	/** Writes the whole secret; `cas` refuses if someone else wrote in between. */
	async write(data: Secret, cas: number): Promise<number | undefined> {
		const res = await fetch(this.url, {
			method: "POST",
			headers: { "X-Vault-Token": this.token, "Content-Type": "application/json" },
			body: JSON.stringify({ options: { cas }, data }),
		});
		if (!res.ok) throw new Error(`Vault answered ${res.status} when writing: ${await res.text()}`);
		const body = (await res.json().catch(() => null)) as { data?: { version?: number } } | null;
		return body?.data?.version;
	}
}

async function main(): Promise<number> {
	let flags: { dryRun: boolean; force: boolean };
	try {
		const { values } = parseArgs({ options: { "dry-run": { type: "boolean", short: "d" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
		if (values.help) {
			console.log(USAGE);
			return 0;
		}
		flags = { dryRun: !!values["dry-run"], force: !!values.force };
	} catch (e) {
		console.error(messageOf(e) ?? e);
		console.log(USAGE);
		return 2;
	}

	const addr = process.env.VAULT_ADDR;
	const token = process.env.VAULT_TOKEN;
	if (!addr || !token) {
		console.error("VAULT_ADDR and VAULT_TOKEN must be set (in .env or the environment).");
		return 2;
	}
	if (process.env.NODE_ENV === "production" && !addr.startsWith("https://")) {
		console.error("In production Vault must be reached over https (the token would travel in clear text).");
		return 2;
	}

	// the keys to push: every KEK_V<n> that is set, or KEK_V1 typed in
	const keys: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (/^KEK_V\d+$/.test(name) && value) keys[name] = value;
	}
	if (Object.keys(keys).length === 0) {
		if (!process.stdin.isTTY) {
			console.error("No KEK_V… is set in .env, and there is no terminal to type one into.");
			return 2;
		}
		const typed = await ask("KEK_V1 (base64; empty to cancel): ");
		if (!typed) return 2;
		keys.KEK_V1 = typed;
	}
	const malformed = Object.entries(keys).filter(([, v]) => !isKey(v)).map(([n]) => n);
	if (malformed.length) {
		console.error(`Not a 32-byte key (base64 or hex): ${malformed.join(", ")}`);
		return 2;
	}

	const vault = new Vault(addr, token, process.env.VAULT_KV_MOUNT || "secret", process.env.VAULT_KV_PATH || "rivo");
	console.log(`Vault: ${vault.url}`);
	const stored = await vault.read();
	const add: string[] = [];
	const same: string[] = [];
	const different: string[] = [];
	for (const [name, value] of Object.entries(keys)) {
		if (!(name in stored.data)) add.push(name);
		else if (stored.data[name] === value) same.push(name);
		else different.push(name);
	}
	if (same.length) console.log(`already there, same value: ${same.join(", ")}`);
	if (different.length && !flags.force) {
		console.error(`already there with a DIFFERENT value: ${different.join(", ")}`);
		console.error("Replacing a key makes the messages wrapped with the old value unreadable. Nothing was written.");
		console.error("(Only if you are sure: --force.)");
		return 4;
	}
	const writes = [...add, ...different];
	if (writes.length === 0) {
		console.log("Nothing to write.");
		return 0;
	}
	const others = Object.keys(stored.data).filter((n) => !(n in keys));
	console.log(`would write: ${add.map((n) => `${n} (new)`).concat(different.map((n) => `${n} (REPLACED)`)).join(", ")}`);
	if (others.length) console.log(`kept as they are: ${others.join(", ")}`);
	if (flags.dryRun) {
		console.log("Dry run: nothing was written.");
		return 0;
	}
	const version = await vault.write({ ...stored.data, ...keys }, stored.version);
	console.log(`✓ written${version !== undefined ? ` (version ${version})` : ""}`);
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e: unknown) => {
		console.error("push failed:", messageOf(e) ?? e);
		process.exitCode = 1;
	});
