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

  const msgs = await prisma.message.findMany({ select: { id: true, key_id: true, wrapped_dek: true } });
  const failed = [];
  for (const m of msgs) {
    if (!m.wrapped_dek) continue;
    try {
      unwrapDEK(m.wrapped_dek, m.key_id || "v1");
    } catch (e) {
      failed.push({ id: m.id, key_id: m.key_id, error: e.message });
    }
  }

  console.log(`checked ${msgs.length} messages; failures=${failed.length}`);
  if (failed.length > 0) {
    console.log("Failures:");
    for (const f of failed) console.log(JSON.stringify(f));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
