import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const OWNER = process.argv[2];
const COUNT = Number(process.argv[3]) || 12;

if (!OWNER) {
	console.error(
		"usage: node server/scripts/seed_test_contacts.js <your-username> [count]",
	);
	console.error("       node server/scripts/seed_test_contacts.js --clean");
	process.exit(1);
}

// ─── حالت پاک‌سازی ───────────────────────────────────────────────────────────
if (OWNER === "--clean") {
	const testUsers = await prisma.user.findMany({
		where: { username: { startsWith: "testuser" } },
		select: { id: true, username: true },
	});
	if (!testUsers.length) {
		console.log("هیچ کاربر تستی پیدا نشد.");
		await prisma.$disconnect();
		process.exit(0);
	}
	const ids = testUsers.map((u) => u.id);

	// ترتیب حذف مهم است: کلیدهای خارجی از پایین به بالا پاک می‌شوند
	const convIds = (
		await prisma.conversationMember.findMany({
			where: { userId: { in: ids } },
			select: { conversationId: true },
		})
	).map((m) => m.conversationId);

	await prisma.messageReaction.deleteMany({ where: { userId: { in: ids } } });
	await prisma.message.deleteMany({
		where: { conversationId: { in: convIds } },
	});
	await prisma.contact.deleteMany({
		where: { OR: [{ ownerId: { in: ids } }, { contactId: { in: ids } }] },
	});
	await prisma.conversationMember.deleteMany({
		where: { conversationId: { in: convIds } },
	});
	await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
	await prisma.pushSubscription.deleteMany({
		where: { userId: { in: ids } },
	});
	await prisma.passwordResetToken.deleteMany({
		where: { userId: { in: ids } },
	});
	await prisma.user.deleteMany({ where: { id: { in: ids } } });

	console.log(`✓ ${testUsers.length} کاربر تستی و داده‌هایشان حذف شدند.`);
	await prisma.$disconnect();
	process.exit(0);
}

// ─── حالت ساخت ───────────────────────────────────────────────────────────────
const owner = await prisma.user.findUnique({ where: { username: OWNER } });
if (!owner) {
	console.error(`کاربری با نام «${OWNER}» پیدا نشد.`);
	await prisma.$disconnect();
	process.exit(1);
}

const passwordHash = await bcrypt.hash("TestPass123", 10);
let created = 0;

for (let i = 1; i <= COUNT; i++) {
	const username = `testuser${i}`;

	let user = await prisma.user.findUnique({ where: { username } });
	if (!user) {
		user = await prisma.user.create({
			data: {
				username,
				name: `Test User ${i}`,
				email: `${username}@test.local`,
				passwordHash,
			},
		});
	}

	// قرارداد پروژه: شناسه‌های مرتب‌شده، برای تضمین یک گفتگو به‌ازای هر جفت
	const key = [owner.id, user.id].sort((a, b) => a - b).join(":");
	let conv = await prisma.conversation.findUnique({
		where: { participantsKey: key },
	});
	if (!conv) {
		conv = await prisma.conversation.create({
			data: {
				participantsKey: key,
				members: {
					create: [{ userId: owner.id }, { userId: user.id }],
				},
			},
		});
	}

	// Contact قید یکتا ندارد، پس دستی بررسی می‌شود تا تکراری ساخته نشود
	const existing = await prisma.contact.findFirst({
		where: { ownerId: owner.id, contactId: user.id },
	});
	if (!existing) {
		await prisma.contact.create({
			data: {
				ownerId: owner.id,
				contactId: user.id,
				conversationId: conv.id,
				// این مقادیر باعث می‌شوند مخاطب در بخش Contacts بیفتد نه Active Chats
				isPinned: false,
				unreadCount: 0,
			},
		});
		created++;
	}
	console.log(`  ${username}`);
}

console.log(
	`\n✓ ${created} مخاطب جدید به «${OWNER}» اضافه شد (از ${COUNT} درخواست‌شده).`,
);
console.log("برای حذفشان:  node server/scripts/seed_test_contacts.js --clean");
await prisma.$disconnect();
