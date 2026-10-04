import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import push from "../utils/push.js";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
	userSockets,
	broadcastUserUpdate,
	broadcastPresence,
	disconnectUserSockets,
	invalidateAllCaches,
} from "../socket/index.js";
import { applyPrivacy, relationsFor } from "../utils/privacy.js";
import { isUsernameTaken } from "../utils/userLookup.js";

import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";

const router = Router();
// Consistent bcrypt rounds across codepaths
const DEFAULT_BCRYPT_ROUNDS = process.env.NODE_ENV === 'production' ? 12 : 10;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || DEFAULT_BCRYPT_ROUNDS);
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const PRIVACY_VALUES = new Set(['everyone', 'contacts', 'nobody']);
const MAX_PASSWORD_LENGTH = 128;

// Avatars: /assets/images/user-profiles/av-<userId>-<random>.jpg
// The random part keeps pictures from being guessed by user id (they are
// served publicly), and a new name per upload means no stale browser cache.
const AVATAR_DIR = path.join(process.cwd(), "public", "assets", "images", "user-profiles");
const AVATAR_URL_PREFIX = "/assets/images/user-profiles/";
const LEGACY_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

const AVATAR_DEBUG = ["1", "true", "yes"].includes(String(process.env.AVATAR_DEBUG || "").toLowerCase());

/** Removes a user's avatar files, except `keepFileName`. */
async function removeAvatarFiles(userId, keepFileName = null) {
	// files from before random names: <userId>.<ext>
	for (const ext of LEGACY_AVATAR_EXTS) {
		const name = `${userId}${ext}`;
		if (name === keepFileName) continue;
		try {
			await fs.promises.unlink(path.join(AVATAR_DIR, name));
		} catch (e) {
			if (e.code && e.code !== "ENOENT") console.error(e);
		}
	}
	let files = [];
	try {
		files = await fs.promises.readdir(AVATAR_DIR);
	} catch (e) {
		return;
	}
	const prefix = `av-${userId}-`;
	for (const f of files) {
		if (!f.startsWith(prefix) || f === keepFileName) continue;
		try {
			await fs.promises.unlink(path.join(AVATAR_DIR, f));
		} catch (e) {
			if (e.code && e.code !== "ENOENT") console.error(e);
		}
	}
}

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		try {
			if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
		} catch (e) {
			// ignore mkdir failures; multer will surface errors
		}
		cb(null, AVATAR_DIR);
	},
	filename: (req, file, cb) => {
		// Preserve reasonable extension based on mimetype or original name
		const mimeMap = {
			'image/jpeg': '.jpg',
			'image/jpg': '.jpg',
			'image/png': '.png',
			'image/gif': '.gif',
			'image/webp': '.webp',
		};
		let ext = mimeMap[file.mimetype] || path.extname(file.originalname) || '.jpg';
		ext = ext.startsWith('.') ? ext : `.${ext}`;
		// Unique temporary filename; the final avatar gets its own name below
		const unique = `${req.userId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
		cb(null, unique);
	},
});
const upload = multer({
	storage,
	limits: { fileSize: 5 * 1024 * 1024 },
	fileFilter: (req, file, cb) => {
		if (file.mimetype.startsWith("image/")) cb(null, true);
		else cb(new Error("Only images allowed"));
	},
});

// ─── Get current user ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
	try {
		const user = await prisma.user.findUnique({
			where: { id: req.userId },
			select: {
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
			},
		});

		if (!user) return res.status(404).json({ error: "User not found" });

		return res.json(user);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Update current user ──────────────────────────────────────────────────────
router.patch("/me", requireAuth, async (req, res) => {
	const { name, username, bio, profilePics, privacyOnline, privacyEmail, privacyProfile } = req.body || {};
	const normalizedUsername = typeof username === 'string' ? username.trim() : undefined;
	const normalizedName = typeof name === 'string' ? name.trim() : undefined;
	const normalizedBio = typeof bio === 'string' ? bio.trim() : bio;

	// Validate lengths to prevent stored-DoS via large fields
	if (name !== undefined) {
		if (typeof name !== 'string' || normalizedName.length === 0 || normalizedName.length > 100) {
			return res.status(400).json({ error: 'Name must be between 1 and 100 characters' });
		}
	}
	if (username !== undefined) {
		if (typeof username !== 'string' || !USERNAME_RE.test(normalizedUsername)) {
			return res.status(400).json({ error: 'Username must be 3-30 alphanumeric characters or underscore' });
		}
	}
	if (bio !== undefined && bio !== null) {
		if (typeof bio !== 'string' || normalizedBio.length > 300) {
			return res.status(400).json({ error: 'Bio must be 300 characters or fewer' });
		}
	}
	for (const [key, value] of [
		['privacyOnline', privacyOnline],
		['privacyEmail', privacyEmail],
		['privacyProfile', privacyProfile],
	]) {
		if (value !== undefined && !PRIVACY_VALUES.has(value)) {
			return res.status(400).json({ error: `Invalid value for ${key}` });
		}
	}
	// Only clearing the picture is allowed here; uploads go through /me/avatar
	const clearPics = Array.isArray(profilePics) && profilePics.length === 0;

	try {
		if (normalizedUsername && (await isUsernameTaken(normalizedUsername, req.userId))) {
			return res.status(409).json({ error: "Username already taken" });
		}

		const before = await prisma.user.findUnique({
			where: { id: req.userId },
			select: { privacyOnline: true, privacyProfile: true },
		});

		const dataToUpdate = {
			...(normalizedName !== undefined && { name: normalizedName }),
			...(normalizedUsername !== undefined && { username: normalizedUsername }),
			...(bio !== undefined && { bio: bio === null ? "" : normalizedBio }),
			...(privacyOnline !== undefined && { privacyOnline }),
			...(privacyEmail !== undefined && { privacyEmail }),
			...(privacyProfile !== undefined && { privacyProfile }),
			...(clearPics && { profilePics: [] }),
		};

		let user;
		try {
			user = await prisma.user.update({
				where: { id: req.userId },
				data: dataToUpdate,
				select: {
					id: true,
					name: true,
					username: true,
					email: true,
					bio: true,
					profilePics: true,
					privacyOnline: true,
					privacyEmail: true,
					privacyProfile: true,
				},
			});
		} catch (e) {
			// two people picked the same username at the same moment
			if (e && e.code === "P2002") return res.status(409).json({ error: "Username already taken" });
			throw e;
		}

		if (clearPics) await removeAvatarFiles(req.userId);

		// Let contacts see the change right away (each according to the
		// picture privacy setting), and this user's other devices too.
		const profileChanged =
			normalizedName !== undefined ||
			normalizedUsername !== undefined ||
			bio !== undefined ||
			clearPics ||
			(before && before.privacyProfile !== user.privacyProfile);
		if (profileChanged) await broadcastUserUpdate(req.userId);
		if (before && before.privacyOnline !== user.privacyOnline) {
			const online = userSockets.has(req.userId) && userSockets.get(req.userId).size > 0;
			await broadcastPresence(req.userId, { online, lastSeen: null, notifyHidden: true });
		}

		return res.json(user);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Search users by username ─────────────────────────────────────────────────
router.get("/search", requireAuth, async (req, res) => {
	const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

	if (!q || q.length < 2) {
		return res.status(400).json({ error: "Query too short" });
	}
	if (q.length > 50) {
		return res.status(400).json({ error: 'Query too long' });
	}

	try {
		const users = await prisma.user.findMany({
			where: {
				username: {
					contains: q,
					mode: "insensitive",
				},
				isDeleted: false,
				NOT: { id: req.userId },
			},
			select: {
				id: true,
				name: true,
				username: true,
				profilePics: true,
				bio: true,
				privacyProfile: true,
			},
			take: 10,
		});

		const rel = await relationsFor(req.userId, users.map((u) => u.id));
		return res.json(users.map((u) => applyPrivacy(u, rel.get(u.id))));
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete account ───────────────────────────────────────────────────────────
router.delete("/me", requireAuth, async (req, res) => {
	const { password } = req.body || {};
	if (typeof password !== "string" || !password) {
		return res.status(400).json({ error: "Password is required" });
	}

	try {
		const user = await prisma.user.findUnique({
			where: { id: req.userId },
		});

		if (!user) return res.status(404).json({ error: "User not found" });

		const match = await bcrypt.compare(password, user.passwordHash);
		// 403, not 401: the client treats 401 as "session expired" and logs the
		// user out, so a mistyped password used to sign them out.
		if (!match) return res.status(403).json({ error: "Wrong password" });

		// Anonymize user instead of hard-deleting so conversations/messages remain.
		// This preserves conversation history for other participants while removing personal data.
		const now = Date.now();
		const anonUsername = `deleted_user_${req.userId}_${now}`;
		const anonEmail = `deleted_user_${req.userId}_${now}@deleted.rivo`;
		const randomSecret = crypto.randomBytes(32).toString('hex');
		const hashed = await bcrypt.hash(randomSecret, BCRYPT_ROUNDS);

		// Delete push subscriptions separately so a missing DB table won't
		// cause the whole transaction to fail.
		try {
			await prisma.pushSubscription.deleteMany({ where: { userId: req.userId } });
		} catch (e) {
			// If the PushSubscription table doesn't exist in the DB (common when
			// migrations are out-of-sync), log and continue. Re-throw unexpected errors.
			const missingTable = e && (e.code === 'P2010' || e.code === 'P2021' || e.code === '42P01' || (e.message && e.message.includes('relation "PushSubscription" does not exist')));
			if (missingTable) {
				console.warn(`PushSubscription table missing; skipping deletion for user ${req.userId}`);
			} else {
				throw e;
			}
		}

		await prisma.$transaction([
			prisma.contact.deleteMany({ where: { ownerId: req.userId } }),
			prisma.contact.updateMany({ where: { contactId: req.userId }, data: { nickname: 'Deleted account' } }),
			prisma.passwordResetToken.deleteMany({ where: { userId: req.userId } }),
			prisma.user.update({
				where: { id: req.userId },
				data: {
					name: 'Deleted account',
					username: anonUsername,
					email: anonEmail,
					passwordHash: hashed,
					passwordChangedAt: new Date(),
					bio: '',
					profilePics: [],
					isOnline: false,
					isDeleted: true,
				},
			}),
		]);

		invalidateAllCaches();

		// Cleanup user avatar files from disk (best-effort)
		await removeAvatarFiles(req.userId);

		// Contacts see "Deleted account" right away; every session ends.
		await broadcastUserUpdate(req.userId);
		disconnectUserSockets(req.userId);

		// Clear auth cookies so client state is reset
		try { res.clearCookie('token'); res.clearCookie('csrfToken'); } catch (e) { /* ignore */ }

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Change password ─────────────────────────────────────────────────────────
router.patch("/me/password", requireAuth, async (req, res) => {
	const { currentPassword, newPassword } = req.body || {};
	if (typeof currentPassword !== "string" || !currentPassword || typeof newPassword !== "string" || !newPassword) {
		return res.status(400).json({ error: "Missing fields" });
	}
	if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
	if (newPassword.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: "New password is too long" });

	try {
		const user = await prisma.user.findUnique({ where: { id: req.userId } });
		if (!user) return res.status(404).json({ error: "User not found" });

		const match = await bcrypt.compare(currentPassword, user.passwordHash);
		// 403, not 401: a 401 makes the client log the user out (see delete above)
		if (!match) return res.status(403).json({ error: "Wrong password" });

		const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
		const updated = await prisma.user.update({ where: { id: req.userId }, data: { passwordHash: hashed, passwordChangedAt: new Date() } });

		const token = jwt.sign({ userId: updated.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
		res.cookie("token", token, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			maxAge: 7 * 24 * 60 * 60 * 1000,
		});

		// Old sessions on other devices end now, not on their next request,
		// and their notifications stop (a signed-out phone must not keep
		// showing messages; a browser subscribes again when it signs in)
		const own = typeof req.get("x-socket-id") === "string" ? req.get("x-socket-id") : null;
		disconnectUserSockets(req.userId, { exceptSocketId: own });
		await push.removeAllSubscriptions(req.userId);

		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Upload avatar ────────────────────────────────────────────────────────────
function receiveAvatar(req, res, next) {
	upload.single("avatar")(req, res, (err) => {
		if (!err) return next();
		const tooBig = err && err.code === "LIMIT_FILE_SIZE";
		return res.status(tooBig ? 413 : 400).json({ error: tooBig ? "Image is too large (max 5 MB)" : "Only images are allowed" });
	});
}

router.post("/me/avatar", requireAuth, receiveAvatar, async (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: "No file uploaded" });
	}

	// Validate magic bytes (first 12 bytes) to ensure uploaded file is an image
	const filePath = req.file.path;
	try {
		const buf = Buffer.alloc(12);
		const fd = fs.openSync(filePath, 'r');
		fs.readSync(fd, buf, 0, 12, 0);
		fs.closeSync(fd);

		const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
		const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
		const isGif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
		const isWebp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';

		if (!isJpeg && !isPng && !isGif && !isWebp) {
			try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
			return res.status(400).json({ error: "Invalid image file" });
		}
	} catch (e) {
		try { fs.unlinkSync(filePath); } catch (er) { /* ignore */ }
		return res.status(400).json({ error: "Invalid image file" });
	}

	// Additionally verify image format using Sharp metadata to avoid
	// trusting client-supplied mimetypes.
	try {
		const meta = await sharp(filePath).metadata();
		const fmt = (meta && meta.format) ? String(meta.format).toLowerCase() : null;
		const allowed = new Set(['jpeg', 'png', 'gif', 'webp']);
		if (!fmt || !allowed.has(fmt)) {
			try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
			return res.status(400).json({ error: 'Invalid image file' });
		}
	} catch (e) {
		try { fs.unlinkSync(filePath); } catch (er) { /* ignore */ }
		return res.status(400).json({ error: 'Invalid image file' });
	}

	// Re-encode image to a canonical JPEG to strip metadata and limit size
	const outName = `av-${req.userId}-${crypto.randomBytes(12).toString('hex')}.jpg`;
	const outPath = path.join(AVATAR_DIR, outName);
	const url = `${AVATAR_URL_PREFIX}${outName}`;

	let tempOut = null;
	try {
		tempOut = outPath + '.tmp-' + Date.now();
		if (AVATAR_DEBUG) {
			console.debug('avatar processing paths', { filePath, outPath, tempOut });
		}
		await sharp(filePath)
			.rotate()
			.resize({ width: 1024, height: 1024, fit: 'inside' })
			.jpeg({ quality: 80 })
			.toFile(tempOut);

		await fs.promises.rename(tempOut, outPath);
		tempOut = null;

		// Remove the original upload
		try { await fs.promises.unlink(filePath); } catch (e) { /* ignore */ }

		await prisma.user.update({
			where: { id: req.userId },
			data: { profilePics: [url] },
		});

		// Older pictures of this user are no longer needed
		await removeAvatarFiles(req.userId, outName);

		// Remove abandoned temporary uploads (older than an hour)
		try {
			const now = Date.now();
			const files = await fs.promises.readdir(AVATAR_DIR);
			for (const f of files) {
				if (!f.startsWith(`${req.userId}-`) && !f.includes('.tmp-')) continue;
				const full = path.join(AVATAR_DIR, f);
				const st = await fs.promises.stat(full).catch(() => null);
				if (st && now - st.mtimeMs > 60 * 60 * 1000) {
					await fs.promises.unlink(full).catch(() => {});
				}
			}
		} catch (e) {
			/* best-effort cleanup */
		}

		// Contacts see the new picture right away (subject to privacy)
		await broadcastUserUpdate(req.userId);

		return res.json({ url });
	} catch (err) {
		console.error('avatar processing failed', err);
		try { if (tempOut) await fs.promises.unlink(tempOut); } catch (er) { /* ignore */ }
		try { await fs.promises.unlink(filePath); } catch (e) { /* ignore */ }
		try { await fs.promises.unlink(outPath); } catch (e) { /* ignore */ }
		return res.status(500).json({ error: "Failed to process image" });
	}
});

export default router;
