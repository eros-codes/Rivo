#!/usr/bin/env node
import prisma from "../prisma.js";
import dotenv from "dotenv";
import { initKeyStore, unwrapDEK, decryptMessage } from "../utils/encryption.js";

dotenv.config();

async function main() {
  // ensure keystore is loaded from Vault if configured
  try {
    await initKeyStore();
  } catch (e) {
    console.warn("initKeyStore failed (continuing with env fallback):", e.message || e);
  }

  // fetch a message that was rotated to v2
  const msg = await prisma.message.findFirst({ where: { key_id: "v2" } });
  if (!msg) {
    console.error("No message found with key_id=v2");
    await prisma.$disconnect();
    process.exit(2);
  }

  try {
    const dek = unwrapDEK(msg.wrapped_dek, msg.key_id || "v2");
    const plain = decryptMessage(msg.ciphertext, msg.iv, msg.auth_tag, dek);
    console.log("Verified decrypted plaintext:", plain);
  } catch (e) {
    console.error("Failed to decrypt rotated message:", e.message || e);
    process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
