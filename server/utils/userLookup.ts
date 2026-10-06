// Finding users by what people type. Usernames and emails are compared
// without regard to letter case ("Arvin" and "arvin" are the same person),
// preferring an exact match for accounts created before this rule existed.
import prisma, { type Prisma } from "../prisma.ts";

export function normalizeEmail(email: unknown): string {
	return String(email || "").toLowerCase().trim();
}

export function normalizeUsername(username: unknown): string {
	return String(username || "").trim().replace(/^@/, "");
}

export async function findUserByUsername(username: unknown, where: Prisma.UserWhereInput = {}) {
	const u = normalizeUsername(username);
	if (!u) return null;
	const exact = await prisma.user.findFirst({ where: { ...where, username: u } });
	if (exact) return exact;
	return prisma.user.findFirst({ where: { ...where, username: { equals: u, mode: "insensitive" } } });
}

export async function findUserByEmail(email: unknown, where: Prisma.UserWhereInput = {}) {
	const e = normalizeEmail(email);
	if (!e) return null;
	const exact = await prisma.user.findFirst({ where: { ...where, email: e } });
	if (exact) return exact;
	return prisma.user.findFirst({ where: { ...where, email: { equals: e, mode: "insensitive" } } });
}

/** Email when it contains "@", username otherwise (usernames cannot contain "@"). */
export async function findUserByIdentifier(identifier: unknown, where: Prisma.UserWhereInput = {}) {
	const raw = String(identifier || "").trim();
	if (!raw) return null;
	return /@/.test(raw) && !raw.startsWith("@") ? findUserByEmail(raw, where) : findUserByUsername(raw, where);
}

export async function isUsernameTaken(username: unknown, exceptUserId: number | null = null): Promise<boolean> {
	const u = normalizeUsername(username);
	if (!u) return false;
	const found = await prisma.user.findFirst({
		where: {
			username: { equals: u, mode: "insensitive" },
			...(exceptUserId ? { NOT: { id: exceptUserId } } : {}),
		},
		select: { id: true },
	});
	return !!found;
}

export async function isEmailTaken(email: unknown): Promise<boolean> {
	const e = normalizeEmail(email);
	if (!e) return false;
	const found = await prisma.user.findFirst({ where: { email: { equals: e, mode: "insensitive" } }, select: { id: true } });
	return !!found;
}
