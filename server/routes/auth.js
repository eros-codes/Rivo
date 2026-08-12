import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import crypto from "crypto";
import nodemailer from "nodemailer";
import push from "../utils/push.js";
import { verificationEmail } from "../utils/verificationEmail.js";
import resetPasswordEmail from "../utils/resetPasswordEmail.js";

const router = Router();
// bcrypt rounds: default to 12 in production, 10 in development
const DEFAULT_BCRYPT_ROUNDS = process.env.NODE_ENV === 'production' ? 12 : 10;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || DEFAULT_BCRYPT_ROUNDS);
// Basic server-side email format check to avoid passing invalid addresses to SMTP
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple verification TTL (configurable via VERIFICATION_TTL_MINUTES)
const VERIFICATION_TTL_MS = (Number(process.env.VERIFICATION_TTL_MINUTES) || 10) * 60 * 1000; // minutes -> ms
const RESET_TOKEN_TTL_MS = (Number(process.env.RESET_TOKEN_TTL_MINUTES) || 30) * 60 * 1000; // minutes -> ms

// Verification state is stored in the database so it survives restarts and
// works across multiple app instances.
// Per-email rate limiting for verification sends
const VERIFICATION_SEND_WINDOW_MS = (Number(process.env.VERIFICATION_SEND_WINDOW_MINUTES) || 60) * 60 * 1000; // default 60 minutes
const VERIFICATION_SEND_LIMIT = Number(process.env.VERIFICATION_SEND_LIMIT) || 5; // default 5 sends per window
// memory fallback counter: Map<normalizedEmail, { count, timer }>
const _sendCounts = new Map();
const MAX_SEND_COUNTS = Number(process.env.MAX_SEND_COUNTS || 20000);

// Per-email verification attempts allowed before requiring a new code
const VERIFICATION_MAX_ATTEMPTS = Number(process.env.VERIFICATION_MAX_ATTEMPTS || 5);

function _hashCode(code) {
    return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function _normEmail(email) {
    return String(email || '').toLowerCase().trim();
}

function _maskEmail(email) {
    try {
        const [local, domain] = String(email).split('@');
        if (!domain) return '***';
        const start = local && local.length ? local[0] : '*';
        const end = local && local.length > 1 ? local[local.length - 1] : '*';
        return `${start}***${end}@${domain}`;
    } catch (e) { return '***'; }
}

async function _incrementSendCount(email) {
    // Memory-only implementation for send-count; normalize email key
    const key = _normEmail(email);
    // Evict oldest entries if store grows too large
    try {
        if (_sendCounts.size >= MAX_SEND_COUNTS) {
            const oldest = _sendCounts.keys().next().value;
            if (oldest) {
                const t = _sendCounts.get(oldest)?.timer;
                if (t) clearTimeout(t);
                _sendCounts.delete(oldest);
            }
        }
    } catch (e) {
        /* ignore eviction errors */
    }

    const entry = _sendCounts.get(key) || { count: 0, timer: null };
    entry.count += 1;
    if (!entry.timer) {
        entry.timer = setTimeout(() => _sendCounts.delete(key), VERIFICATION_SEND_WINDOW_MS);
    }
    _sendCounts.set(key, entry);
    return entry.count;
}

async function _storeVerification(email, code) {
    const key = _normEmail(email);
    await prisma.emailVerification.deleteMany({ where: { email: key, verifiedAt: null } });
    await prisma.emailVerification.create({
        data: {
            email: key,
            codeHash: _hashCode(code),
            expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
    });
}

async function _getVerification(email) {
    return prisma.emailVerification.findFirst({
        where: { email: _normEmail(email), verifiedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { id: "desc" },
    });
}

async function _clearVerification(email) {
    await prisma.emailVerification.deleteMany({ where: { email: _normEmail(email), verifiedAt: null } });
}

setInterval(() => {
    prisma.emailVerification
        .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
        .catch((e) => console.warn("verification cleanup failed", e?.message || e));
}, 60 * 60 * 1000).unref();

async function _sendEmail({ to, subject, text, html }) {
    // Lazy-create and cache transporter to avoid recreating per-request
    if (typeof globalThis._rivo_smtp_transporter === 'undefined') globalThis._rivo_smtp_transporter = null;
    function _createTransporter() {
        const host = process.env.SMTP_HOST;
        const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;
        if (!host || !port || !user || !pass) {
            throw new Error('SMTP not configured');
        }
        const tr = nodemailer.createTransport({
            host,
            port,
            secure: String(port) === '465',
            auth: { user, pass },
        });
        return tr;
    }

    let transporter = globalThis._rivo_smtp_transporter;
    if (!transporter) {
        transporter = _createTransporter();
        // cache immediately to avoid concurrent creators
        globalThis._rivo_smtp_transporter = transporter;
        // attempt a verify in background (non-fatal)
        transporter.verify().then(() => {
            console.info('SMTP verified');
        }).catch((e) => {
            console.warn('SMTP verify failed (will still attempt send):', e && e.message ? e.message : e);
        });
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const info = await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
            return info;
        } catch (e) {
            // auth errors should not be retried
            const isAuthErr = e && (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534);
            if (isAuthErr) {
                throw e;
            }
            if (attempt < maxAttempts) {
                const backoff = 200 * Math.pow(2, attempt - 1);
                await new Promise((r) => setTimeout(r, backoff));
                continue;
            }
            throw e;
        }
    }
}

// POST /send-code -> sends a 6-digit code to the given email
router.post('/send-code', async (req, res) => {
    const { email, identifier, username } = req.body || {};
    // Invalid formats should behave like unknown accounts so the response does not leak account existence.
    if (email && typeof email === 'string' && !EMAIL_RE.test(String(email).trim())) {
        return res.json({ success: true });
    }
    let target = (email || identifier || username || '').trim();
    if (!target || typeof target !== 'string') return res.status(400).json({ error: 'Email or username required' });
    try {
        // If a username was provided, resolve to the user's email
        let sendTo = target;
        if (!/@/.test(sendTo)) {
            try {
                const user = await prisma.user.findFirst({ where: { username: sendTo } });
                if (!user || !user.email) {
                    // Don't reveal whether the username exists; return success
                    return res.json({ success: true });
                }
                sendTo = user.email;
            } catch (e) {
                // On DB errors, fail safely
                console.error('send-code username lookup failed', e && e.message ? e.message : e);
                return res.status(500).json({ error: 'Server error' });
            }
        }

        // If the resolved target looks like an email, ensure it has a basic
        // valid format before attempting SMTP to avoid nodemailer throwing
        // errors for obviously malformed addresses.
        if (/@/.test(sendTo) && !EMAIL_RE.test(sendTo)) {
            return res.json({ success: true });
        }

        // IP-based rate limiting is also needed to prevent abuse of the mail service.
        const ipCount = await _incrementSendCount(`ip:${req.ip}`);
        if (ipCount > VERIFICATION_SEND_LIMIT * 3) {
            console.warn(`send-code ip rate limited: ip=${req.ip} count=${ipCount}`);
            return res.status(429).json({ error: 'Too many verification attempts. Try later.' });
        }

        // per-email rate limit
        const sendCount = await _incrementSendCount(sendTo);
        if (sendCount > VERIFICATION_SEND_LIMIT) {
            const masked = _maskEmail(sendTo);
            console.warn(`send-code rate limited: ${masked} ip=${req.ip} count=${sendCount}`);
            return res.status(429).json({ error: 'Too many verification attempts. Try later.' });
        }

        const masked = _maskEmail(sendTo);
        console.info(`send-code requested: ${masked} ip=${req.ip} ua=${req.headers['user-agent'] || ''} count=${sendCount}`);

        const code = crypto.randomInt(100000, 1000000);
        await _storeVerification(sendTo, code);

        // send email via SMTP
        try {
            const tmpl = verificationEmail({
                code,
                email: sendTo,
                appName: process.env.APP_NAME || 'Rivo',
                expiresMinutes: Math.max(1, Math.floor(VERIFICATION_TTL_MS / 60000)),
            });
            await _sendEmail({ to: sendTo, subject: tmpl.subject, text: tmpl.text, html: tmpl.html });
            console.info(`verification email sent: ${masked} ip=${req.ip}`);
        } catch (e) {
            console.error('failed to send verification email', e && e.message ? e.message : e);
            // cleanup stored code
            await _clearVerification(sendTo);
            return res.status(500).json({ error: 'Failed to send email' });
        }

        return res.json({ success: true });
    } catch (e) {
        console.error('send-code failed', e && e.message ? e.message : e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// POST /verify-code -> verify that a code matches for the given email
router.post('/verify-code', async (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'Missing fields' });
    try {
        const entry = await _getVerification(email);
        if (!entry) return res.status(400).json({ error: 'Invalid or expired code' });

        const attempts = entry.attempts || 0;
        if (attempts >= VERIFICATION_MAX_ATTEMPTS) {
            await _clearVerification(email);
            return res.status(429).json({ error: 'Too many attempts. Request a new verification code.' });
        }

        if (entry.codeHash !== _hashCode(code)) {
            await prisma.emailVerification.update({
                where: { id: entry.id },
                data: { attempts: { increment: 1 } },
            });
            return res.status(400).json({ error: 'Invalid code' });
        }

        await prisma.emailVerification.update({
            where: { id: entry.id },
            data: { verifiedAt: new Date(), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
        });
        console.info(`verify-code success: ${_maskEmail(email)} ip=${req.ip}`);
        return res.json({ success: true });
    } catch (e) {
        console.error('verify-code failed', e && e.message ? e.message : e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// ─── Register ─────────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
    const { name, email, username, password } = req.body;

    if (!name || !email || !username || !password) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const normEmail = _normEmail(email);
        const verification = await prisma.emailVerification.findFirst({
            where: { email: normEmail, verifiedAt: { not: null }, consumedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { id: "desc" },
        });
        if (!verification) {
            return res.status(403).json({ error: 'Email not verified' });
        }

        // Basic server-side username format validation to prevent invalid or
        // potentially dangerous usernames (spaces, XSS payloads, etc.).
        if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({ error: 'Username must be 3-30 alphanumeric characters or underscore' });
        }
		const existing = await prisma.user.findFirst({
			where: {
				OR: [{ email: normEmail }, { username }],
			},
		});

		if (existing) {
			const field = existing.email === normEmail ? "email" : "username";
			return res
				.status(409)
				.json({ error: `This ${field} is already taken` });
		}

        // Enforce minimum password length for registration to match change-password rules
        if (typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

		// All steps must succeed together: otherwise a user can be left without saved messages.
		const user = await prisma.$transaction(async (tx) => {
			const created = await tx.user.create({
				data: { name, email: normEmail, username, passwordHash },
			});
			const savedConv = await tx.conversation.create({
				data: {
					members: { create: [{ userId: created.id }] },
				},
			});
			await tx.contact.create({
				data: {
					ownerId: created.id,
					contactId: created.id,
					conversationId: savedConv.id,
					isSaved: true,
				},
			});
			return created;
		});

        // consume verified marker so it can't be reused
        await prisma.emailVerification
            .update({ where: { id: verification.id }, data: { consumedAt: new Date() } })
            .catch((e) => console.warn('failed to consume verification', e?.message || e));

		return res.status(201).json({ success: true, userId: user.id });
	} catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
        return res.status(400).json({ error: "All fields are required" });
    }


    try {
        const user = await prisma.user.findFirst({
            where: {
                OR: [{ email: _normEmail(identifier) }, { username: identifier }],
            },
        });

        if (!user) {
            // Mitigate timing attacks by performing a bcrypt work factor
            // so responses for missing users take similar time to existing ones.
            try {
                await bcrypt.hash(password, BCRYPT_ROUNDS);
            } catch (e) {
                // ignore hashing errors; we still want to return generic 401
            }
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const match = await bcrypt.compare(password, user.passwordHash);

        if (!match) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (!process.env.JWT_SECRET) {
            console.error('JWT_SECRET not set at login time');
            return res.status(500).json({ error: 'Server misconfiguration' });
        }

        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // Set HttpOnly cookie so clients can opt into cookie-based auth.
        try {
            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
            // Also set a non-HttpOnly CSRF token cookie (double-submit pattern)
            const csrfToken = crypto.randomBytes(24).toString("hex");
            res.cookie("csrfToken", csrfToken, {
                httpOnly: false,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
        } catch (e) {
            // ignore cookie set errors
        }

        // Don't return the JWT in the JSON response to avoid accidental client-side storage.
        return res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                username: user.username,
                email: user.email,
                bio: user.bio,
                profilePics: user.profilePics,
            },
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
    // Try to determine user from token and remove server-side subscriptions
    try {
        const token = req.cookies?.token;
        if (token) {
            try {
                const payload = jwt.verify(token, process.env.JWT_SECRET);
                const userId = payload.userId;
                if (userId) {
                    try { push.removeAllSubscriptions(userId); } catch (e) { /* ignore */ }
                }
            } catch (e) { /* invalid token */ }
        }
    } catch (e) { /* ignore */ }

    // Clear cookie-based tokens
    res.clearCookie("token");
    res.clearCookie("csrfToken");
    return res.json({ success: true });
});

router.post("/request-password-reset", async (req, res) => {
    const { identifier } = req.body || {};
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "Missing identifier" });
    }

    const rawIdentifier = String(identifier).trim();
    if (!rawIdentifier) {
        return res.status(400).json({ error: "Missing identifier" });
    }

    try {
        let user = null;
        if (/@/.test(rawIdentifier)) {
            user = await prisma.user.findFirst({ where: { email: rawIdentifier } });
        } else {
            user = await prisma.user.findFirst({ where: { username: rawIdentifier } });
        }

        if (!user) {
            return res.json({ success: true });
        }

        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
        await prisma.passwordResetToken.create({
            data: {
                userId: user.id,
                tokenHash,
                expiresAt,
            },
        });

        const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
        const resetLink = `${appUrl}/reset-password.html?token=${encodeURIComponent(rawToken)}`;

        await _sendEmail({
            to: user.email,
            subject: "Reset your Rivo password",
            text: `Use this link to reset your password: ${resetLink}`,
            html: resetPasswordEmail({
                link: resetLink,
                appName: process.env.APP_NAME || "Rivo",
                expiresMinutes: Math.max(1, Math.floor(RESET_TOKEN_TTL_MS / 60000)),
            }),
        });

        return res.json({ success: true });
    } catch (e) {
        console.error("request-password-reset failed", e && e.message ? e.message : e);
        return res.status(500).json({ error: "Failed to send reset email" });
    }
});

router.post("/reset-password-with-token", async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || typeof token !== "string" || !newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
        return res.status(400).json({ error: "Missing or invalid fields" });
    }

    try {
        const rawToken = String(token).trim();
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const resetToken = await prisma.passwordResetToken.findFirst({
            where: {
                tokenHash,
                usedAt: null,
                expiresAt: { gt: new Date() },
            },
            include: { user: true },
        });

        if (!resetToken || !resetToken.user) {
            return res.status(400).json({ error: "Invalid or expired reset token" });
        }

        const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await prisma.$transaction([
            prisma.passwordResetToken.deleteMany({ where: { userId: resetToken.user.id } }),
            prisma.user.update({
                where: { id: resetToken.user.id },
                data: {
                    passwordHash,
                    passwordChangedAt: new Date(),
                },
            }),
        ]);

        try {
            res.clearCookie("token");
            res.clearCookie("csrfToken");
        } catch (e) {
            // ignore cookie clear errors
        }

        return res.json({ success: true });
    } catch (e) {
        console.error("reset-password-with-token failed", e && e.message ? e.message : e);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;