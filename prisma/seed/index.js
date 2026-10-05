#!/usr/bin/env node
// Test data for development: 16 people, their contacts and conversations.
//
//   npm run db:seed               fills an empty database
//   npm run db:seed -- --wipe     empties the database first (everything in it!)
//
// Never on a production server. Stop the server while it runs (it keeps
// caches of who is in which chat), start it again afterwards.
import "../../server/env.js";
import { MAIN, PASSWORD, people, prisma, seed, wipe } from "./seed.js";

const args = new Set(process.argv.slice(2));

function databaseOf(url) {
	try {
		const u = new URL(url);
		return { host: u.hostname, name: u.pathname.slice(1) || "(default)" };
	} catch {
		return { host: "", name: "?" };
	}
}

async function main() {
	if (process.env.NODE_ENV === "production") {
		console.error("NODE_ENV is production: the seed never runs there.");
		return 2;
	}
	const db = databaseOf(process.env.DATABASE_URL || "");
	const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(db.host);

	const existing = await prisma.user.count();
	if (existing > 0) {
		if (!args.has("--wipe")) {
			console.error(`The database "${db.name}" already has ${existing} user(s).`);
			console.error("To erase everything in it and start over:  npm run db:seed -- --wipe");
			return 2;
		}
		if (!local && !args.has("--allow-remote")) {
			console.error(`The database is on "${db.host}", not this computer. --wipe refuses (add --allow-remote if that is really meant).`);
			return 2;
		}
		const { removed, files } = await wipe();
		const rows = Object.values(removed).reduce((a, b) => a + b, 0);
		console.log(`✓ emptied "${db.name}": ${rows} rows (${removed.user} users, ${removed.message} messages), ${files} picture file(s)`);
	}

	const s = await seed();
	console.log(`✓ ${s.users} people, ${s.contacts} contact rows, ${s.conversations} chats, ${s.messages} messages`);
	if (s.photos.added.length) console.log(`✓ pictures: ${s.photos.added.join(", ")}`);
	if (s.photos.missing.length) {
		if (s.sharpMissing) console.log("! sharp could not be loaded: no pictures were added");
		const files = s.photos.missing.map((n) => `${n}.jpg`).join(", ");
		console.log(`· no picture yet for ${s.photos.missing.length} people. Put these in prisma/seed/avatars/ and run again (with --wipe):\n  ${files}`);
	}
	console.log(`\nSign in as "${MAIN}" with the password "${PASSWORD}" (everyone else: same password):`);
	console.log(`  ${people.map((p) => p.username).join(", ")}`);
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e) => {
		console.error("seed failed:", e?.message || e);
		console.error("(anything written so far stays: fix the cause, then run it again with --wipe)");
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
