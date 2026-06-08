#!/usr/bin/env node
import prisma from "../prisma.js";

async function main() {
  const id = process.argv[2] || 4;
  const msg = await prisma.message.findUnique({ where: { id: Number(id) }, select: { id: true, ciphertext: true, iv: true, auth_tag: true, wrapped_dek: true, key_id: true, text: true, createdAt: true } });
  console.log(JSON.stringify(msg, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
