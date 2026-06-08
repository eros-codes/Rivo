#!/usr/bin/env node
import dotenv from "dotenv";
import prisma from "../prisma.js";
import { initKeyStore, unwrapDEK } from "../utils/encryption.js";

dotenv.config();

async function main() {
  try {
    await initKeyStore();
  } catch (e) {
    console.warn("initKeyStore failed (continuing with env fallback):", e && e.message ? e.message : e);
  }

  const msgs = await prisma.message.findMany({ where: { key_id: "v2" }, orderBy: { id: "asc" }, select: { id: true, wrapped_dek: true, key_id: true } });
  if (!msgs || msgs.length === 0) {
    console.error("No messages found with key_id=v2");
    await prisma.$disconnect();
    process.exit(2);
  }

  for (const msg of msgs) {
    console.log("---");
    console.log("Message:", { id: msg.id, key_id: msg.key_id });
    const wrapped = msg.wrapped_dek;
    if (!wrapped) {
      console.warn("  No wrapped_dek on message");
      continue;
    }
    const buf = Buffer.from(wrapped, "base64");
    console.log("  wrapped_dek base64 length:", wrapped.length, "-> buffer length:", buf.length);
    console.log("  iv bytes:", buf.slice(0, 12).length, "tag bytes:", buf.slice(12, 28).length, "cipher bytes:", buf.slice(28).length);
    try {
      const dek = unwrapDEK(wrapped, msg.key_id || "v2");
      console.log("  unwrap succeeded, dek length=", dek.length);
    } catch (e) {
      console.error("  unwrapDEK failed:", e && e.message ? e.message : e);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
