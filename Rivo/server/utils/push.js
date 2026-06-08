import webpush from "web-push";
import prisma from "../prisma.js";

let VAPID_PUBLIC = process.env.VAPID_PUBLIC || null;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE || null;
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:admin@example.com";

let pushEnabled = true;

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
	if (process.env.NODE_ENV === "production") {
		console.error("VAPID keys missing in production; disabling push notifications.");
		pushEnabled = false;
	} else {
		try {
			const keys = webpush.generateVAPIDKeys();
			VAPID_PUBLIC = keys.publicKey;
			VAPID_PRIVATE = keys.privateKey;
			console.warn("Generated ephemeral VAPID keys for development. These are not persisted and should not be used in production.");
		} catch (e) {
			console.error("Failed to generate ephemeral VAPID keys:", e);
			pushEnabled = false;
		}
	}
}

if (pushEnabled) {
	try {
		webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
	} catch (e) {
		console.error("Failed to set VAPID details; disabling push.", e);
		pushEnabled = false;
	}
}

export function getPublicKey() {
	return pushEnabled ? VAPID_PUBLIC : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function addSubscription(userId, sub) {
	if (!pushEnabled) return false;
	if (!userId || !sub || !sub.endpoint || typeof sub.endpoint !== "string") return false;
	if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return false;
	try {
		await prisma.pushSubscription.upsert({
			where: { endpoint: sub.endpoint },
			update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, active: true, lastUsed: new Date() },
			create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, active: true },
		});
		return true;
	} catch (e) {
		console.error('addSubscription failed', e);
		return false;
	}
}

export async function removeSubscriptionByEndpoint(userId, endpoint) {
	if (!endpoint) return false;
	try {
		await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
		return true;
	} catch (e) {
		console.error('removeSubscriptionByEndpoint failed', e);
		return false;
	}
}

export async function removeAllSubscriptions(userId) {
	if (!userId) return false;
	try {
		await prisma.pushSubscription.deleteMany({ where: { userId } });
		return true;
	} catch (e) {
		console.error('removeAllSubscriptions failed', e);
		return false;
	}
}

async function sendOneWithRetries(subRow, payload) {
	const sub = { endpoint: subRow.endpoint, keys: { p256dh: subRow.p256dh, auth: subRow.auth } };
	const maxAttempts = 3;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await webpush.sendNotification(sub, JSON.stringify(payload));
			// update lastUsed (best-effort)
			prisma.pushSubscription
				.update({ where: { endpoint: subRow.endpoint }, data: { lastUsed: new Date() } })
				.catch(() => {});
			return true;
		} catch (err) {
			const status = err && err.statusCode;
			if (status === 404 || status === 410) {
				// expired or gone; remove from DB
				try {
					await prisma.pushSubscription.deleteMany({ where: { endpoint: subRow.endpoint } });
				} catch (e) {
					/* ignore */
				}
				return false;
			}
			if (status === 429 || status === 502 || status === 503 || status === 504 || (status >= 500 && status < 600)) {
				const delay = 500 * Math.pow(2, attempt - 1);
				console.warn(`push transient error to ${subRow.endpoint} (status=${status}) attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
				await sleep(delay);
				continue;
			}
			console.warn(`push failed to ${subRow.endpoint} (status=${status}): ${err && err.message}`);
			return false;
		}
	}
	console.warn(`push: giving up after ${maxAttempts} attempts for ${subRow.endpoint}`);
	return false;
}

export async function sendNotificationToUser(userId, payload) {
	if (!pushEnabled) return { sent: 0 };
	if (!userId) return { sent: 0 };
	try {
		const rows = await prisma.pushSubscription.findMany({ where: { userId, active: true }, select: { endpoint: true, p256dh: true, auth: true } });
		if (!rows || rows.length === 0) return { sent: 0 };

		const concurrency = parseInt(process.env.PUSH_SEND_CONCURRENCY || "8", 10) || 8;
		let sent = 0;

		// simple pool: process in batches of size `concurrency`
		for (let i = 0; i < rows.length; i += concurrency) {
			const batch = rows.slice(i, i + concurrency);
			const promises = batch.map((r) => sendOneWithRetries(r, payload).catch((e) => { console.error('push send error', e); return false; }));
			const results = await Promise.all(promises);
			sent += results.filter(Boolean).length;
		}

		return { sent };
	} catch (e) {
		console.error('sendNotificationToUser failed', e);
		return { sent: 0 };
	}
}

export default {
	getPublicKey,
	addSubscription,
	removeSubscriptionByEndpoint,
	sendNotificationToUser,
	removeAllSubscriptions,
};
