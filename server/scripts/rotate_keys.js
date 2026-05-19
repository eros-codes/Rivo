#!/usr/bin/env node
import prisma from "../prisma.js";
import { unwrapDEK, wrapDEK, initKeyStore } from "../utils/encryption.js";
import crypto from "node:crypto";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" || a === "-f") out.from = argv[++i];
    else if (a === "--to" || a === "-t") out.to = argv[++i];
    else if (a === "--batch" || a === "-b") out.batch = parseInt(argv[++i], 10);
    else if (a === "--dry-run" || a === "-d") out.dry = true;
    else if (a === "--limit" || a === "-l") out.limit = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
}

function usage() {
  console.log(`Usage: node server/scripts/rotate_keys.js --from v1 --to v2 [--batch 1000] [--limit 10000] [--dry-run]

Options:
  --from, -f    Key id to rotate from (e.g. v1)
  --to, -t      Key id to rotate to (e.g. v2)
  --batch, -b   Batch size (default 1000)
  --limit, -l   Max total messages to process (optional)
  --dry-run, -d Do not perform DB updates, only report
  --help, -h    Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const from = args.from;
  const to = args.to;
  const batchSize = Number.isInteger(args.batch) && args.batch > 0 ? args.batch : 1000;
  const dryRun = !!args.dry;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : Infinity;

  if (!from || !to) {
    console.error("--from and --to are required");
    usage();
    process.exit(2);
  }

  console.log(`Rotate messages from '${from}' → '${to}', batch=${batchSize}, dryRun=${dryRun}`);

  // initialize keystore (if using Vault)
  try {
    await initKeyStore();
  } catch (e) {
    console.error("initKeyStore failed:", e && e.message ? e.message : e);
    if ((process.env.SECRET_PROVIDER || "").toLowerCase() === "vault") {
      console.error("SECRET_PROVIDER=vault but keystore initialization failed — aborting.");
      process.exit(4);
    }
  }

  // Quick check: ensure target KEK exists by attempting a wrap of a test DEK
  try {
    const testDek = crypto.randomBytes(32);
    wrapDEK(testDek, to);
  } catch (e) {
    console.error(`Failed to access target KEK for '${to}': ${e.message}`);
    process.exit(3);
  }

  let processed = 0;
  let rotated = 0;
  let failed = 0;
  let skipped = 0;

  let lastId = 0;
  try {
    while (processed < limit) {
      const take = Math.min(batchSize, limit - processed);
      const rows = await prisma.message.findMany({
        where: { key_id: from, id: { gt: lastId } },
        orderBy: { id: "asc" },
        take,
        select: { id: true, wrapped_dek: true, key_id: true },
      });

      if (!rows || rows.length === 0) break;

      for (const r of rows) {
        processed += 1;
        lastId = r.id;
        if (!r.wrapped_dek) {
          skipped += 1;
          console.warn(`skip id=${r.id} (no wrapped_dek)`);
          continue;
        }

        try {
          // Unwrap with message's current key_id (should equal 'from')
          const dek = unwrapDEK(r.wrapped_dek, r.key_id || from);
          // Re-wrap with target KEK
          const newWrapped = wrapDEK(dek, to);

          if (dryRun) {
            console.log(`[dry] would update id=${r.id} key_id=${r.key_id} -> ${to}`);
            rotated += 1;
            continue;
          }

          await prisma.message.update({
            where: { id: r.id },
            data: { wrapped_dek: newWrapped, key_id: to },
          });
          rotated += 1;
        } catch (e) {
          failed += 1;
          console.error(`failed id=${r.id}: ${e.message}`);
          // continue with next row
        }
      }

      console.log(`batch done: processed=${processed}, rotated=${rotated}, failed=${failed}, skipped=${skipped}`);

      // small delay optional to reduce DB pressure when not dry-run
      if (!dryRun) await new Promise((res) => setTimeout(res, 50));
    }
  } catch (e) {
    console.error("rotation failed", e);
  } finally {
    console.log(`finished: processed=${processed}, rotated=${rotated}, failed=${failed}, skipped=${skipped}`);
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
