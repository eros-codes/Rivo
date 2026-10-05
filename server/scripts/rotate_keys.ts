// Moves messages from one message key to another (key rotation) without
// decrypting a single message: each message's own key (its DEK) is unwrapped
// with the old KEK and wrapped again with the new one.
//
//   npm run rotate-keys -- --from v1 --to v2 --dry-run    what would happen
//   npm run rotate-keys -- --from v1 --to v2              do it
//
// The whole procedure (new key, ACTIVE_KEY_ID, backup, verify) is in
// server/ENCRYPTION.md. Before a row changes, its previous wrapped key is
// written to backups/rotation-<from>-to-<to>-<time>.jsonl (--backup <folder>
// puts it elsewhere).
import "../env.ts";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import prisma from "../prisma.ts";
import { generateDEK, initKeyStore, unwrapDEK, wrapDEK } from "../utils/encryption.ts";
import { messageOf } from "../utils/errors.ts";

const USAGE = `usage: npm run rotate-keys -- --from v1 --to v2 [--batch 500] [--limit 10000] [--backup backups] [--dry-run]

  --from      the key id the messages use now
  --to        the key id they move to (its KEK_… must be set)
  --batch     messages per round (default 500)
  --limit     stop after this many (default: all)
  --backup    the folder for the backup of changed rows (default: backups)
  --dry-run   only report, change nothing`;

interface Options {
	from: string;
	to: string;
	batch: number;
	limit: number;
	backupDir: string;
	dryRun: boolean;
}

function positive(v: string | undefined, name: string, fallback: number): number {
	if (v === undefined) return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a whole number above 0`);
	return n;
}

function options(): Options | null {
	try {
		const { values } = parseArgs({
			options: {
				from: { type: "string", short: "f" },
				to: { type: "string", short: "t" },
				batch: { type: "string", short: "b" },
				limit: { type: "string", short: "l" },
				backup: { type: "string" },
				"dry-run": { type: "boolean", short: "d" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help) return null;
		if (!values.from || !values.to) throw new Error("--from and --to are both needed");
		if (values.from === values.to) throw new Error("--from and --to are the same key");
		return {
			from: values.from,
			to: values.to,
			batch: positive(values.batch, "--batch", 500),
			limit: positive(values.limit, "--limit", Infinity),
			backupDir: path.resolve(values.backup || "backups"),
			dryRun: !!values["dry-run"],
		};
	} catch (e) {
		console.error(messageOf(e) ?? e);
		return null;
	}
}

async function main(): Promise<number> {
	const opts = options();
	if (!opts) {
		console.log(USAGE);
		return 2;
	}
	const { from, to, dryRun } = opts;
	try {
		await initKeyStore();
	} catch (e) {
		console.error(`Vault: ${messageOf(e) ?? e}`);
		return 4;
	}
	// the new key must work before anything is touched
	try {
		const dek = generateDEK();
		if (!unwrapDEK(wrapDEK(dek, to), to).equals(dek)) throw new Error("it gives back a different DEK");
	} catch (e) {
		console.error(`The key "${to}" does not work: ${messageOf(e) ?? e}`);
		return 3;
	}
	const active = process.env.ACTIVE_KEY_ID || "v1";
	if (active !== to) {
		console.warn(`! ACTIVE_KEY_ID is "${active}": the server still wraps new messages with it. Set ACTIVE_KEY_ID=${to} and restart the server, or new messages keep arriving with "${active}".`);
	}
	console.log(`rotating "${from}" → "${to}"${dryRun ? " (dry run: nothing changes)" : ""}`);

	// opened before the first row changes (a run that changes nothing leaves no file)
	const backup: { stream: fs.WriteStream | null } = { stream: null };
	const backupLine = (line: string): void => {
		if (!backup.stream) {
			fs.mkdirSync(opts.backupDir, { recursive: true });
			const file = path.join(opts.backupDir, `rotation-${from}-to-${to}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
			backup.stream = fs.createWriteStream(file, { flags: "a" });
			console.log(`backup of every changed row → ${file}`);
		}
		backup.stream.write(line);
	};

	let processed = 0;
	let rotated = 0;
	let failed = 0;
	let changedMeanwhile = 0;
	let lastId = 0;
	let code = 0;
	try {
		while (processed < opts.limit) {
			const rows = await prisma.message.findMany({
				where: { key_id: from, id: { gt: lastId } },
				orderBy: { id: "asc" },
				take: Math.min(opts.batch, opts.limit - processed),
				select: { id: true, wrapped_dek: true, updatedAt: true },
			});
			if (rows.length === 0) break;
			for (const r of rows) {
				processed++;
				lastId = r.id;
				// (a deleted message keeps no key; it only still says which one it had)
				if (!r.wrapped_dek) continue;
				try {
					const dek = unwrapDEK(r.wrapped_dek, from);
					const rewrapped = wrapDEK(dek, to);
					// never store a wrapping that has not been opened again
					if (!unwrapDEK(rewrapped, to).equals(dek)) throw new Error("the new wrapping gives back a different DEK");
					if (dryRun) {
						rotated++;
						continue;
					}
					backupLine(`${JSON.stringify({ id: r.id, key_id: from, wrapped_dek: r.wrapped_dek })}\n`);
					// Only if the row is still what was read: an edit in the meantime
					// gave the message a new DEK, and writing the old one back over it
					// would make the message unreadable. updatedAt stays: nothing a
					// person sees changed, so no device has to download it again.
					const { count } = await prisma.message.updateMany({
						where: { id: r.id, key_id: from, wrapped_dek: r.wrapped_dek },
						data: { wrapped_dek: rewrapped, key_id: to, updatedAt: r.updatedAt },
					});
					if (count === 1) rotated++;
					else changedMeanwhile++;
				} catch (e) {
					failed++;
					console.error(`  id ${r.id}: ${messageOf(e) ?? e}`);
					// many failures and no success: the old key is wrong, not a few rows
					if (failed >= 10 && rotated === 0) throw new Error(`stopping: ${failed} failures and no success — is KEK for "${from}" the right key?`, { cause: e });
				}
			}
			console.log(`  … ${processed} looked at, ${rotated} ${dryRun ? "would move" : "moved"}, ${failed} failed`);
		}
	} catch (e) {
		console.error(messageOf(e) ?? e);
		code = 5;
	} finally {
		const stream = backup.stream;
		if (stream) await new Promise<void>((resolve) => stream.end(resolve));
	}
	console.log(`done: ${rotated} ${dryRun ? "would move" : "moved"} to "${to}", ${failed} failed${changedMeanwhile ? `, ${changedMeanwhile} changed during the run (run it again for them)` : ""}`);
	if (!dryRun && rotated > 0) console.log(`next: npm run verify-messages -- --key ${to}`);
	return failed > 0 ? 5 : code;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e: unknown) => {
		console.error("rotation failed:", messageOf(e) ?? e);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
