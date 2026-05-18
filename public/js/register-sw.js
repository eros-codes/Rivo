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

async function registerPush() {
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
		// Push or ServiceWorker not supported (suppressed)
		return;
	}

	// Verify user is authenticated before attempting to subscribe
	try {
		const me = await fetch('/api/users/me', { credentials: 'include' });
		if (!me.ok) {
			// not authenticated — skip registration (suppressed)
			return;
		}
	} catch (e) {
		// Auth check failed; skipping push registration (suppressed)
		return;
	}

	// iOS detection (Safari on iOS) — recommend add to Home Screen for best reliability
	const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
	if (isIOS) {
		// iOS detected: no console output
	}

	try {
		// ensure an active registration
		const reg = await navigator.serviceWorker.register('/service-worker.js');
		await navigator.serviceWorker.ready;

		// If already subscribed, ensure server has the subscription (idempotent)
		let existing = await reg.pushManager.getSubscription();
		const csrf = document.cookie.match(/(?:^|; )csrfToken=([^;]+)/)?.[1] || '';
			if (existing) {
			try {
				await fetch('/api/push/subscribe', {
					method: 'POST',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
					body: JSON.stringify(existing),
				});
			} catch (e) {
				// ignore server errors here
			}
			// already subscribed (suppressed)
			return;
		}

		// Ask for notification permission softly
		if (Notification.permission === 'default') {
			try {
				const p = await Notification.requestPermission();
				if (p !== 'granted') {
					// permission not granted (suppressed)
					return;
				}
			} catch (e) {
				console.warn('Permission request failed', e);
				return;
			}
		} else if (Notification.permission !== 'granted') {
			// permission not granted (suppressed)
			return;
		}

		// Fetch VAPID public key from server
		const pkRes = await fetch('/api/push/publicKey');
		if (!pkRes.ok) {
			// failed to get VAPID public key (suppressed)
			return;
		}
		const { publicKey } = await pkRes.json();
		const applicationServerKey = urlBase64ToUint8Array(publicKey);

		// Subscribe
		const sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		});

		// Send subscription to server
		await fetch('/api/push/subscribe', {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
			body: JSON.stringify(sub),
		});

		// Push subscription saved (suppressed)
	} catch (e) {
		// registerPush failed (suppressed)
	}
}

async function unsubscribePush() {
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
	try {
		const reg = await navigator.serviceWorker.ready;
		const sub = await reg.pushManager.getSubscription();
		if (!sub) return;
		const csrf = document.cookie.match(/(?:^|; )csrfToken=([^;]+)/)?.[1] || '';
		// Inform server to remove subscription
		try {
			await fetch('/api/push/unsubscribe', {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
				body: JSON.stringify({ endpoint: sub.endpoint }),
			});
		} catch (e) {
			// ignore server errors
		}
		try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
		// Push unsubscribed (suppressed)
	} catch (e) {
		// unsubscribePush failed (suppressed)
	}
}

// Expose utility so app can unsubscribe before logout
if (typeof window !== 'undefined') {
	window.pushRegister = registerPush;
	window.pushUnsubscribe = unsubscribePush;
	window.addEventListener('load', () => {
		// Delay to avoid intrusive prompt on page load
		setTimeout(() => {
			registerPush();
		}, 2000);
	});
}
