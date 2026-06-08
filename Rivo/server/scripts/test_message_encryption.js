import prisma from "../prisma.js";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage } from "../utils/encryption.js";

dotenv.config();

async function main() {
  // Ensure a KEK exists for the test; use ephemeral if not set (DO NOT use in prod)
  if (!process.env.KEK_V1 && !process.env.KEK) {
    const demo = crypto.randomBytes(32).toString("base64");
    console.warn("No KEK found in env, using ephemeral KEK_V1 for test (not for production)");
    process.env.KEK_V1 = demo;
  }

  // Create test user
  const user = await prisma.user.create({
    data: {
      name: "Test User",
      username: `testuser_${Date.now()}`,
      email: `test_${Date.now()}@example.com`,
      passwordHash: "x",
    },
  });

  // Create conversation
  const conv = await prisma.conversation.create({ data: {} });

  // Create message encrypted
  const plaintext = "Hello encrypted world " + new Date().toISOString();
  const dek = generateDEK();
  const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);
  const keyId = "v1";
  const wrapped = wrapDEK(dek, keyId);

  // also test replyToText and forwardedText encryption stored as JSON
  const replyPlain = "This is reply text";
  const forwardedPlain = "This is forwarded text";
  const r = encryptMessage(replyPlain, dek);
  const f = encryptMessage(forwardedPlain, dek);
  const replyEncrypted = JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
  const forwardedEncrypted = JSON.stringify({ c: f.ciphertext, iv: f.iv, t: f.authTag });

  const message = await prisma.message.create({
    data: {
      conversationId: conv.id,
      senderId: user.id,
      text: null,
      ciphertext,
      iv,
      auth_tag: authTag,
      wrapped_dek: wrapped,
      key_id: keyId,
      replyToText: replyEncrypted,
      forwardedText: forwardedEncrypted,
    },
  });

  console.log("Inserted message id=", message.id);

  // Fetch and decrypt
  const fetched = await prisma.message.findUnique({ where: { id: message.id } });
  try {
    const dek2 = unwrapDEK(fetched.wrapped_dek, fetched.key_id || "v1");
    const plain = decryptMessage(fetched.ciphertext, fetched.iv, fetched.auth_tag, dek2);
    console.log("Decrypted text:", plain);
    // decrypt reply/forwarded
    const parsedR = JSON.parse(fetched.replyToText);
    const parsedF = JSON.parse(fetched.forwardedText);
    const rplain = decryptMessage(parsedR.c, parsedR.iv, parsedR.t, dek2);
    const fplain = decryptMessage(parsedF.c, parsedF.iv, parsedF.t, dek2);
    console.log("Decrypted replyToText:", rplain);
    console.log("Decrypted forwardedText:", fplain);
  } catch (e) {
    console.error("Decrypt failed:", e.message);
  }

  // cleanup test data
  await prisma.message.delete({ where: { id: message.id } }).catch(() => {});
  await prisma.conversation.delete({ where: { id: conv.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
