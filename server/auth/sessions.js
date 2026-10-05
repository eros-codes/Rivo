// Signed-in devices.
//
// Each sign-in creates a Session row. The session cookie holds a JWT that
// names the row (`sid`) and its user (`uid`): the signature proves the cookie
// came from this server, the row decides whether it is still valid, so one
// device can be signed out on its own and immediately.
//
// CSRF: the CSRF cookie holds HMAC(secret, sid). The client echoes it in the
// X-CSRF-Token header; the server recomputes it from the session, so a value
// planted by someone else can never match (signed double-submit cookie).
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import { config } from "../config.js";
import { bus } from "../events.js";
import { log } from "../utils/logger.js";

const { session: S } = config;

export function newSessionId() {
	return crypto.randomBytes(18).toString("base64url");
}

export function csrfFor(sid) {
	return crypto.createHmac("sha256", config.jwtSecret).update(`csrf:${sid}`).digest("base64url");
}

export function safeEqual(a, b) {
	const x = Buffer.from(String(a || ""));
	const y = Buffer.from(String(b || ""));
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Cookie header → { name: value } */
export function parseCookies(header) {
	const out = {};
	for (const part of String(header || "").split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		const k = part.slice(0, i).trim();
		if (!k || k in out) continue;
		const v = part.slice(i + 1).trim();
		try {
			out[k] = decodeURIComponent(v);
		} catch {
			out[k] = v;
		}
	}
	return out;
}

function cookieOptions(httpOnly) {
	return { httpOnly, secure: config.isProd, sameSite: "lax", path: "/", maxAge: S.ttlMs };
}

export function setSessionCookies(res, userId, sid) {
	const token = jwt.sign({ uid: userId, sid }, config.jwtSecret, {
		algorithm: "HS256",
		expiresIn: Math.floor(S.ttlMs / 1000),
	});
	res.cookie(S.cookie, token, cookieOptions(true));
	res.cookie(S.csrfCookie, csrfFor(sid), cookieOptions(false));
}

export function clearSessionCookies(res) {
	const base = { path: "/", secure: config.isProd, sameSite: "lax" };
	res.clearCookie(S.cookie, { ...base, httpOnly: true });
	res.clearCookie(S.csrfCookie, base);
	// cookies of the server before sessions existed
	res.clearCookie("token", { path: "/" });
	res.clearCookie("csrfToken", { path: "/" });
}

/** The verified token payload { uid, sid, iat }, or null. */
export function readToken(token) {
	if (!token || typeof token !== "string") return null;
	try {
		const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
		if (!p || typeof p.sid !== "string" || !Number.isInteger(p.uid)) return null;
		return p;
	} catch {
		return null;
	}
}

export function tokenFromRequest(req) {
	return req.cookies?.[S.cookie] || null;
}

/**
 * The session a token belongs to, when it is still valid:
 * not revoked, not expired, its account not deleted.
 * Database errors are thrown (the caller answers 503, not 401).
 */
export async function loadSession(payload) {
	if (!payload) return null;
	const s = await prisma.session.findUnique({
		where: { id: payload.sid },
		select: {
			id: true,
			userId: true,
			createdAt: true,
			lastSeenAt: true,
			expiresAt: true,
			revokedAt: true,
			user: { select: { isDeleted: true } },
		},
	});
	if (!s || s.userId !== payload.uid || s.revokedAt || s.expiresAt.getTime() <= Date.now() || !s.user || s.user.isDeleted) {
		return null;
	}
	return s;
}

export async function startSession(res, userId, userAgent) {
	const sid = newSessionId();
	await prisma.session.create({
		data: {
			id: sid,
			userId,
			userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : null,
			expiresAt: new Date(Date.now() + S.ttlMs),
		},
	});
	setSessionCookies(res, userId, sid);
	return sid;
}

/**
 * A used session slides: a fresh cookie once a day, and the last-seen time /
 * expiry are moved at most every few minutes (no write per request).
 */
export function touchSession(session, payload, res) {
	const now = Date.now();
	if (res && payload?.iat && now - payload.iat * 1000 > S.renewAfterMs) {
		setSessionCookies(res, session.userId, session.id);
	}
	if (now - new Date(session.lastSeenAt).getTime() > S.touchAfterMs) {
		prisma.session
			.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + S.ttlMs) } })
			.catch((e) => log.warn("session touch failed", e?.message || e));
	}
}

async function _revoke(where, push) {
	const rows = await prisma.session.findMany({ where: { ...where, revokedAt: null }, select: { id: true, userId: true } });
	const ids = rows.map((r) => r.id);
	if (ids.length > 0) {
		await prisma.session.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
	}
	// the devices signed out stop getting notifications too
	if (ids.length > 0 || push) {
		await prisma.pushSubscription.deleteMany({ where: push ? push(ids) : { sessionId: { in: ids } } }).catch((e) =>
			log.warn("removing push subscriptions failed", e?.message || e),
		);
	}
	for (const r of rows) bus.emit("session:revoked", { sid: r.id, userId: r.userId });
	return rows.length;
}

/** Signs one device out. */
export function revokeSession(sid) {
	return _revoke({ id: sid });
}

/**
 * Signs out every device of the user except `keepSid`. Push subscriptions
 * that belong to no session (made before sessions existed) go as well.
 */
export function revokeOtherSessions(userId, keepSid) {
	return _revoke({ userId, NOT: { id: keepSid } }, (ids) => ({
		userId,
		OR: [{ sessionId: null }, { sessionId: { in: ids } }],
	}));
}

/** Signs out every device of the user (password reset, account deletion). */
export function revokeAllSessions(userId) {
	return _revoke({ userId }, () => ({ userId }));
}

export async function listSessions(userId) {
	return prisma.session.findMany({
		where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
		orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
		select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true },
	});
}

/** Old rows are not needed: remove revoked / expired sessions after a month. */
export async function cleanupSessions() {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	try {
		await prisma.session.deleteMany({
			where: { OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
		});
	} catch (e) {
		log.warn("session cleanup failed", e?.message || e);
	}
}

/** Session of a request, when signed in (no response written). */
export async function sessionOfRequest(req) {
	const payload = readToken(tokenFromRequest(req));
	if (!payload) return null;
	try {
		return await loadSession(payload);
	} catch {
		return null;
	}
}
