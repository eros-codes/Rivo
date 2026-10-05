// Reads stored messages back with this .env's keys (or Vault's): the text,
// the quote and the forwarded text of each must decrypt. Changes nothing.
// Run it after a key rotation, after moving the database, or whenever in doubt.
//
//   npm run verify-messages                    every message
//   npm run verify-messages -- --key v2        only those wrapped with v2
//   npm run verify-messages -- --limit 500     only the newest 500
import "../env.ts";
import { parseArgs } from "node:util";
import prisma from "../prisma.ts";
import { decryptMessage, initKeyStore, openText, unwrapDEK } from "../utils/encryption.ts";
import { messageOf } from "../utils/errors.ts";

const USAGE = "usage: npm run verify-messages -- [--key v2] [--limit 500]";
const BATCH = 500;

interface Options {
	key: string | null;
	limit: number;
}

function options(): Options | null {
	try {
		const { values } = parseArgs({ options: { key: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" } } });
		if (values.help) return null;
		const limit = values.limit === undefined ? Infinity : Number(values.limit);
		if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) throw new Error("--limit must be a whole number above 0");
		return { key: values.key ?? null, limit };
	} catch (e) {
		console.error(messageOf(e) ?? e);
		return null;
	}
}

type Row = {
	id: number;
	key_id: string | null;
	ciphertext: string | null;
	iv: string | null;
	auth_tag: string | null;
	wrapped_dek: string | null;
	replyToText: string | null;
	forwardedText: string | null;
};

/** Why the message cannot be read, or null when it can. */
function problemWith(m: Row): string | null {
	if (!m.wrapped_dek) return "has text but no wrapped key";
	try {
		const dek = unwrapDEK(m.wrapped_dek, m.key_id || "v1");
		decryptMessage(m.ciphertext ?? "", m.iv ?? "", m.auth_tag ?? "", dek);
		if (m.replyToText) openText(m.replyToText, dek);
		if (m.forwardedText) openText(m.forwardedText, dek);
		return null;
	} catch (e) {
		return messageOf(e) ?? String(e);
	}
}

async function main(): Promise<number> {
	const opts = options();
	if (!opts) {
		console.log(USAGE);
		return 2;
	}
	try {
		await initKeyStore();
	} catch (e) {
		console.error(`Vault: ${messageOf(e) ?? e}`);
		return 2;
	}

	const perKey = new Map<string, number>();
	const failures: { id: number; key: string; problem: string }[] = [];
	let checked = 0;
	let deleted = 0;
	let before: number | null = null;
	while (checked < opts.limit) {
		const rows: Row[] = await prisma.message.findMany({
			where: { ...(opts.key ? { key_id: opts.key } : {}), ...(before !== null ? { id: { lt: before } } : {}) },
			orderBy: { id: "desc" },
			take: Math.min(BATCH, opts.limit - checked),
			select: { id: true, key_id: true, ciphertext: true, iv: true, auth_tag: true, wrapped_dek: true, replyToText: true, forwardedText: true },
		});
		if (rows.length === 0) break;
		for (const m of rows) {
			before = m.id;
			checked++;
			// a deleted message keeps no text: nothing to read
			if (!m.ciphertext) {
				deleted++;
				continue;
			}
			const key = m.key_id || "v1";
			perKey.set(key, (perKey.get(key) ?? 0) + 1);
			const problem = problemWith(m);
			if (problem) failures.push({ id: m.id, key, problem });
		}
	}

	if (checked === 0) {
		console.log(opts.key ? `No message is wrapped with "${opts.key}".` : "There are no messages.");
		return opts.key ? 2 : 0;
	}
	const keys = [...perKey].map(([k, n]) => `${k}: ${n}`).join(", ") || "none";
	console.log(`checked ${checked} message(s) (${keys}; ${deleted} deleted, nothing to read)`);
	if (failures.length === 0) {
		console.log("✓ every one of them decrypts");
		return 0;
	}
	console.error(`✗ ${failures.length} cannot be read:`);
	for (const f of failures.slice(0, 20)) console.error(`  id ${f.id} (${f.key}): ${f.problem}`);
	if (failures.length > 20) console.error(`  … and ${failures.length - 20} more`);
	return 3;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e: unknown) => {
		console.error("verify failed:", messageOf(e) ?? e);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
