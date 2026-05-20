import webpush from "web-push";

// In-memory subscription store: Map<userId, Array<subscription>>
const subs = new Map();

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

export function addSubscription(userId, sub) {
	if (!pushEnabled) {
		// Push disabled; ignoring subscription add.
		return false;
	}
	if (!userId || !sub || !sub.endpoint || typeof sub.endpoint !== "string") return false;
	// basic shape validation for keys
	if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return false;
	const arr = subs.get(userId) || [];
	// dedupe by endpoint
	if (!arr.find((s) => s.endpoint === sub.endpoint)) {
		// store a shallow clone to avoid retaining external references
		const copy = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
		arr.push(copy);
	}
	subs.set(userId, arr);
	return true;
}

export function removeSubscriptionByEndpoint(userId, endpoint) {
	const arr = subs.get(userId) || [];
	const filtered = arr.filter((s) => s.endpoint !== endpoint);
	if (filtered.length === 0) subs.delete(userId);
	else subs.set(userId, filtered);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function sendNotificationToUser(userId, payload) {
	if (!pushEnabled) return { sent: 0 };
	const arr = subs.get(userId) || [];
	if (!arr || arr.length === 0) return { sent: 0 };

	const results = [];
	// send sequentially to keep logs predictable and allow per-subscription retry/backoff
	for (const s of Array.from(arr)) {
		try {
			const success = await (async (sub) => {
				const maxAttempts = 3;
				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					try {
						await webpush.sendNotification(sub, JSON.stringify(payload));
						return true;
					} catch (err) {
						const status = err && err.statusCode;
						// Remove expired subscriptions (410) or gone (404)
						if (status === 404 || status === 410) {
							removeSubscriptionByEndpoint(userId, sub.endpoint);
							return false;
						}
						// Retry on transient server errors or rate limiting
						if (status === 429 || status === 502 || status === 503 || status === 504 || (status >= 500 && status < 600)) {
							const delay = 500 * Math.pow(2, attempt - 1);
							console.warn(`push transient error to ${sub.endpoint} (status=${status}) attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`);
							await sleep(delay);
							continue;
						}
						// Non-retriable error: log and drop
						console.warn(`push failed to ${sub.endpoint} (status=${status}): ${err && err.message}`);
						return false;
					}
				}
				console.warn(`push: giving up after ${maxAttempts} attempts for ${sub.endpoint}`);
				return false;
			})(s);
			results.push(success);
		} catch (e) {
			console.error("unexpected push send error", e);
			results.push(false);
		}
	}

	const sent = results.filter(Boolean).length;
	return { sent };
}

export function removeAllSubscriptions(userId) {
	if (!userId) return false;
	subs.delete(userId);
	return true;
}

export default {
	getPublicKey,
	addSubscription,
	removeSubscriptionByEndpoint,
	sendNotificationToUser,
	removeAllSubscriptions,
};
