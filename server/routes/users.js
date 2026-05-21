import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import push from "../utils/push.js";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";

const router = Router();
// Consistent bcrypt rounds across codepaths
const DEFAULT_BCRYPT_ROUNDS = process.env.NODE_ENV === 'production' ? 12 : 10;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || DEFAULT_BCRYPT_ROUNDS);
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const dir = path.join(process.cwd(), "public", "assets", "images", "user-profiles");
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		} catch (e) {
			// ignore mkdir failures; multer will surface errors
		}
		cb(null, dir);
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
		// Use a unique temporary filename to avoid clashes with final avatar filename
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
	const { name, username, bio, profilePics, privacyOnline, privacyEmail, privacyProfile } = req.body;

	try {
		if (username) {
			const existing = await prisma.user.findFirst({
				where: {
					username,
					NOT: { id: req.userId },
				},
			});
			if (existing) {
				return res
					.status(409)
					.json({ error: "Username already taken" });
			}
		}

		// Only allow clearing profilePics via an explicit empty array.
		// Do not accept arbitrary client-supplied `profilePics` values.
		if (profilePics !== undefined && Array.isArray(profilePics) && profilePics.length === 0) {
				// Remove any avatar file for this user regardless of extension
				const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
				for (const e of exts) {
					const avatarPath = path.join(
						process.cwd(),
						"public",
						"assets",
						"images",
						"user-profiles",
						`${req.userId}${e}`,
					);
					try {
						await fs.promises.unlink(avatarPath);
					} catch (e) {
						if (e.code && e.code !== "ENOENT") console.error(e);
					}
				}
			}

		const dataToUpdate = {
			...(name && { name }),
			...(username && { username }),
			...(bio !== undefined && { bio }),
			...(privacyOnline !== undefined && { privacyOnline }),
			...(privacyEmail !== undefined && { privacyEmail }),
			...(privacyProfile !== undefined && { privacyProfile }),
		};

		// if client explicitly cleared profilePics, set it to an empty array
		if (profilePics !== undefined && Array.isArray(profilePics) && profilePics.length === 0) {
			dataToUpdate.profilePics = [];
		}

		const user = await prisma.user.update({
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

		// Broadcast profile update when relevant (e.g., avatar cleared)
		try {
			if (globalThis.__rivo_io) globalThis.__rivo_io.emit('user:updated', { id: user.id, name: user.name, username: user.username, profilePics: user.profilePics });
		} catch (e) {
			/* ignore broadcast failures */
		}

		return res.json(user);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Search users by username ─────────────────────────────────────────────────
router.get("/search", requireAuth, async (req, res) => {
	const { q } = req.query;

	if (!q || q.trim().length < 2) {
		return res.status(400).json({ error: "Query too short" });
	}

	try {
		const users = await prisma.user.findMany({
			where: {
				username: {
					contains: q.trim(),
					mode: "insensitive",
				},
				NOT: { id: req.userId },
			},
			select: {
				id: true,
				name: true,
				username: true,
				profilePics: true,
				bio: true,
			},
			take: 10,
		});

		return res.json(users);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Delete account ───────────────────────────────────────────────────────────
router.delete("/me", requireAuth, async (req, res) => {
	const { password } = req.body;

	try {
		console.info(`delete-account: request for userId=${req.userId}`);
		const user = await prisma.user.findUnique({
			where: { id: req.userId },
		});

		if (!user) return res.status(404).json({ error: "User not found" });
		console.info(`delete-account: user found id=${user.id}, username=${user.username}`);

		const match = await bcrypt.compare(password, user.passwordHash);
		console.info(`delete-account: password compare result=${match}`);
		if (!match) return res.status(401).json({ error: "Wrong password" });

		// Anonymize user instead of hard-deleting so conversations/messages remain.
		// This preserves conversation history for other participants while removing personal data.
		// Precompute anonymized fields and hashed secret, then perform an array-based
		// transaction which is compatible across Prisma client versions.
		const now = Date.now();
		const anonUsername = `deleted_user_${req.userId}_${now}`;
		const anonEmail = `deleted_user_${req.userId}_${now}@deleted.rivo`;
		const randomSecret = crypto.randomBytes(32).toString('hex');
		console.info('delete-account: hashing random secret');
		const hashed = await bcrypt.hash(randomSecret, BCRYPT_ROUNDS);
		console.info('delete-account: hashing complete');

		// Build operations. Delete push subscriptions separately so a missing
		// DB table won't cause the whole transaction to fail.
		const ops = [];

		try {
			if (prisma.pushSubscription && typeof prisma.pushSubscription.deleteMany === 'function') {
				await prisma.pushSubscription.deleteMany({ where: { userId: req.userId } });
			}
		} catch (e) {
			// If the PushSubscription table doesn't exist in the DB (common when
			// migrations are out-of-sync), log and continue. Re-throw unexpected errors.
			const missingTable = e && (e.code === 'P2010' || e.code === '42P01' || (e.message && e.message.includes('relation "PushSubscription" does not exist')));
			if (missingTable) {
				console.warn(`PushSubscription table missing; skipping deletion for user ${req.userId}`);
			} else {
				throw e;
			}
		}

		ops.push(prisma.contact.deleteMany({ where: { ownerId: req.userId } }));
		ops.push(prisma.contact.updateMany({ where: { contactId: req.userId }, data: { nickname: 'Deleted account' } }));
		ops.push(prisma.user.update({ where: { id: req.userId }, data: { name: 'Deleted account', username: anonUsername, email: anonEmail, passwordHash: hashed, passwordChangedAt: new Date(), bio: '', profilePics: [], isOnline: false } }));

		console.info(`delete-account: executing transaction with ops=${ops.length}`);
		await prisma.$transaction(ops);
		console.info('delete-account: transaction complete');

		// Remove in-memory push subscriptions and other ephemeral state
		try { push.removeAllSubscriptions(req.userId); } catch (e) { /* ignore */ }

		// Cleanup user avatar files from disk (best-effort)
		try {
			const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
			for (const e of exts) {
				const pth = path.join(process.cwd(), 'public', 'assets', 'images', 'user-profiles', `${req.userId}${e}`);
				try { await fs.promises.unlink(pth); } catch (e) { if (e.code && e.code !== 'ENOENT') console.error(e); }
			}
		} catch (e) {
			// ignore cleanup failures
		}

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
	const { currentPassword, newPassword } = req.body;
	if (!currentPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });
	if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: "New password too short" });

	try {
		const user = await prisma.user.findUnique({ where: { id: req.userId } });
		if (!user) return res.status(404).json({ error: "User not found" });

		const match = await bcrypt.compare(currentPassword, user.passwordHash);
		if (!match) return res.status(401).json({ error: "Wrong password" });

		const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
		await prisma.user.update({ where: { id: req.userId }, data: { passwordHash: hashed, passwordChangedAt: new Date() } });

		// Password changed — tokens issued before `passwordChangedAt` will be rejected.
		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Upload avatar ────────────────────────────────────────────────────────────
router.post("/me/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
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
		const isWebp = buf.slice(0,4).toString('ascii') === 'RIFF' && buf.slice(8,12).toString('ascii') === 'WEBP';

		if (!isJpeg && !isPng && !isGif && !isWebp) {
			try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
			return res.status(400).json({ error: "Invalid image file" });
		}
	} catch (e) {
		try { fs.unlinkSync(filePath); } catch (er) { /* ignore */ }
		return res.status(400).json({ error: "Invalid image file" });
	}

	// Re-encode image to a canonical JPEG to strip metadata and limit size
	const outExt = '.jpg';
	const outPath = path.join(path.dirname(filePath), `${req.userId}${outExt}`);
	const url = `/assets/images/user-profiles/${req.userId}${outExt}`;

		// Process image, update DB, broadcast, and cleanup in a single try/catch
		try {
			// Write to a temporary file first to avoid "Cannot use same file for input and output"
			const tempOut = outPath + '.tmp-' + Date.now();
			// Debug: log paths to help diagnose any input/output collisions.
			// Disabled by default; set AVATAR_DEBUG=1 to enable in dev only.
			if (process.env.AVATAR_DEBUG) {
				console.debug('avatar processing paths', { filePath, outPath, tempOut });
			}
			await sharp(filePath)
				.rotate()
				.resize({ width: 1024, height: 1024, fit: 'inside' })
				.jpeg({ quality: 80 })
				.toFile(tempOut);

			// Replace the destination atomically: remove target if it exists, then rename temp
			try { await fs.promises.unlink(outPath); } catch (e) { /* ignore if missing */ }
			await fs.promises.rename(tempOut, outPath);

			// Remove the original uploaded file if it's different from the final path
			if (outPath !== filePath) {
				try { await fs.promises.unlink(filePath); } catch (e) { /* ignore */ }
			}

			const updated = await prisma.user.update({
				where: { id: req.userId },
				data: { profilePics: [url] },
				select: { id: true, name: true, username: true, profilePics: true },
			});

			// Broadcast profile update to connected clients so other users see the
			// new avatar immediately.
			try {
				if (globalThis.__rivo_io) globalThis.__rivo_io.emit('user:updated', updated);
			} catch (e) {
				/* ignore broadcast failures */
			}

			// Remove any other avatar files for this user with different extensions
			try {
				const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
				for (const e of exts) {
					const p = path.join(process.cwd(), 'public', 'assets', 'images', 'user-profiles', `${req.userId}${e}`);
					if (p === outPath) continue;
					try { await fs.promises.unlink(p); } catch (err) { /* ignore missing */ }
				}
			} catch (e) {
				/* ignore cleanup failures */
			}

			return res.json({ url });
		} catch (err) {
			console.error('avatar processing failed', err);
			try { await fs.promises.unlink(filePath); } catch (e) { /* ignore */ }
			try { await fs.promises.unlink(outPath); } catch (e) { /* ignore */ }
			return res.status(500).json({ error: "Failed to process image" });
		}
});

export default router;
