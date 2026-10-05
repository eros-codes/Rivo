import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { appendFile } from "node:fs/promises";
import prisma from "../prisma.js";
import { config, envNumber } from "../config.js";
import push from "../utils/push.js";
import { verificationEmail } from "../utils/verificationEmail.js";
import resetPasswordEmail from "../utils/resetPasswordEmail.js";
import { accountExistsEmail } from "../utils/accountExistsEmail.js";
import { isEmail, USERNAME_RE } from "../utils/validators.js";
import { findUserByIdentifier, isEmailTaken, isUsernameTaken } from "../utils/userLookup.js";
import {
	clearSessionCookies,
	loadSession,
	readToken,
	revokeAllSessions,
	revokeSession,
	sessionOfRequest,
	startSession,
	tokenFromRequest,
} from "../auth/sessions.js";
import { log } from "../utils/logger.js";

const router = Router();

const VERIFICATION_TTL_MS = envNumber("VERIFICATION_TTL_MINUTES", 10) * 60_000;
const RESET_TOKEN_TTL_MS = envNumber("RESET_TOKEN_TTL_MINUTES", 30) * 60_000;
const SEND_WINDOW_MS = envNumber("VERIFICATION_SEND_WINDOW_MINUTES", 60) * 60_000;
const SEND_LIMIT = envNumber("VERIFICATION_SEND_LIMIT", 5);
const MAX_ATTEMPTS = envNumber("VERIFICATION_MAX_ATTEMPTS", 5);
const MAX_SEND_COUNTS = envNumber("MAX_SEND_COUNTS", 20_000);

const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");
const normEmail = (email) => String(email || "").toLowerCase().trim();

function maskEmail(email) {
	const [local, domain] = String(email).split("@");
	if (!domain) return "***";
	return `${local?.[0] || "*"}***${local && local.length > 1 ? local[local.length - 1] : "*"}@${domain}`;
}

// Counters for sending limits (in memory; they only need to survive a window)
const sendCounts = new Map();
function countSend(key) {
	if (sendCounts.size >= MAX_SEND_COUNTS) {
		const oldest = sendCounts.keys().next().value;
		clearTimeout(sendCounts.get(oldest)?.timer);
		sendCounts.delete(oldest);
	}
	const entry = sendCounts.get(key) || { count: 0, timer: null };
	entry.count += 1;
	if (!entry.timer) {
		entry.timer = setTimeout(() => sendCounts.delete(key), SEND_WINDOW_MS);
		entry.timer.unref?.();
	}
	sendCounts.set(key, entry);
	return entry.count;
}

setInterval(() => {
	prisma.emailVerification
		.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
		.catch((e) => log.warn("verification cleanup failed", e?.message || e));
}, 60 * 60 * 1000).unref?.();

// The automated tests read emails (codes, reset links) from a file instead
// of a mailbox. Never in production: the server refuses to start with it.
const CAPTURE_FILE = !config.isProd && process.env.MAIL_CAPTURE_FILE ? process.env.MAIL_CAPTURE_FILE : null;

let transporter = null;
async function sendEmail({ to, subject, text, html }) {
	if (CAPTURE_FILE) {
		await appendFile(CAPTURE_FILE, `${JSON.stringify({ to, subject, text, html, at: new Date().toISOString() })}\n`);
		return { captured: true };
	}
	if (!transporter) {
		const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = process.env;
		const port = Number(process.env.SMTP_PORT) || undefined;
		if (!host || !port || !user || !pass) throw new Error("SMTP not configured");
		transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
		transporter.verify().catch((e) => log.warn("SMTP verify failed (sending is still tried):", e?.message || e));
	}
	for (let attempt = 1; ; attempt++) {
		try {
			return await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
		} catch (e) {
			const authError = e && (e.code === "EAUTH" || e.responseCode === 535 || e.responseCode === 534);
			if (authError || attempt >= 3) throw e;
			await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
		}
	}
}

function publicUser(u) {
	return {
		id: u.id,
		name: u.name,
		username: u.username,
		email: u.email,
		bio: u.bio || "",
		profilePics: u.profilePics || [],
		privacyOnline: u.privacyOnline,
		privacyEmail: u.privacyEmail,
		privacyProfile: u.privacyProfile,
	};
}

// ─── Email verification (sign-up) ─────────────────────────────────────────
// The form answers the same way whether or not the address already has an
// account (that one gets a "you already have an account" email instead of a
// code), so sign-up cannot be used to find out who uses Rivo.
router.post("/send-code", async (req, res) => {
	const { email } = req.body || {};
	if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });
	const to = email.trim();
	const key = normEmail(to);
	try {
		if (countSend(`ip:${req.ip}`) > SEND_LIMIT * 3 || countSend(key) > SEND_LIMIT) {
			log.warn(`send-code limited: ${maskEmail(to)} ip=${req.ip}`);
			return res.status(429).json({ error: "Too many verification attempts. Try later." });
		}

		if (await isEmailTaken(key)) {
			try {
				const t = accountExistsEmail({ appName: config.appName, signInUrl: `${config.appUrl}/auth/`, resetUrl: `${config.appUrl}/auth/?forgot=1` });
				await sendEmail({ to, subject: t.subject, text: t.text, html: t.html });
				log.info(`sign-up attempt for an existing account: ${maskEmail(to)}`);
			} catch (e) {
				log.error("account-exists email failed", e?.message || e);
				return res.status(500).json({ error: "Failed to send email" });
			}
			return res.json({ success: true });
		}

		const code = crypto.randomInt(100000, 1000000);
		await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
		await prisma.emailVerification.create({ data: { email: key, codeHash: hashCode(code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) } });
		try {
			const t = verificationEmail({ code, email: to, appName: config.appName, expiresMinutes: Math.max(1, Math.floor(VERIFICATION_TTL_MS / 60000)) });
			await sendEmail({ to, subject: t.subject, text: t.text, html: t.html });
			log.info(`verification email sent: ${maskEmail(to)}`);
		} catch (e) {
			log.error("verification email failed", e?.message || e);
			await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
			return res.status(500).json({ error: "Failed to send email" });
		}
		return res.json({ success: true });
	} catch (e) {
		log.error("send-code failed", e?.message || e);
		return res.status(500).json({ error: "Server error" });
	}
});

router.post("/verify-code", async (req, res) => {
	const { email, code } = req.body || {};
	if (!isEmail(email) || (typeof code !== "string" && typeof code !== "number") || !/^\d{6}$/.test(String(code).trim())) {
		return res.status(400).json({ error: "Invalid or expired code" });
	}
	try {
		const key = normEmail(email);
		const entry = await prisma.emailVerification.findFirst({
			where: { email: key, verifiedAt: null, expiresAt: { gt: new Date() } },
			orderBy: { id: "desc" },
		});
		if (!entry) return res.status(400).json({ error: "Invalid or expired code" });
		// every guess uses up one try first, in a single step, so many guesses
		// sent at the same moment cannot all slip under the limit
		const claimed = await prisma.emailVerification.updateMany({
			where: { id: entry.id, attempts: { lt: MAX_ATTEMPTS } },
			data: { attempts: { increment: 1 } },
		});
		if (claimed.count === 0) {
			await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
			return res.status(429).json({ error: "Too many attempts. Request a new verification code." });
		}
		const ok = crypto.timingSafeEqual(Buffer.from(entry.codeHash), Buffer.from(hashCode(String(code).trim())));
		if (!ok) return res.status(400).json({ error: "Invalid code" });
		await prisma.emailVerification.update({
			where: { id: entry.id },
			data: { verifiedAt: new Date(), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
		});
		return res.json({ success: true });
	} catch (e) {
		log.error("verify-code failed", e?.message || e);
		return res.status(500).json({ error: "Server error" });
	}
});

// The sign-up form says a username is taken before a code is sent (usernames
// are public anyway). Email addresses are never checked here: see send-code.
router.post("/check-availability", async (req, res) => {
	const { username } = req.body || {};
	try {
		if (countSend(`avail:${req.ip}`) > 60) return res.status(429).json({ error: "Too many attempts. Try later." });
		const result = { usernameTaken: false };
		if (typeof username === "string" && USERNAME_RE.test(username.trim())) result.usernameTaken = await isUsernameTaken(username);
		return res.json(result);
	} catch (e) {
		log.error("check-availability failed", e?.message || e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Register ─────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
	const { name, email, username, password } = req.body || {};
	if (!name || !email || !username || !password) return res.status(400).json({ error: "All fields are required" });
	if ([name, email, username, password].some((v) => typeof v !== "string")) return res.status(400).json({ error: "Invalid fields" });
	const cleanName = name.trim();
	const cleanUsername = username.trim();
	if (cleanName.length < 2 || cleanName.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters" });
	if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });
	if (!USERNAME_RE.test(cleanUsername)) return res.status(400).json({ error: "Username must be 3-30 letters, numbers or underscores" });
	if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
	if (password.length > config.maxPasswordLength) return res.status(400).json({ error: "Password is too long" });

	try {
		const key = normEmail(email);
		const verification = await prisma.emailVerification.findFirst({
			where: { email: key, verifiedAt: { not: null }, consumedAt: null, expiresAt: { gt: new Date() } },
			orderBy: { id: "desc" },
		});
		if (!verification) return res.status(403).json({ error: "Email not verified" });
		if (await isEmailTaken(key)) return res.status(409).json({ error: "This email is already taken" });
		if (await isUsernameTaken(cleanUsername)) return res.status(409).json({ error: "This username is already taken" });

		const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
		let user;
		try {
			// the account and its Saved Messages chat are created together
			user = await prisma.$transaction(async (tx) => {
				const created = await tx.user.create({ data: { name: cleanName, email: key, username: cleanUsername, passwordHash } });
				const saved = await tx.conversation.create({ data: { members: { create: [{ userId: created.id }] } } });
				await tx.contact.create({ data: { ownerId: created.id, contactId: created.id, conversationId: saved.id, isSaved: true } });
				return created;
			});
		} catch (e) {
			if (e?.code === "P2002") return res.status(409).json({ error: "This email or username is already taken" });
			throw e;
		}
		await prisma.emailVerification
			.update({ where: { id: verification.id }, data: { consumedAt: new Date() } })
			.catch((e) => log.warn("failed to consume verification", e?.message || e));
		return res.status(201).json({ success: true, userId: user.id });
	} catch (e) {
		log.error("register failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Login / logout ───────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
	const { identifier, password } = req.body || {};
	if (!identifier || !password || typeof identifier !== "string" || typeof password !== "string") {
		return res.status(400).json({ error: "All fields are required" });
	}
	try {
		const user = password.length <= config.maxPasswordLength ? await findUserByIdentifier(identifier, { isDeleted: false }) : null;
		if (!user) {
			// the same work as a real check, so timing does not reveal accounts
			await bcrypt.hash(password.slice(0, config.maxPasswordLength), config.bcryptRounds).catch(() => {});
			return res.status(401).json({ error: "Invalid credentials" });
		}
		if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Invalid credentials" });
		await startSession(res, user.id, req.get("user-agent"));
		return res.json({ success: true, user: publicUser(user) });
	} catch (e) {
		log.error("login failed", e);
		return res.status(500).json({ error: "Server error" });
	}
});

router.post("/logout", async (req, res) => {
	try {
		const payload = readToken(tokenFromRequest(req));
		const session = payload ? await loadSession(payload).catch(() => null) : null;
		if (session) {
			// this device's notifications stop (they belong to its session; an
			// endpoint from before sessions existed is removed by its address)
			const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : null;
			if (endpoint) await push.removeSubscriptionByEndpoint(session.userId, endpoint);
			await revokeSession(session.id);
		}
	} catch (e) {
		log.warn("logout cleanup failed", e?.message || e);
	}
	clearSessionCookies(res);
	return res.json({ success: true });
});

// ─── Password reset by email ──────────────────────────────────────────────
async function issueResetLink(user) {
	const rawToken = crypto.randomBytes(32).toString("hex");
	await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
	await prisma.passwordResetToken.create({
		data: {
			userId: user.id,
			tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
			expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
		},
	});
	const link = `${config.appUrl}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
	await sendEmail({
		to: user.email,
		subject: `Reset your ${config.appName} password`,
		text: `Use this link to reset your password: ${link}`,
		html: resetPasswordEmail({ link, appName: config.appName, expiresMinutes: Math.max(1, Math.floor(RESET_TOKEN_TTL_MS / 60000)) }),
	});
}

router.post("/request-password-reset", async (req, res) => {
	const { identifier } = req.body || {};
	try {
		// signed in (Settings → "Send reset email"): the session says who it is,
		// and a failure to send can be reported
		const session = await sessionOfRequest(req);
		if (session) {
			const me = await prisma.user.findUnique({ where: { id: session.userId } });
			if (!me || me.isDeleted) return res.status(401).json({ error: "Unauthorized" });
			if (countSend(`reset:${me.id}`) > SEND_LIMIT) return res.status(429).json({ error: "Too many reset emails. Try later." });
			await issueResetLink(me);
			return res.json({ success: true });
		}

		const raw = typeof identifier === "string" ? identifier.trim() : "";
		if (!raw || raw.length > 254) return res.status(400).json({ error: "Missing identifier" });
		const user = await findUserByIdentifier(raw);
		// The answer never reveals whether the account exists, not even by how
		// long it takes: it is sent before any of the work for a real account.
		res.json({ success: true });
		if (!user || user.isDeleted) return;
		if (countSend(`reset:${user.id}`) > SEND_LIMIT || countSend(`reset-ip:${req.ip}`) > SEND_LIMIT * 3) {
			log.warn(`password reset limited: user=${user.id} ip=${req.ip}`);
			return;
		}
		issueResetLink(user).catch((e) => log.error("password reset email failed", e?.message || e));
	} catch (e) {
		log.error("request-password-reset failed", e?.message || e);
		if (!res.headersSent) return res.status(500).json({ error: "Failed to send reset email" });
	}
});

router.post("/reset-password-with-token", async (req, res) => {
	const { token, newPassword } = req.body || {};
	if (typeof token !== "string" || !token || typeof newPassword !== "string" || newPassword.length < 8) {
		return res.status(400).json({ error: "Missing or invalid fields" });
	}
	if (newPassword.length > config.maxPasswordLength) return res.status(400).json({ error: "Password is too long" });
	try {
		const tokenHash = crypto.createHash("sha256").update(token.trim()).digest("hex");
		const reset = await prisma.passwordResetToken.findFirst({
			where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
			include: { user: true },
		});
		if (!reset?.user || reset.user.isDeleted) return res.status(400).json({ error: "Invalid or expired reset token" });
		const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
		await prisma.$transaction([
			prisma.passwordResetToken.deleteMany({ where: { userId: reset.user.id } }),
			prisma.user.update({ where: { id: reset.user.id }, data: { passwordHash, passwordChangedAt: new Date() } }),
		]);
		// every device signs in again with the new password
		await revokeAllSessions(reset.user.id);
		clearSessionCookies(res);
		return res.json({ success: true });
	} catch (e) {
		log.error("reset-password-with-token failed", e?.message || e);
		return res.status(500).json({ error: "Server error" });
	}
});

export default router;
