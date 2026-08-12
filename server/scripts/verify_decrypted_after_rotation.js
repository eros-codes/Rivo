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

  const keyId = process.argv[2] || "v2";
  const sampleSize = Number(process.argv[3]) || 200;
  const rows = await prisma.message.findMany({
    where: { key_id: keyId },
    take: sampleSize,
    orderBy: { id: "desc" },
    select: { id: true, wrapped_dek: true, key_id: true, ciphertext: true, iv: true, auth_tag: true },
  });
  if (!rows.length) {
    console.error(`No message found with key_id=${keyId}`);
    await prisma.$disconnect();
    process.exit(2);
  }

  let ok = 0;
  const failures = [];
  for (const msg of rows) {
    try {
      const dek = unwrapDEK(msg.wrapped_dek, msg.key_id || keyId);
      decryptMessage(msg.ciphertext, msg.iv, msg.auth_tag, dek);
      ok += 1;
    } catch (e) {
      failures.push({ id: msg.id, error: e.message || String(e) });
    }
  }

  console.log(`checked=${rows.length} ok=${ok} failed=${failures.length}`);
  failures.slice(0, 20).forEach((f) => console.error(`  id=${f.id}: ${f.error}`));
  await prisma.$disconnect();
  if (failures.length) process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
