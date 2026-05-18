import webpush from 'web-push';

// In-memory subscription store: Map<userId, Array<subscription>>
const subs = new Map();

let VAPID_PUBLIC = process.env.VAPID_PUBLIC || null;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE || null;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

let pushEnabled = true;

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
	if (process.env.NODE_ENV === 'production') {
		// VAPID keys missing in production; disable push
		pushEnabled = false;
	} else {
		// In development generate ephemeral keys but warn clearly
		try {
			const keys = webpush.generateVAPIDKeys();
			VAPID_PUBLIC = keys.publicKey;
			VAPID_PRIVATE = keys.privateKey;
			// Generated ephemeral VAPID keys for development (no console output)
		} catch (e) {
			// Failed to generate VAPID keys (suppressed)
			pushEnabled = false;
		}
	}
}

if (pushEnabled) {
	try {
		webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
	} catch (e) {
		// Failed to set VAPID details; disabling push (suppressed)
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
	if (!userId || !sub || !sub.endpoint) return false;
	const arr = subs.get(userId) || [];
	if (!arr.find((s) => s.endpoint === sub.endpoint)) arr.push(sub);
	subs.set(userId, arr);
	return true;
}

export function removeSubscriptionByEndpoint(userId, endpoint) {
	const arr = subs.get(userId) || [];
	const filtered = arr.filter((s) => s.endpoint !== endpoint);
	if (filtered.length === 0) subs.delete(userId);
	else subs.set(userId, filtered);
}

export async function sendNotificationToUser(userId, payload) {
	if (!pushEnabled) return { sent: 0 };
	const arr = subs.get(userId) || [];
	if (!arr || arr.length === 0) return { sent: 0 };
	let sent = 0;
	await Promise.all(
		arr.map(async (s) => {
			try {
				await webpush.sendNotification(s, JSON.stringify(payload));
				sent++;
			} catch (err) {
				// Remove expired subscriptions (410) or gone
				if (err && (err.statusCode === 404 || err.statusCode === 410)) {
					removeSubscriptionByEndpoint(userId, s.endpoint);
				}
			}
		}),
	);
	return { sent };
}

export default {
	getPublicKey,
	addSubscription,
	removeSubscriptionByEndpoint,
	sendNotificationToUser,
	removeAllSubscriptions,
};

export function removeAllSubscriptions(userId) {
	if (!userId) return false;
	subs.delete(userId);
	return true;
}
