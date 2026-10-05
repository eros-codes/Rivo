// Stores one encrypted message, wrapped with a chosen key, in a hidden test
// account: something to rotate on a database without real messages.
//
//   npm run insert-test-message                 with ACTIVE_KEY_ID
//   npm run insert-test-message -- --key v1
//
// The account ("rotation_test") is marked deleted, so it never shows up in a
// search and nobody can sign in with it. Every run adds one message to its
// own chat. Not on a production database.
import "../env.ts";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import bcrypt from "bcrypt";
import prisma from "../prisma.ts";
import { encryptMessage, generateDEK, initKeyStore, wrapDEK } from "../utils/encryption.ts";
import { messageOf } from "../utils/errors.ts";

const USERNAME = "rotation_test";

async function main(): Promise<number> {
	if (process.env.NODE_ENV === "production") {
		console.error("NODE_ENV is production: test messages are not written there.");
		return 2;
	}
	let key: string;
	try {
		const { values } = parseArgs({ options: { key: { type: "string" } } });
		key = values.key || process.env.ACTIVE_KEY_ID || "v1";
	} catch (e) {
		console.error(messageOf(e) ?? e);
		console.log("usage: npm run insert-test-message -- [--key v1]");
		return 2;
	}
	await initKeyStore();
	const dek = generateDEK();
	let wrapped: string;
	try {
		wrapped = wrapDEK(dek, key);
	} catch (e) {
		console.error(`The key "${key}" does not work: ${messageOf(e) ?? e}`);
		return 3;
	}

	let user = await prisma.user.findUnique({ where: { username: USERNAME }, select: { id: true, isDeleted: true } });
	if (user && !user.isDeleted) {
		console.error(`"${USERNAME}" is a real account here: nothing was written.`);
		return 2;
	}
	user ??= await prisma.user.create({
		data: {
			name: "Rotation test",
			username: USERNAME,
			email: `${USERNAME}@rivo.invalid`,
			// nobody knows it, and a deleted account cannot sign in anyway
			passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 4),
			isDeleted: true,
		},
		select: { id: true, isDeleted: true },
	});
	const userId = user.id;
	const chat =
		(await prisma.conversation.findFirst({ where: { members: { some: { userId }, every: { userId } } }, select: { id: true } })) ??
		(await prisma.conversation.create({ data: { members: { create: [{ userId }] } }, select: { id: true } }));

	const body = encryptMessage(`rotation test ${new Date().toISOString()}`, dek);
	const message = await prisma.message.create({
		data: { conversationId: chat.id, senderId: userId, ciphertext: body.ciphertext, iv: body.iv, auth_tag: body.authTag, wrapped_dek: wrapped, key_id: key },
		select: { id: true, createdAt: true },
	});
	await prisma.conversation.update({ where: { id: chat.id }, data: { lastMessageAt: message.createdAt } });
	console.log(`stored message ${message.id} (key "${key}") in the test chat ${chat.id}`);
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e: unknown) => {
		console.error("insert failed:", messageOf(e) ?? e);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
