// Finding users by what people type. Usernames and emails are compared
// without regard to letter case ("Arvin" and "arvin" are the same person),
// preferring an exact match for accounts created before this rule existed.
import prisma from "../prisma.js";

export function normalizeEmail(email) {
	return String(email || "").toLowerCase().trim();
}

export function normalizeUsername(username) {
	return String(username || "").trim().replace(/^@/, "");
}

export async function findUserByUsername(username, where = {}) {
	const u = normalizeUsername(username);
	if (!u) return null;
	const exact = await prisma.user.findFirst({ where: { ...where, username: u } });
	if (exact) return exact;
	return prisma.user.findFirst({ where: { ...where, username: { equals: u, mode: "insensitive" } } });
}

export async function findUserByEmail(email, where = {}) {
	const e = normalizeEmail(email);
	if (!e) return null;
	const exact = await prisma.user.findFirst({ where: { ...where, email: e } });
	if (exact) return exact;
	return prisma.user.findFirst({ where: { ...where, email: { equals: e, mode: "insensitive" } } });
}

/** Email when it contains "@", username otherwise (usernames cannot contain "@"). */
export async function findUserByIdentifier(identifier, where = {}) {
	const raw = String(identifier || "").trim();
	if (!raw) return null;
	return /@/.test(raw) && !raw.startsWith("@") ? findUserByEmail(raw, where) : findUserByUsername(raw, where);
}

export async function isUsernameTaken(username, exceptUserId = null) {
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

export async function isEmailTaken(email) {
	const e = normalizeEmail(email);
	if (!e) return false;
	const found = await prisma.user.findFirst({ where: { email: { equals: e, mode: "insensitive" } }, select: { id: true } });
	return !!found;
}
