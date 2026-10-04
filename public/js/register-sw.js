function urlBase64ToUint8Array(base64String) {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}

function csrfToken() {
	const m = document.cookie.match(/(?:^|; )csrfToken=([^;]+)/);
	return m ? decodeURIComponent(m[1]) : '';
}

function pushSupported() {
	return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Same bytes as the server's current VAPID key?
function sameKey(subscription, keyBytes) {
	try {
		const current = subscription && subscription.options && subscription.options.applicationServerKey;
		if (!current) return true; // unknown (older browsers): keep it
		const a = new Uint8Array(current);
		if (a.length !== keyBytes.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== keyBytes[i]) return false;
		return true;
	} catch (e) {
		return true;
	}
}

async function saveSubscription(sub) {
	try {
		await fetch('/api/push/subscribe', {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
			body: JSON.stringify(sub),
		});
	} catch (e) {
		// ignore: tried again on the next visit
	}
}

async function registerPush() {
	if (!pushSupported()) return;

	// Only signed-in users get notifications
	try {
		const me = await fetch('/api/users/me', { credentials: 'include' });
		if (!me.ok) return;
	} catch (e) {
		return;
	}

	try {
		const reg = await navigator.serviceWorker.register('/service-worker.js');
		await navigator.serviceWorker.ready;

		// The server's key: a subscription made with another key never
		// receives anything, so it is replaced
		const pkRes = await fetch('/api/push/publicKey');
		if (!pkRes.ok) return;
		const { publicKey } = await pkRes.json();
		if (!publicKey) return;
		const applicationServerKey = urlBase64ToUint8Array(publicKey);

		const existing = await reg.pushManager.getSubscription();
		if (existing) {
			if (sameKey(existing, applicationServerKey)) {
				// make sure the server has it (it may belong to another account
				// that used this browser before)
				await saveSubscription(existing);
				return;
			}
			try {
				await existing.unsubscribe();
			} catch (e) {
				/* ignore */
			}
		}

		// Ask for notification permission softly
		if (Notification.permission === 'default') {
			try {
				const p = await Notification.requestPermission();
				if (p !== 'granted') return;
			} catch (e) {
				return;
			}
		} else if (Notification.permission !== 'granted') {
			return;
		}

		const sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		});
		await saveSubscription(sub);
	} catch (e) {
		// registerPush failed (suppressed)
	}
}

// This browser's push endpoint (the server stops only its notifications on logout)
async function currentPushEndpoint() {
	if (!pushSupported()) return null;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		if (!reg || !reg.pushManager) return null;
		const sub = await reg.pushManager.getSubscription();
		return sub ? sub.endpoint : null;
	} catch (e) {
		return null;
	}
}

// `notifyServer: false` when the session is already gone (after logout)
async function unsubscribePush({ notifyServer = true } = {}) {
	if (!pushSupported()) return;
	try {
		// getRegistration() (not .ready): `.ready` never resolves when no service
		// worker was registered, which used to freeze the logout button
		const reg = await navigator.serviceWorker.getRegistration();
		if (!reg || !reg.pushManager) return;
		const sub = await reg.pushManager.getSubscription();
		if (!sub) return;
		if (notifyServer) {
			try {
				await fetch('/api/push/unsubscribe', {
					method: 'POST',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
					body: JSON.stringify({ endpoint: sub.endpoint }),
				});
			} catch (e) {
				// ignore server errors
			}
		}
		try {
			await sub.unsubscribe();
		} catch (e) {
			/* ignore */
		}
	} catch (e) {
		// unsubscribePush failed (suppressed)
	}
}

// Exposed so the app can handle push around logout
if (typeof window !== 'undefined') {
	window.pushRegister = registerPush;
	window.pushUnsubscribe = unsubscribePush;
	window.pushEndpoint = currentPushEndpoint;
	const start = () => {
		// Delay to avoid intrusive prompt on page load
		setTimeout(() => {
			registerPush();
		}, 2000);
	};
	if (document.readyState === 'complete') start();
	else window.addEventListener('load', start);
}
