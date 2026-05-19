#!/usr/bin/env node
import prisma from "../prisma.js";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { generateDEK, encryptMessage, wrapDEK } from "../utils/encryption.js";

dotenv.config();

async function main() {
  // ensure KEK availability (dev fallback)
  if (!process.env.KEK_V1 && !(process.env.SECRET_PROVIDER || "").toLowerCase() === "vault") {
    console.warn("No KEK_V1 set; generating ephemeral KEK_V1 for test");
    process.env.KEK_V1 = crypto.randomBytes(32).toString("base64");
  }

  const user = await prisma.user.create({
    data: {
      name: "RotationUser",
      username: `rotation_user_${Date.now()}`,
      email: `rotation_${Date.now()}@example.com`,
      passwordHash: "x",
    },
  });

  const conv = await prisma.conversation.create({ data: {} });

  const plaintext = "Persistent rotation test " + new Date().toISOString();
  const dek = generateDEK();
  const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);
  const keyId = "v1";
  const wrapped = wrapDEK(dek, keyId);

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
    },
  });

  console.log("Inserted persistent message id=", message.id);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
