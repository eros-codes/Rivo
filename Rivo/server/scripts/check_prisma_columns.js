#!/usr/bin/env node
import prisma from "../prisma.js";

async function check() {
  try {
    // Try lowercase table name first
    const tbls = ["message", "Message"];
    for (const t of tbls) {
      const cols = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = ${t}`;
      if (cols && cols.length > 0) {
        console.log(`Found table '${t}' with columns:`);
        console.log(cols.map((r) => r.column_name).join(", "));
        const needed = ["ciphertext", "iv", "auth_tag", "wrapped_dek", "key_id"];
        const present = cols.map((r) => r.column_name);
        const missing = needed.filter((n) => !present.includes(n));
        if (missing.length === 0) {
          console.log("All encryption columns present.");
          process.exit(0);
        } else {
          console.warn("Missing columns:", missing);
          process.exit(2);
        }
      }
    }
    console.warn("Message table not found (checked 'message' and 'Message').");
    process.exit(3);
  } catch (e) {
    console.error("Error checking columns:", e.message || e);
    process.exit(4);
  } finally {
    await prisma.$disconnect();
  }
}

check();
