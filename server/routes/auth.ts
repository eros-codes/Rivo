import { Router } from "express";
import type { User } from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { appendFile } from "node:fs/promises";
import prisma from "../prisma.ts";
import { config, envNumber } from "../config.ts";
import push from "../utils/push.ts";
import { verificationEmail } from "../utils/verificationEmail.ts";
import resetPasswordEmail from "../utils/resetPasswordEmail.ts";
import { accountExistsEmail } from "../utils/accountExistsEmail.ts";
import { CheckAvailability, Login, Logout, Register, RequestPasswordReset, ResetPassword, SendCode, VerifyCode } from "../../shared/schemas/auth.ts";
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from "../../shared/limits.ts";
import { check, parse } from "../http/validate.ts";
import { findUserByIdentifier, isEmailTaken, isUsernameTaken } from "../utils/userLookup.ts";
import {
	clearSessionCookies,
	loadSession,
	readToken,
	revokeAllSessions,
	revokeSession,
	sessionOfRequest,
	startSession,
	tokenFromRequest,
} from "../auth/sessions.ts";
import { log } from "../utils/logger.ts";
import { meOf } from "../utils/wire.ts";
import { codeOf, messageOf } from "../utils/errors.ts";
import { reply } from "../http/reply.ts";

const router = Router();

const VERIFICATION_TTL_MS = envNumber("VERIFICATION_TTL_MINUTES", 10) * 60_000;
const RESET_TOKEN_TTL_MS = envNumber("RESET_TOKEN_TTL_MINUTES", 30) * 60_000;
const SEND_WINDOW_MS = envNumber("VERIFICATION_SEND_WINDOW_MINUTES", 60) * 60_000;
const SEND_LIMIT = envNumber("VERIFICATION_SEND_LIMIT", 5);
const MAX_ATTEMPTS = envNumber("VERIFICATION_MAX_ATTEMPTS", 5);
const MAX_SEND_COUNTS = envNumber("MAX_SEND_COUNTS", 20_000);

const hashCode = (code: unknown): string => crypto.createHash("sha256").update(String(code)).digest("hex");
const normEmail = (email: unknown): string => String(email || "").toLowerCase().trim();

function maskEmail(email: unknown): string {
	const [local, domain] = String(email).split("@");
	if (!domain) return "***";
	return `${local?.[0] || "*"}***${local && local.length > 1 ? local[local.length - 1] : "*"}@${domain}`;
}

// Counters for sending limits (in memory; they only need to survive a window)
const sendCounts = new Map<string, { count: number; timer: NodeJS.Timeout | null }>();
function countSend(key: string): number {
	if (sendCounts.size >= MAX_SEND_COUNTS) {
		const oldest = sendCounts.keys().next().value;
		if (oldest !== undefined) {
			clearTimeout(sendCounts.get(oldest)?.timer ?? undefined);
			sendCounts.delete(oldest);
		}
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
		.catch((e) => log.warn("verification cleanup failed", messageOf(e) || e));
}, 60 * 60 * 1000).unref?.();

// The automated tests read emails (codes, reset links) from a file instead
// of a mailbox. Never in production: the server refuses to start with it.
const CAPTURE_FILE = !config.isProd && process.env.MAIL_CAPTURE_FILE ? process.env.MAIL_CAPTURE_FILE : null;

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
async function sendEmail({ to, subject, text, html }: { to: string; subject: string; text: string; html: string }) {
	if (CAPTURE_FILE) {
		await appendFile(CAPTURE_FILE, `${JSON.stringify({ to, subject, text, html, at: new Date().toISOString() })}\n`);
		return { captured: true };
	}
	if (!transporter) {
		const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = process.env;
		const port = Number(process.env.SMTP_PORT) || undefined;
		if (!host || !port || !user || !pass) throw new Error("SMTP not configured");
		transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
		transporter.verify().catch((e) => log.warn("SMTP verify failed (sending is still tried):", messageOf(e) || e));
	}
	for (let attempt = 1; ; attempt++) {
		try {
			return await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
		} catch (e) {
			const err = e as { code?: unknown; responseCode?: unknown } | null;
			const authError = err && (err.code === "EAUTH" || err.responseCode === 535 || err.responseCode === 534);
			if (authError || attempt >= 3) throw e;
			await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
		}
	}
}


// ─── Email verification (sign-up) ─────────────────────────────────────────
// The form answers the same way whether or not the address already has an
// account (that one gets a "you already have an account" email instead of a
// code), so sign-up cannot be used to find out who uses Rivo.
router.post("/send-code", async (req, res) => {
	const body = parse(res, SendCode, req.body);
	if (!body) return;
	const to = body.email;
	const key = normEmail(to);
	try {
		if (countSend(`ip:${req.ip}`) > SEND_LIMIT * 3 || countSend(key) > SEND_LIMIT) {
			log.warn(`send-code limited: ${maskEmail(to)} ip=${req.ip}`);
			return void res.status(429).json({ error: "Too many verification attempts. Try later." });
		}

		if (await isEmailTaken(key)) {
			try {
				const t = accountExistsEmail({ appName: config.appName, signInUrl: `${config.appUrl}/auth/`, resetUrl: `${config.appUrl}/auth/?forgot=1` });
				await sendEmail({ to, subject: t.subject, text: t.text, html: t.html });
				log.info(`sign-up attempt for an existing account: ${maskEmail(to)}`);
			} catch (e) {
				log.error("account-exists email failed", messageOf(e) || e);
				return void res.status(500).json({ error: "Failed to send email" });
			}
			return void reply(res, "POST /api/auth/send-code", { success: true });
		}

		const code = crypto.randomInt(100000, 1000000);
		await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
		await prisma.emailVerification.create({ data: { email: key, codeHash: hashCode(code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) } });
		try {
			const t = verificationEmail({ code, email: to, appName: config.appName, expiresMinutes: Math.max(1, Math.floor(VERIFICATION_TTL_MS / 60000)) });
			await sendEmail({ to, subject: t.subject, text: t.text, html: t.html });
			log.info(`verification email sent: ${maskEmail(to)}`);
		} catch (e) {
			log.error("verification email failed", messageOf(e) || e);
			await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
			return void res.status(500).json({ error: "Failed to send email" });
		}
		return void reply(res, "POST /api/auth/send-code", { success: true });
	} catch (e) {
		log.error("send-code failed", messageOf(e) || e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.post("/verify-code", async (req, res) => {
	const body = parse(res, VerifyCode, req.body);
	if (!body) return;
	const { code } = body;
	try {
		const key = normEmail(body.email);
		const entry = await prisma.emailVerification.findFirst({
			where: { email: key, verifiedAt: null, expiresAt: { gt: new Date() } },
			orderBy: { id: "desc" },
		});
		if (!entry) return void res.status(400).json({ error: "Invalid or expired code" });
		// every guess uses up one try first, in a single step, so many guesses
		// sent at the same moment cannot all slip under the limit
		const claimed = await prisma.emailVerification.updateMany({
			where: { id: entry.id, attempts: { lt: MAX_ATTEMPTS } },
			data: { attempts: { increment: 1 } },
		});
		if (claimed.count === 0) {
			await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
			return void res.status(429).json({ error: "Too many attempts. Request a new verification code." });
		}
		const ok = crypto.timingSafeEqual(Buffer.from(entry.codeHash), Buffer.from(hashCode(code)));
		if (!ok) return void res.status(400).json({ error: "Invalid code" });
		await prisma.emailVerification.update({
			where: { id: entry.id },
			data: { verifiedAt: new Date(), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
		});
		return void reply(res, "POST /api/auth/verify-code", { success: true });
	} catch (e) {
		log.error("verify-code failed", messageOf(e) || e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// The sign-up form says a username is taken before a code is sent (usernames
// are public anyway). Email addresses are never checked here: see send-code.
router.post("/check-availability", async (req, res) => {
	// (anything that is not a username is simply not taken)
	const body = check(CheckAvailability, req.body);
	const username = body.ok ? body.data.username : null;
	try {
		if (countSend(`avail:${req.ip}`) > 60) return void res.status(429).json({ error: "Too many attempts. Try later." });
		const result = { usernameTaken: false };
		if (username) result.usernameTaken = await isUsernameTaken(username);
		return void reply(res, "POST /api/auth/check-availability", result);
	} catch (e) {
		log.error("check-availability failed", messageOf(e) || e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Register ─────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
	const body = parse(res, Register, req.body);
	if (!body) return;
	const { name: cleanName, username: cleanUsername, password } = body;

	try {
		const key = normEmail(body.email);
		const verification = await prisma.emailVerification.findFirst({
			where: { email: key, verifiedAt: { not: null }, consumedAt: null, expiresAt: { gt: new Date() } },
			orderBy: { id: "desc" },
		});
		if (!verification) return void res.status(403).json({ error: "Email not verified" });
		if (await isEmailTaken(key)) return void res.status(409).json({ error: "This email is already taken" });
		if (await isUsernameTaken(cleanUsername)) return void res.status(409).json({ error: "This username is already taken" });

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
			if (codeOf(e) === "P2002") return void res.status(409).json({ error: "This email or username is already taken" });
			throw e;
		}
		await prisma.emailVerification
			.update({ where: { id: verification.id }, data: { consumedAt: new Date() } })
			.catch((e) => log.warn("failed to consume verification", messageOf(e) || e));
		return void reply(res, "POST /api/auth/register", { success: true, userId: user.id }, 201);
	} catch (e) {
		log.error("register failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Login / logout ───────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
	const body = parse(res, Login, req.body);
	if (!body) return;
	const { identifier, password } = body;
	try {
		const user = password.length <= PASSWORD_MAX_LENGTH ? await findUserByIdentifier(identifier, { isDeleted: false }) : null;
		if (!user) {
			// the same work as a real check, so timing does not reveal accounts
			await bcrypt.hash(password.slice(0, PASSWORD_MAX_LENGTH), config.bcryptRounds).catch(() => {});
			return void res.status(401).json({ error: "Invalid credentials" });
		}
		if (!(await bcrypt.compare(password, user.passwordHash))) return void res.status(401).json({ error: "Invalid credentials" });
		await startSession(res, user.id, req.get("user-agent"));
		return void reply(res, "POST /api/auth/login", { success: true, user: meOf(user) });
	} catch (e) {
		log.error("login failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.post("/logout", async (req, res) => {
	try {
		const payload = readToken(tokenFromRequest(req));
		const session = payload ? await loadSession(payload).catch(() => null) : null;
		if (session) {
			// this device's notifications stop (they belong to its session; an
			// endpoint from before sessions existed is removed by its address)
			const body = check(Logout, req.body);
			const endpoint = body.ok ? body.data.endpoint : null;
			if (endpoint) await push.removeSubscriptionByEndpoint(session.userId, endpoint);
			await revokeSession(session.id);
		}
	} catch (e) {
		log.warn("logout cleanup failed", messageOf(e) || e);
	}
	clearSessionCookies(res);
	return void reply(res, "POST /api/auth/logout", { success: true });
});

// ─── Password reset by email ──────────────────────────────────────────────
async function issueResetLink(user: Pick<User, "id" | "email">): Promise<void> {
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
	try {
		// signed in (Settings → "Send reset email"): the session says who it is,
		// and a failure to send can be reported
		const session = await sessionOfRequest(req);
		if (session) {
			const me = await prisma.user.findUnique({ where: { id: session.userId } });
			if (!me || me.isDeleted) return void res.status(401).json({ error: "Unauthorized" });
			if (countSend(`reset:${me.id}`) > SEND_LIMIT) return void res.status(429).json({ error: "Too many reset emails. Try later." });
			await issueResetLink(me);
			return void reply(res, "POST /api/auth/request-password-reset", { success: true });
		}

		const body = check(RequestPasswordReset, req.body);
		const raw = body.ok ? body.data.identifier : "";
		if (!raw || raw.length > EMAIL_MAX_LENGTH) return void res.status(400).json({ error: "Missing identifier" });
		const user = await findUserByIdentifier(raw);
		// The answer never reveals whether the account exists, not even by how
		// long it takes: it is sent before any of the work for a real account.
		reply(res, "POST /api/auth/request-password-reset", { success: true });
		if (!user || user.isDeleted) return;
		if (countSend(`reset:${user.id}`) > SEND_LIMIT || countSend(`reset-ip:${req.ip}`) > SEND_LIMIT * 3) {
			log.warn(`password reset limited: user=${user.id} ip=${req.ip}`);
			return;
		}
		issueResetLink(user).catch((e) => log.error("password reset email failed", messageOf(e) || e));
	} catch (e) {
		log.error("request-password-reset failed", messageOf(e) || e);
		if (!res.headersSent) return void res.status(500).json({ error: "Failed to send reset email" });
	}
});

router.post("/reset-password-with-token", async (req, res) => {
	const body = parse(res, ResetPassword, req.body);
	if (!body) return;
	const { token, newPassword } = body;
	try {
		const tokenHash = crypto.createHash("sha256").update(token.trim()).digest("hex");
		const reset = await prisma.passwordResetToken.findFirst({
			where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
			include: { user: true },
		});
		if (!reset?.user || reset.user.isDeleted) return void res.status(400).json({ error: "Invalid or expired reset token" });
		const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
		await prisma.$transaction([
			prisma.passwordResetToken.deleteMany({ where: { userId: reset.user.id } }),
			prisma.user.update({ where: { id: reset.user.id }, data: { passwordHash, passwordChangedAt: new Date() } }),
		]);
		// every device signs in again with the new password
		await revokeAllSessions(reset.user.id);
		clearSessionCookies(res);
		return void reply(res, "POST /api/auth/reset-password-with-token", { success: true });
	} catch (e) {
		log.error("reset-password-with-token failed", messageOf(e) || e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
