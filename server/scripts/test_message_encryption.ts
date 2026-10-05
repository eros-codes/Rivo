// Stores one message the way the server does (encrypted text, sealed quote
// and forwarded text, wrapped with ACTIVE_KEY_ID), reads it back through the
// server's own read path, compares, and removes everything it wrote. It uses
// this .env's keys and database: a pass means the two work together.
//
//   npm run test:enc
import "../env.ts";
import crypto from "node:crypto";
import prisma from "../prisma.ts";
import { encryptMessage, generateDEK, initKeyStore, sealText, wrapDEK } from "../utils/encryption.ts";
import { messageOf } from "../utils/errors.ts";
import { serializeMessage } from "../utils/messageView.ts";

async function main(): Promise<number> {
	if (process.env.NODE_ENV === "production") {
		console.error("NODE_ENV is production: this test does not write there.");
		return 2;
	}
	await initKeyStore();
	const key = process.env.ACTIVE_KEY_ID || "v1";
	const expected = {
		text: `encrypted hello ${new Date().toISOString()} — سلام 👋`,
		replyToText: "the message replied to",
		forwardedText: "a forwarded line",
	};

	const tag = crypto.randomBytes(6).toString("hex");
	const user = await prisma.user.create({
		data: { name: "Encryption test", username: `enc_test_${tag}`, email: `enc_test_${tag}@rivo.invalid`, passwordHash: "!", isDeleted: true },
		select: { id: true },
	});
	let chatId: number | null = null;
	try {
		const chat = await prisma.conversation.create({ data: { members: { create: [{ userId: user.id }] } }, select: { id: true } });
		chatId = chat.id;
		const dek = generateDEK();
		const body = encryptMessage(expected.text, dek);
		const created = await prisma.message.create({
			data: {
				conversationId: chat.id,
				senderId: user.id,
				ciphertext: body.ciphertext,
				iv: body.iv,
				auth_tag: body.authTag,
				wrapped_dek: wrapDEK(dek, key),
				key_id: key,
				replyToName: "Someone",
				replyToText: sealText(expected.replyToText, dek),
				forwardedFrom: "Someone",
				forwardedText: sealText(expected.forwardedText, dek),
			},
			select: { id: true },
		});
		const stored = await prisma.message.findUnique({ where: { id: created.id }, include: { reactions: { select: { userId: true, emoji: true } } } });
		if (!stored) throw new Error("the message was not found after writing it");
		if (stored.ciphertext?.includes(expected.text) || stored.replyToText?.includes(expected.replyToText)) throw new Error("plaintext reached the database");
		const seen = serializeMessage(stored, user.id);
		if (seen.isDeleted) throw new Error("the message reads back as deleted");
		let failed = 0;
		for (const field of ["text", "replyToText", "forwardedText"] as const) {
			const ok = seen[field] === expected[field];
			if (!ok) failed++;
			console.log(`${ok ? "✓" : "✗"} ${field}${ok ? "" : `: got ${JSON.stringify(seen[field])}`}`);
		}
		console.log(failed ? "\nencryption test: FAILED" : `\nencryption test: OK (key "${key}")`);
		return failed ? 1 : 0;
	} finally {
		if (chatId !== null) {
			await prisma.message.deleteMany({ where: { conversationId: chatId } });
			await prisma.conversationMember.deleteMany({ where: { conversationId: chatId } });
			await prisma.conversation.delete({ where: { id: chatId } });
		}
		await prisma.user.delete({ where: { id: user.id } });
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e: unknown) => {
		console.error("encryption test failed:", messageOf(e) ?? e);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
