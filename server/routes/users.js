import { Router } from "express";
import bcrypt from "bcrypt";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, "public/assets/images/user-profiles/");
	},
	filename: (req, file, cb) => {
		cb(null, `${req.userId}.jpg`);
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

		// If client explicitly clears profilePics (empty array), remove the stored file
		if (profilePics !== undefined && Array.isArray(profilePics) && profilePics.length === 0) {
			const avatarPath = path.join(
				process.cwd(),
				"public",
				"assets",
				"images",
				"user-profiles",
				`${req.userId}.jpg`,
			);
			try {
				await fs.promises.unlink(avatarPath);
			} catch (e) {
				// Ignore if file does not exist, log other errors
				if (e.code && e.code !== "ENOENT") console.error(e);
			}
		}

		const user = await prisma.user.update({
			where: { id: req.userId },
			data: {
				...(name && { name }),
				...(username && { username }),
				...(bio !== undefined && { bio }),
				...(profilePics !== undefined && { profilePics }),
				...(privacyOnline && { privacyOnline }),
				...(privacyEmail && { privacyEmail }),
				...(privacyProfile && { privacyProfile }),
			},
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
		const user = await prisma.user.findUnique({
			where: { id: req.userId },
		});

		if (!user) return res.status(404).json({ error: "User not found" });

		const match = await bcrypt.compare(password, user.passwordHash);
		if (!match) return res.status(401).json({ error: "Wrong password" });

		await prisma.user.delete({ where: { id: req.userId } });

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

		const hashed = await bcrypt.hash(newPassword, 10);
		await prisma.user.update({ where: { id: req.userId }, data: { passwordHash: hashed } });

		// Note: JWT invalidation / session revocation is not implemented here.
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

	const url = `/assets/images/user-profiles/${req.userId}.jpg`;

    try {
        await prisma.user.update({
            where: { id: req.userId },
            data: { profilePics: [url] },
        });

        return res.json({ url });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;
