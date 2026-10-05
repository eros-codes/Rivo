// Shows what the integrity migration (20261007090000_integrity_constraints)
// would clean up in this database. It changes nothing: run it before
// `npx prisma migrate deploy` on a database with real data.
//
//   npm run db:check
import "../env.ts";
import prisma from "../prisma.ts";
import { messageOf } from "../utils/errors.ts";

interface DoubleMember {
	conversationId: number;
	userId: number;
	copies: number;
}
interface ExtraSaved {
	ownerId: number;
	rows: number;
	messagesToMove: number;
}
interface DoubleContact {
	ownerId: number;
	contactId: number;
	rows: number;
	chats: number;
}

async function main(): Promise<void> {
	const members = await prisma.$queryRawUnsafe<DoubleMember[]>(`
		SELECT "conversationId", "userId", count(*)::int AS "copies"
		FROM "ConversationMember" GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2`);
	const saved = await prisma.$queryRawUnsafe<ExtraSaved[]>(`
		SELECT c."ownerId", count(DISTINCT c."id")::int AS "rows", count(m."id")::int AS "messagesToMove"
		FROM "Contact" c
		LEFT JOIN "Message" m
		  ON m."conversationId" = c."conversationId"
		 AND c."id" <> (SELECT min(x."id") FROM "Contact" x WHERE x."ownerId" = c."ownerId" AND x."isSaved")
		WHERE c."isSaved"
		GROUP BY 1 HAVING count(DISTINCT c."id") > 1 ORDER BY 1`);
	const contacts = await prisma.$queryRawUnsafe<DoubleContact[]>(`
		SELECT "ownerId", "contactId", count(*)::int AS "rows", count(DISTINCT "conversationId")::int AS "chats"
		FROM "Contact" WHERE NOT "isSaved"
		GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2`);

	console.log("Integrity check (nothing is changed)\n");
	console.log(`Chat members listed twice:          ${members.length}`);
	for (const r of members) console.log(`  chat ${r.conversationId}: user ${r.userId} × ${r.copies}  → the extra copies are removed`);
	console.log(`Users with more than one Saved Messages: ${saved.length}`);
	for (const r of saved) console.log(`  user ${r.ownerId}: ${r.rows} rows → merged into the oldest (${r.messagesToMove} messages move, none deleted)`);
	console.log(`People listed twice in someone's list:  ${contacts.length}`);
	for (const r of contacts) {
		const note = r.chats > 1 ? `${r.chats} different chats: the most recently used one stays in the list (the other chat's messages stay on the server)` : "same chat: the extra row is removed";
		console.log(`  owner ${r.ownerId}, person ${r.contactId}: ${r.rows} rows → ${note}`);
	}
	const total = members.length + saved.length + contacts.length;
	console.log(total === 0 ? "\nNothing to clean up: the migration only adds the constraints." : `\n${total} item(s) above will be cleaned up by the migration.`);
}

main()
	.catch((e: unknown) => {
		console.error("check failed:", messageOf(e) ?? e);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
