import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { ChangePassword, DeleteAccount, SearchUsers, UpdateProfile } from "../../shared/schemas/account.ts";
import { parse } from "../http/validate.ts";
import { applyPrivacy, relationsFor } from "../utils/privacy.ts";
import { isUsernameTaken } from "../utils/userLookup.ts";
import { clearSessionCookies, revokeAllSessions, revokeOtherSessions } from "../auth/sessions.ts";
import { invalidateAll } from "../services/caches.ts";
import { broadcastPresence, broadcastUserUpdate } from "../services/presence.ts";
import { isOnline } from "../realtime/registry.ts";
import { DELETED as DELETED_MESSAGE } from "../services/messages.ts";
import { RATE_LIMITED, spendBudget } from "../services/actionLimit.ts";
import { log } from "../utils/logger.ts";
import { meOf } from "../utils/wire.ts";
import { codeOf } from "../utils/errors.ts";
import { reply } from "../http/reply.ts";

const router = Router();

// Avatars: /assets/images/user-profiles/av-<userId>-<random>.jpg. The random
// part keeps them from being guessed (they are public files) and a new name
// per upload means no stale browser cache.
const AVATAR_DIR = path.join(process.cwd(), "public", "assets", "images", "user-profiles");
const AVATAR_URL_PREFIX = "/assets/images/user-profiles/";
const LEGACY_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const ME_SELECT = {
	id: true,
	name: true,
	username: true,
	email: true,
	bio: true,
	profilePics: true,
	isOnline: true,
	lastSeen: true,
	privacyOnline: true,
	privacyEmail: true,
	privacyProfile: true,
	createdAt: true,
};

/** Removes a user's avatar files, except `keep`. */
async function removeAvatarFiles(userId: number, keep: string | null = null): Promise<void> {
	for (const ext of LEGACY_EXTS) {
		const name = `${userId}${ext}`;
		if (name !== keep) await fs.promises.unlink(path.join(AVATAR_DIR, name)).catch(() => {});
	}
	let files;
	try {
		files = await fs.promises.readdir(AVATAR_DIR);
	} catch {
		return;
	}
	const now = Date.now();
	for (const f of files) {
		const full = path.join(AVATAR_DIR, f);
		if (f.startsWith(`av-${userId}-`) && f !== keep) {
			await fs.promises.unlink(full).catch(() => {});
		} else if (f.startsWith(`up-${userId}-`)) {
			// an upload left behind by a failed request
			const st = await fs.promises.stat(full).catch(() => null);
			if (st && now - st.mtimeMs > 60 * 60 * 1000) await fs.promises.unlink(full).catch(() => {});
		}
	}
}

const upload = multer({
	storage: multer.diskStorage({
		destination: (_req, _file, cb) => {
			fs.mkdir(AVATAR_DIR, { recursive: true }, () => cb(null, AVATAR_DIR));
		},
		// a temporary name; the stored avatar is re-encoded under its own name
		filename: (req, _file, cb) => cb(null, `up-${req.userId}-${crypto.randomBytes(8).toString("hex")}.tmp`),
	}),
	// one file and nothing else (no other fields piling up in memory)
	limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
	fileFilter: (_req, file, cb) => (String(file.mimetype).startsWith("image/") ? cb(null, true) : cb(new Error("Only images allowed"))),
});

// ─── Current user ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
	try {
		const user = await prisma.user.findUnique({ where: { id: req.userId }, select: ME_SELECT });
		if (!user) return void res.status(404).json({ error: "User not found" });
		return void reply(res, "GET /api/users/me", meOf(user));
	} catch (e) {
		log.error("GET /me failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.patch("/me", requireAuth, async (req, res) => {
	const body = parse(res, UpdateProfile, req.body);
	if (!body) return;
	// what was not sent is undefined, and Prisma leaves it as it is
	// (profilePics can only be []: uploads go through /me/avatar)
	const data: Prisma.UserUpdateInput = body;

	try {
		if (body.username && (await isUsernameTaken(body.username, req.userId))) return void res.status(409).json({ error: "Username already taken" });
		const before = await prisma.user.findUnique({ where: { id: req.userId }, select: ME_SELECT });
		let user;
		try {
			user = await prisma.user.update({ where: { id: req.userId }, data, select: ME_SELECT });
		} catch (e) {
			if (codeOf(e) === "P2002") return void res.status(409).json({ error: "Username already taken" });
			throw e;
		}
		if (body.profilePics) await removeAvatarFiles(req.userId);

		// (the account cannot be gone: it was just updated)
		if (!before) throw new Error("user not found");
		const profileChanged =
			before.name !== user.name ||
			before.username !== user.username ||
			(before.bio || "") !== (user.bio || "") ||
			before.profilePics.length !== user.profilePics.length ||
			before.privacyProfile !== user.privacyProfile ||
			before.privacyEmail !== user.privacyEmail;
		if (profileChanged) await broadcastUserUpdate(req.userId);
		if (before.privacyOnline !== user.privacyOnline) {
			await broadcastPresence(req.userId, { online: isOnline(req.userId), lastSeen: user.lastSeen, notifyHidden: true });
		}
		return void reply(res, "PATCH /api/users/me", meOf(user));
	} catch (e) {
		log.error("PATCH /me failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Search users by username ─────────────────────────────────────────────
router.get("/search", requireAuth, async (req, res) => {
	const query = parse(res, SearchUsers, req.query);
	if (!query) return;
	const { q } = query;
	try {
		const users = await prisma.user.findMany({
			where: { username: { contains: q, mode: "insensitive" }, isDeleted: false, NOT: { id: req.userId } },
			select: { id: true, name: true, username: true, profilePics: true, bio: true, privacyProfile: true },
			take: 10,
		});
		const rel = await relationsFor(req.userId, users.map((u) => u.id));
		return void reply(res, "GET /api/users/search", users.map((u) => applyPrivacy(u, rel.get(u.id))));
	} catch (e) {
		log.error("user search failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete account ───────────────────────────────────────────────────────
router.delete("/me", requireAuth, async (req, res) => {
	const body = parse(res, DeleteAccount, req.body);
	if (!body) return;
	const { password } = body;
	try {
		const user = await prisma.user.findUnique({ where: { id: req.userId } });
		if (!user) return void res.status(404).json({ error: "User not found" });
		// 403, not 401: a 401 means "signed out" to the client
		if (!(await bcrypt.compare(password, user.passwordHash))) return void res.status(403).json({ error: "Wrong password" });

		// The account is anonymised, not removed, so the other people keep
		// their conversations (shown as "Deleted account").
		const stamp = `${req.userId}_${Date.now()}`;
		// chats nobody else is in (Saved Messages) would stay readable on the
		// server with no one able to see them: their messages are wiped
		const alone = await prisma.conversation.findMany({
			where: { members: { some: { userId: req.userId }, every: { userId: req.userId } } },
			select: { id: true },
		});
		const hashed = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), config.bcryptRounds);
		await revokeAllSessions(req.userId);
		await prisma.$transaction([
			prisma.contact.deleteMany({ where: { ownerId: req.userId } }),
			prisma.contact.updateMany({ where: { contactId: req.userId }, data: { nickname: "Deleted account" } }),
			prisma.message.updateMany({ where: { conversationId: { in: alone.map((c) => c.id) }, isDeleted: false }, data: { ...DELETED_MESSAGE, updatedAt: new Date() } }),
			prisma.passwordResetToken.deleteMany({ where: { userId: req.userId } }),
			prisma.pushSubscription.deleteMany({ where: { userId: req.userId } }),
			prisma.user.update({
				where: { id: req.userId },
				data: {
					name: "Deleted account",
					username: `deleted_user_${stamp}`,
					email: `deleted_user_${stamp}@deleted.rivo`,
					passwordHash: hashed,
					passwordChangedAt: new Date(),
					bio: "",
					profilePics: [],
					isOnline: false,
					isDeleted: true,
				},
			}),
		]);
		invalidateAll();
		await removeAvatarFiles(req.userId);
		// the other people see "Deleted account" right away
		await broadcastUserUpdate(req.userId);
		clearSessionCookies(res);
		return void reply(res, "DELETE /api/users/me", { success: true });
	} catch (e) {
		log.error("account deletion failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Change password ──────────────────────────────────────────────────────
// This device stays signed in; every other device is signed out.
router.patch("/me/password", requireAuth, async (req, res) => {
	const body = parse(res, ChangePassword, req.body);
	if (!body) return;
	const { currentPassword, newPassword } = body;
	try {
		const user = await prisma.user.findUnique({ where: { id: req.userId } });
		if (!user) return void res.status(404).json({ error: "User not found" });
		if (!(await bcrypt.compare(currentPassword, user.passwordHash))) return void res.status(403).json({ error: "Wrong password" });
		const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
		await prisma.user.update({ where: { id: req.userId }, data: { passwordHash, passwordChangedAt: new Date() } });
		const signedOut = await revokeOtherSessions(req.userId, req.sessionId);
		// a reset link that is still in an inbox must not work anymore
		await prisma.passwordResetToken.deleteMany({ where: { userId: req.userId } });
		return void reply(res, "PATCH /api/users/me/password", { success: true, signedOut });
	} catch (e) {
		log.error("password change failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Avatar ───────────────────────────────────────────────────────────────
function receiveAvatar(req: Request, res: Response, next: NextFunction): void {
	upload.single("avatar")(req, res, (err) => {
		if (!err) return next();
		const tooBig = err.code === "LIMIT_FILE_SIZE";
		return void res.status(tooBig ? 413 : 400).json({ error: tooBig ? "Image is too large (max 5 MB)" : "Only images are allowed" });
	});
}

const MAGIC: ((b: Buffer) => boolean)[] = [
	(b) => b[0] === 0xff && b[1] === 0xd8,
	(b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
	(b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
	(b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
];

// a small file can still decode to a huge picture: anything over this many
// pixels is refused before it is decoded (the app itself uploads 400×400)
const MAX_INPUT_PIXELS = 25_000_000;

// decoding and re-encoding is real work: it comes out of the action budget
const avatarBudget: RequestHandler = (req, res, next) => (spendBudget(req.userId, 5) ? next() : void res.status(429).json(RATE_LIMITED));

router.post("/me/avatar", requireAuth, avatarBudget, receiveAvatar, async (req, res) => {
	if (!req.file) return void res.status(400).json({ error: "No file uploaded" });
	const tmp = req.file.path;
	const drop = () => fs.promises.unlink(tmp).catch(() => {});
	try {
		const head = Buffer.alloc(12);
		const fd = await fs.promises.open(tmp, "r");
		await fd.read(head, 0, 12, 0);
		await fd.close();
		// trust the bytes and the decoder, never the declared type
		if (!MAGIC.some((ok) => ok(head))) {
			await drop();
			return void res.status(400).json({ error: "Invalid image file" });
		}
		const meta = await sharp(tmp, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
		if (!meta?.width || !meta?.height || meta.width * meta.height > MAX_INPUT_PIXELS) {
			await drop();
			return void res.status(400).json({ error: "Image is too large" });
		}
		if (!["jpeg", "png", "gif", "webp"].includes(String(meta?.format || "").toLowerCase())) {
			await drop();
			return void res.status(400).json({ error: "Invalid image file" });
		}
	} catch {
		await drop();
		return void res.status(400).json({ error: "Invalid image file" });
	}

	// re-encoded as JPEG: strips metadata (location!) and bounds the size
	const outName = `av-${req.userId}-${crypto.randomBytes(12).toString("hex")}.jpg`;
	const outPath = path.join(AVATAR_DIR, outName);
	const partial = `${outPath}.part`;
	try {
		await sharp(tmp, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: 1024, height: 1024, fit: "inside" }).jpeg({ quality: 80 }).toFile(partial);
		await fs.promises.rename(partial, outPath);
		await drop();
		const url = `${AVATAR_URL_PREFIX}${outName}`;
		await prisma.user.update({ where: { id: req.userId }, data: { profilePics: [url] } });
		await removeAvatarFiles(req.userId, outName);
		await broadcastUserUpdate(req.userId);
		return void reply(res, "POST /api/users/me/avatar", { url });
	} catch (e) {
		log.error("avatar processing failed", e);
		await drop();
		await fs.promises.unlink(partial).catch(() => {});
		await fs.promises.unlink(outPath).catch(() => {});
		return void res.status(500).json({ error: "Failed to process image" });
	}
});

export default router;
