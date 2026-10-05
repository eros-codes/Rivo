import webpush from "web-push";
import prisma from "../prisma.ts";
import { log } from "./logger.ts";
import { messageOf } from "./errors.ts";

/** What a notification carries (the service worker shows it). */
export interface PushPayload {
	title: string;
	body: string;
	data?: Record<string, unknown>;
	tag?: string;
	[key: string]: unknown;
}

let VAPID_PUBLIC: string | null = process.env.VAPID_PUBLIC || null;
let VAPID_PRIVATE: string | null = process.env.VAPID_PRIVATE || null;
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:admin@example.com";

let pushEnabled = true;

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
	if (process.env.NODE_ENV === "production") {
		log.error("VAPID keys missing in production; disabling push notifications.");
		pushEnabled = false;
	} else {
		try {
			const keys = webpush.generateVAPIDKeys();
			VAPID_PUBLIC = keys.publicKey;
			VAPID_PRIVATE = keys.privateKey;
			log.warn("Generated ephemeral VAPID keys for development. These are not persisted and should not be used in production.");
		} catch (e) {
			log.error("Failed to generate ephemeral VAPID keys:", e);
			pushEnabled = false;
		}
	}
}

if (pushEnabled) {
	try {
		// (both are set here: generated above when they were missing)
		webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC as string, VAPID_PRIVATE as string);
	} catch (e) {
		log.error("Failed to set VAPID details; disabling push.", e);
		pushEnabled = false;
	}
}

export function getPublicKey(): string | null {
	return pushEnabled ? VAPID_PUBLIC : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Chat notifications are only useful for a while, and they should wake a
// sleeping phone, so ask the push service for prompt delivery.
const PUSH_TTL_SECONDS = parseInt(process.env.PUSH_TTL_SECONDS || "86400", 10) || 86400;

// The push services of the browsers people use. A subscription can only point
// at one of these: the server sends a request to whatever address is stored,
// so anything else would let a user make the server call arbitrary hosts
// (including ones inside its own network). PUSH_ALLOWED_HOSTS adds more.
const PUSH_HOSTS = [
	"fcm.googleapis.com", // Chrome, Edge on Android, Opera, Samsung Internet
	"android.googleapis.com",
	"push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
	"push.apple.com", // Safari (web.push.apple.com)
	"notify.windows.com", // Edge on Windows (*.notify.windows.com)
	...String(process.env.PUSH_ALLOWED_HOSTS || "")
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean),
];
const MAX_PER_USER = parseInt(process.env.PUSH_MAX_PER_USER || "20", 10) || 20;

/** A real browser push service address (https, a known host, default port). */
export function isPushEndpoint(endpoint: unknown): boolean {
	if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
	const host = url.hostname.toLowerCase();
	return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** What a browser sends as its subscription (checked before use). */
interface SubscriptionInput {
	endpoint?: unknown;
	keys?: { p256dh?: unknown; auth?: unknown } | null;
}

export async function addSubscription(userId: number, input: unknown, sessionId: string | null = null): Promise<boolean> {
	if (!pushEnabled) return false;
	const sub = input as SubscriptionInput | null | undefined;
	if (!userId || !sub || !isPushEndpoint(sub.endpoint)) return false;
	if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return false;
	if (sub.keys.p256dh.length > 256 || sub.keys.auth.length > 256) return false;
	const endpoint = sub.endpoint as string;
	const keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
	try {
		// the same browser may have been used by another account before: the
		// subscription follows whoever is signed in on it now
		await prisma.pushSubscription.upsert({
			where: { endpoint },
			update: { userId, sessionId, p256dh: keys.p256dh, auth: keys.auth, active: true, lastUsed: new Date() },
			create: { userId, sessionId, endpoint, p256dh: keys.p256dh, auth: keys.auth, active: true, lastUsed: new Date() },
		});
		// one browser (session) has one subscription: an older one it replaced goes
		if (sessionId) await prisma.pushSubscription.deleteMany({ where: { sessionId, endpoint: { not: endpoint } } });
		// and an account has a bounded number of them (the least recently used go first)
		const extra = await prisma.pushSubscription.findMany({
			where: { userId },
			orderBy: [{ lastUsed: { sort: "desc", nulls: "last" } }, { id: "desc" }],
			skip: MAX_PER_USER,
			select: { id: true },
		});
		if (extra.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: extra.map((r) => r.id) } } });
		return true;
	} catch (e) {
		log.error('addSubscription failed', e);
		return false;
	}
}

export async function removeSubscriptionByEndpoint(userId: number, endpoint: string | null | undefined): Promise<boolean> {
	if (!endpoint) return false;
	try {
		await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
		return true;
	} catch (e) {
		log.error('removeSubscriptionByEndpoint failed', e);
		return false;
	}
}

export async function removeAllSubscriptions(userId: number): Promise<boolean> {
	if (!userId) return false;
	try {
		await prisma.pushSubscription.deleteMany({ where: { userId } });
		return true;
	} catch (e) {
		log.error('removeAllSubscriptions failed', e);
		return false;
	}
}

interface SubscriptionRow {
	endpoint: string;
	p256dh: string;
	auth: string;
}

async function sendOneWithRetries(subRow: SubscriptionRow, payload: PushPayload): Promise<boolean> {
	const sub = { endpoint: subRow.endpoint, keys: { p256dh: subRow.p256dh, auth: subRow.auth } };
	const maxAttempts = 3;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: PUSH_TTL_SECONDS, urgency: "high" });
			// update lastUsed (best-effort)
			prisma.pushSubscription
				.update({ where: { endpoint: subRow.endpoint }, data: { lastUsed: new Date() } })
				.catch(() => {});
			return true;
		} catch (err) {
			const code = err !== null && typeof err === "object" ? (err as { statusCode?: unknown }).statusCode : undefined;
			const status = typeof code === "number" ? code : undefined;
			// 404/410: the subscription expired. 400/401/403: it was created with
			// another VAPID key (e.g. dev keys regenerated on restart) or is
			// otherwise invalid; the browser subscribes again on its next visit.
			if (status === 400 || status === 401 || status === 403 || status === 404 || status === 410) {
				try {
					await prisma.pushSubscription.deleteMany({ where: { endpoint: subRow.endpoint } });
				} catch (e) {
					/* ignore */
				}
				return false;
			}
			if (status !== undefined && (status === 429 || (status >= 500 && status < 600))) {
				const delay = 500 * Math.pow(2, attempt - 1);
				log.warn(`push transient error to ${subRow.endpoint} (status=${status}) attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
				await sleep(delay);
				continue;
			}
			log.warn(`push failed to ${subRow.endpoint} (status=${status}): ${err && messageOf(err)}`);
			return false;
		}
	}
	log.warn(`push: giving up after ${maxAttempts} attempts for ${subRow.endpoint}`);
	return false;
}

export async function sendNotificationToUser(userId: number, payload: PushPayload): Promise<{ sent: number }> {
	if (!pushEnabled) return { sent: 0 };
	if (!userId) return { sent: 0 };
	try {
		const all = await prisma.pushSubscription.findMany({ where: { userId, active: true }, select: { endpoint: true, p256dh: true, auth: true } });
		// stored before the check existed and not a push service: never called
		const bad = (all || []).filter((r) => !isPushEndpoint(r.endpoint));
		if (bad.length) await prisma.pushSubscription.deleteMany({ where: { endpoint: { in: bad.map((r) => r.endpoint) } } }).catch(() => {});
		const rows = (all || []).filter((r) => isPushEndpoint(r.endpoint));
		if (rows.length === 0) return { sent: 0 };

		const concurrency = parseInt(process.env.PUSH_SEND_CONCURRENCY || "8", 10) || 8;
		let sent = 0;

		// simple pool: process in batches of size `concurrency`
		for (let i = 0; i < rows.length; i += concurrency) {
			const batch = rows.slice(i, i + concurrency);
			const promises = batch.map((r) => sendOneWithRetries(r, payload).catch((e) => { log.error('push send error', e); return false; }));
			const results = await Promise.all(promises);
			sent += results.filter(Boolean).length;
		}

		return { sent };
	} catch (e) {
		log.error('sendNotificationToUser failed', e);
		return { sent: 0 };
	}
}

export default {
	getPublicKey,
	isPushEndpoint,
	addSubscription,
	removeSubscriptionByEndpoint,
	sendNotificationToUser,
	removeAllSubscriptions,
};
