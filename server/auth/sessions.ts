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
import type { Prisma } from "@prisma/client";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { bus } from "../events.ts";
import { log } from "../utils/logger.ts";
import { messageOf } from "../utils/errors.ts";

const { session: S } = config;

/** What the session cookie's token says: the user, the session (device), when it was issued. */
export interface TokenPayload {
	uid: number;
	sid: string;
	/** seconds since 1970 */
	iat?: number;
}

// (only what this module uses of Express's request and response)
export interface CookieOptions {
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "lax" | "strict" | "none";
	path?: string;
	maxAge?: number;
}
export interface CookieResponse {
	cookie(name: string, value: string, options: CookieOptions): unknown;
	clearCookie(name: string, options?: CookieOptions): unknown;
}
export interface CookieRequest {
	cookies?: Record<string, string | undefined>;
}

export function newSessionId(): string {
	return crypto.randomBytes(18).toString("base64url");
}

export function csrfFor(sid: string): string {
	return crypto.createHmac("sha256", config.jwtSecret).update(`csrf:${sid}`).digest("base64url");
}

export function safeEqual(a: unknown, b: unknown): boolean {
	const x = Buffer.from(String(a || ""));
	const y = Buffer.from(String(b || ""));
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Cookie header → { name: value } */
export function parseCookies(header: unknown): Record<string, string> {
	const out: Record<string, string> = {};
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

function cookieOptions(httpOnly: boolean): CookieOptions {
	return { httpOnly, secure: config.isProd, sameSite: "lax", path: "/", maxAge: S.ttlMs };
}

export function setSessionCookies(res: CookieResponse, userId: number, sid: string): void {
	const token = jwt.sign({ uid: userId, sid }, config.jwtSecret, {
		algorithm: "HS256",
		expiresIn: Math.floor(S.ttlMs / 1000),
	});
	res.cookie(S.cookie, token, cookieOptions(true));
	res.cookie(S.csrfCookie, csrfFor(sid), cookieOptions(false));
}

export function clearSessionCookies(res: CookieResponse): void {
	const base: CookieOptions = { path: "/", secure: config.isProd, sameSite: "lax" };
	res.clearCookie(S.cookie, { ...base, httpOnly: true });
	res.clearCookie(S.csrfCookie, base);
}

/** The verified token payload { uid, sid, iat }, or null. */
export function readToken(token: unknown): TokenPayload | null {
	if (!token || typeof token !== "string") return null;
	try {
		const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
		// (a token whose payload is a plain string has neither field)
		if (!p || typeof p !== "object" || typeof p.sid !== "string" || !Number.isInteger(p.uid)) return null;
		return p as TokenPayload;
	} catch {
		return null;
	}
}

export function tokenFromRequest(req: CookieRequest): string | null {
	return req.cookies?.[S.cookie] || null;
}

/**
 * The session a token belongs to, when it is still valid:
 * not revoked, not expired, its account not deleted.
 * Database errors are thrown (the caller answers 503, not 401).
 */
export async function loadSession(payload: TokenPayload | null) {
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

export async function startSession(res: CookieResponse, userId: number, userAgent: unknown): Promise<string> {
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
/** A valid session, as loadSession returns it. */
export type LiveSession = NonNullable<Awaited<ReturnType<typeof loadSession>>>;

export function touchSession(session: Pick<LiveSession, "id" | "userId" | "lastSeenAt">, payload: TokenPayload | null, res?: CookieResponse | null): void {
	const now = Date.now();
	if (res && payload?.iat && now - payload.iat * 1000 > S.renewAfterMs) {
		setSessionCookies(res, session.userId, session.id);
	}
	if (now - new Date(session.lastSeenAt).getTime() > S.touchAfterMs) {
		prisma.session
			.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + S.ttlMs) } })
			.catch((e: unknown) => log.warn("session touch failed", messageOf(e) || e));
	}
}

async function _revoke(where: Prisma.SessionWhereInput, push?: (ids: string[]) => Prisma.PushSubscriptionWhereInput): Promise<number> {
	const rows = await prisma.session.findMany({ where: { ...where, revokedAt: null }, select: { id: true, userId: true } });
	const ids = rows.map((r) => r.id);
	if (ids.length > 0) {
		await prisma.session.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
	}
	// the devices signed out stop getting notifications too
	if (ids.length > 0 || push) {
		await prisma.pushSubscription.deleteMany({ where: push ? push(ids) : { sessionId: { in: ids } } }).catch((e: unknown) =>
			log.warn("removing push subscriptions failed", messageOf(e) || e),
		);
	}
	for (const r of rows) bus.emit("session:revoked", { sid: r.id, userId: r.userId });
	return rows.length;
}

/** Signs one device out. */
export function revokeSession(sid: string): Promise<number> {
	return _revoke({ id: sid });
}

/** Signs out every device of the user except `keepSid`. */
export function revokeOtherSessions(userId: number, keepSid: string): Promise<number> {
	return _revoke({ userId, NOT: { id: keepSid } });
}

/** Signs out every device of the user (password reset, account deletion). */
export function revokeAllSessions(userId: number): Promise<number> {
	return _revoke({ userId }, () => ({ userId }));
}

export async function listSessions(userId: number) {
	return prisma.session.findMany({
		where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
		orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
		select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true },
	});
}

/** Old rows are not needed: remove revoked / expired sessions after a month. */
export async function cleanupSessions(): Promise<void> {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	try {
		await prisma.session.deleteMany({
			where: { OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
		});
	} catch (e) {
		log.warn("session cleanup failed", messageOf(e) || e);
	}
}

/** Session of a request, when signed in (no response written). */
export async function sessionOfRequest(req: CookieRequest): Promise<LiveSession | null> {
	const payload = readToken(tokenFromRequest(req));
	if (!payload) return null;
	try {
		return await loadSession(payload);
	} catch {
		return null;
	}
}
