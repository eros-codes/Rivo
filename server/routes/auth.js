import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import crypto from "crypto";
import nodemailer from "nodemailer";
import push from "../utils/push.js";
import { verificationEmail } from "../utils/verificationEmail.js";

const router = Router();
// bcrypt rounds: default to 12 in production, 10 in development
const DEFAULT_BCRYPT_ROUNDS = process.env.NODE_ENV === 'production' ? 12 : 10;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || DEFAULT_BCRYPT_ROUNDS);

// Simple verification TTL (configurable via VERIFICATION_TTL_MINUTES)
const VERIFICATION_TTL_MS = (Number(process.env.VERIFICATION_TTL_MINUTES) || 10) * 60 * 1000; // minutes -> ms

// In-memory store for verification codes (keys are normalized emails)
const verificationCodes = new Map();
const verificationTimers = new Map();

// Verified emails cache: when a user successfully verifies a code we keep a
// short-lived marker allowing `/register` to proceed. Keys are normalized emails.
const verifiedEmails = new Map();
const verifiedEmailTimers = new Map();

// Per-email rate limiting for verification sends
const VERIFICATION_SEND_WINDOW_MS = (Number(process.env.VERIFICATION_SEND_WINDOW_MINUTES) || 60) * 60 * 1000; // default 60 minutes
const VERIFICATION_SEND_LIMIT = Number(process.env.VERIFICATION_SEND_LIMIT) || 5; // default 5 sends per window
// memory fallback counter: Map<normalizedEmail, { count, timer }>
const _sendCounts = new Map();

// Per-email verification attempts allowed before requiring a new code
const VERIFICATION_MAX_ATTEMPTS = Number(process.env.VERIFICATION_MAX_ATTEMPTS || 5);

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
    const entry = _sendCounts.get(key) || { count: 0, timer: null };
    entry.count += 1;
    if (!entry.timer) {
        entry.timer = setTimeout(() => _sendCounts.delete(key), VERIFICATION_SEND_WINDOW_MS);
    }
    _sendCounts.set(key, entry);
    return entry.count;
}

function _clearVerificationInMemory(email) {
    try {
        const key = _normEmail(email);
        verificationCodes.delete(key);
        const t = verificationTimers.get(key);
        if (t) clearTimeout(t);
        verificationTimers.delete(key);
    } catch (e) { /* ignore */ }
}

// Verification store uses in-memory storage only

async function _storeVerification(email, code) {
    // store in-memory only under normalized email
    const key = _normEmail(email);
    verificationCodes.set(key, { code, expiresAt: Date.now() + VERIFICATION_TTL_MS, attempts: 0 });
    if (verificationTimers.has(key)) {
        clearTimeout(verificationTimers.get(key));
    }
    verificationTimers.set(key, setTimeout(() => _clearVerificationInMemory(key), VERIFICATION_TTL_MS));
}

async function _getVerification(email) {
    const key = _normEmail(email);
    return verificationCodes.get(key) || null;
}

async function _clearVerification(email) {
    _clearVerificationInMemory(email);
}

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
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const info = await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
            return info;
        } catch (e) {
            lastErr = e;
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
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' });
    try {
        // per-email rate limit
        const sendCount = await _incrementSendCount(email);
        if (sendCount > VERIFICATION_SEND_LIMIT) {
            const masked = _maskEmail(email);
            console.warn(`send-code rate limited: ${masked} ip=${req.ip} count=${sendCount}`);
            return res.status(429).json({ error: 'Too many verification attempts. Try later.' });
        }

        const masked = _maskEmail(email);
        console.info(`send-code requested: ${masked} ip=${req.ip} ua=${req.headers['user-agent'] || ''} count=${sendCount}`);

        const code = crypto.randomInt(100000, 1000000);
        await _storeVerification(email, code);

        // send email via SMTP
        try {
            const tmpl = verificationEmail({
                code,
                email,
                appName: process.env.APP_NAME || 'Rivo',
                expiresMinutes: Math.max(1, Math.floor(VERIFICATION_TTL_MS / 60000)),
            });
            await _sendEmail({ to: email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html });
            console.info(`verification email sent: ${masked} ip=${req.ip}`);
        } catch (e) {
            console.error('failed to send verification email', e && e.message ? e.message : e);
            // cleanup stored code
            await _clearVerification(email);
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

        // Enforce attempt limits per-email to prevent offline brute-force.
        const attempts = entry.attempts || 0;
        if (attempts >= VERIFICATION_MAX_ATTEMPTS) {
            // clear code and require a new send
            await _clearVerification(email);
            return res.status(429).json({ error: 'Too many attempts. Request a new verification code.' });
        }

        if (String(entry.code) !== String(code)) {
            // increment attempts and persist in-memory
            const key = _normEmail(email);
            const next = { ...entry, attempts: attempts + 1 };
            verificationCodes.set(key, next);
            if (next.attempts >= VERIFICATION_MAX_ATTEMPTS) {
                await _clearVerification(email);
                return res.status(429).json({ error: 'Too many attempts. Request a new verification code.' });
            }
            return res.status(400).json({ error: 'Invalid code' });
        }
        // valid: mark email as recently verified (short-lived) so /register can proceed
        try {
            const key = _normEmail(email);
            verifiedEmails.set(key, Date.now() + VERIFICATION_TTL_MS);
            if (verifiedEmailTimers.has(key)) clearTimeout(verifiedEmailTimers.get(key));
            verifiedEmailTimers.set(key, setTimeout(() => verifiedEmails.delete(key), VERIFICATION_TTL_MS));
        } catch (e) {
            // don't fail verification on marker set failures
            console.warn('failed to set verifiedEmails marker', e && e.message ? e.message : e);
        }
        // clear stored code and return success
        await _clearVerification(email);
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
        // Require prior email verification (short-lived marker set by /verify-code)
        const normEmail = _normEmail(email);
        const verifiedUntil = verifiedEmails.get(normEmail);
        if (!verifiedUntil || verifiedUntil < Date.now()) {
            return res.status(403).json({ error: 'Email not verified' });
        }
		const existing = await prisma.user.findFirst({
			where: {
				OR: [{ email }, { username }],
			},
		});

		if (existing) {
			const field = existing.email === email ? "email" : "username";
			return res
				.status(409)
				.json({ error: `This ${field} is already taken` });
		}

        // Enforce minimum password length for registration to match change-password rules
        if (typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const user = await prisma.user.create({
			data: { name, email, username, passwordHash },
		});

        // consume verified marker so it can't be reused
        try { verifiedEmails.delete(normEmail); if (verifiedEmailTimers.has(normEmail)) { clearTimeout(verifiedEmailTimers.get(normEmail)); verifiedEmailTimers.delete(normEmail); } } catch (e) { /* ignore */ }
        
		// ─── Auto-create Saved Messages ───────────────────────────────────────────
		await prisma.$transaction(async (tx) => {
			const savedConv = await tx.conversation.create({
				data: {
					members: { create: [{ userId: user.id }] },
				},
			});
			await tx.contact.create({
				data: {
					ownerId: user.id,
					contactId: user.id,
					conversationId: savedConv.id,
					isSaved: true,
				},
			});
		});

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
                OR: [{ email: identifier }, { username: identifier }],
            },
        });

        if (!user) {
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

// Disabled: insecure unauthenticated password reset. Implement a secure
// email + token-based reset flow before enabling this endpoint.
router.post("/reset-password", async (req, res) => {
    return res.status(501).json({
        error: "Not implemented. Use a secure password-reset flow (email token).",
    });
});

export default router;