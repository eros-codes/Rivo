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
	let files;
	try {
		files = await fs.promises.readdir(AVATAR_DIR);
	} catch {
		return;
	}
	for (const f of files) {
		if (f.startsWith(`av-${userId}-`) && f !== keep) await fs.promises.unlink(path.join(AVATAR_DIR, f)).catch(() => {});
	}
}

const NOT_AN_IMAGE = "NOT_AN_IMAGE";

// The upload is kept in memory (at most 5 MB, and it costs from the action
// budget), never as a file: an unprocessed picture (with its location data)
// never sits in the public folder, and there is no temporary file to clean up
// (on Windows one can stay locked by the image decoder for a while).
const upload = multer({
	storage: multer.memoryStorage(),
	// one file and no other field. (Not `parts`: busboy reports that limit as
	// soon as the count is reached, so `parts: 1` refused every upload; files
	// and fields bound the parts anyway.)
	limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
	fileFilter: (_req, file, cb) => (String(file.mimetype).startsWith("image/") ? cb(null, true) : cb(new Error(NOT_AN_IMAGE))),
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
	upload.single("avatar")(req, res, (err: unknown) => {
		if (!err) return next();
		const code = (err as { code?: unknown }).code;
		const message = (err as { message?: unknown }).message;
		if (code === "LIMIT_FILE_SIZE") return void res.status(413).json({ error: "Image is too large (max 5 MB)" });
		if (message === NOT_AN_IMAGE) return void res.status(400).json({ error: "Only images are allowed" });
		// more files, other fields, another field name
		if (typeof code === "string" && code.startsWith("LIMIT_")) return void res.status(400).json({ error: 'Send one picture, as the field "avatar"' });
		// not readable as a form (cut off, no boundary)
		return void res.status(400).json({ error: "Malformed upload" });
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
	const input = req.file?.buffer;
	if (!input) return void res.status(400).json({ error: "No file uploaded" });
	try {
		// trust the bytes and the decoder, never the declared type
		if (!MAGIC.some((ok) => ok(input))) return void res.status(400).json({ error: "Invalid image file" });
		const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
		if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) return void res.status(400).json({ error: "Image is too large" });
		if (!["jpeg", "png", "gif", "webp"].includes(String(meta.format || "").toLowerCase())) return void res.status(400).json({ error: "Invalid image file" });
	} catch {
		return void res.status(400).json({ error: "Invalid image file" });
	}

	// re-encoded as JPEG: strips metadata (location!) and bounds the size.
	// Written under its final name at once (no rename): nobody knows the name
	// before this answer, so a half-written file is never asked for.
	const outName = `av-${req.userId}-${crypto.randomBytes(12).toString("hex")}.jpg`;
	const outPath = path.join(AVATAR_DIR, outName);
	try {
		await fs.promises.mkdir(AVATAR_DIR, { recursive: true });
		await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).autoOrient().resize({ width: 1024, height: 1024, fit: "inside" }).jpeg({ quality: 80 }).toFile(outPath);
		const url = `${AVATAR_URL_PREFIX}${outName}`;
		await prisma.user.update({ where: { id: req.userId }, data: { profilePics: [url] } });
		await removeAvatarFiles(req.userId, outName);
		await broadcastUserUpdate(req.userId);
		return void reply(res, "POST /api/users/me/avatar", { url });
	} catch (e) {
		log.error("avatar processing failed", e);
		await fs.promises.unlink(outPath).catch(() => {});
		return void res.status(500).json({ error: "Failed to process image" });
	}
});

export default router;
