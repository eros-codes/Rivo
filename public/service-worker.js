/* Rivo service worker: shows push notifications and opens the chat they are about. */

const ICON = "/assets/icons/Icon-192.png";
const APP_PATH = "/chat/main.html";

// A new version takes over right away instead of waiting for every tab to close
self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let payload = {};
	try {
		payload = event.data ? event.data.json() : {};
	} catch (e) {
		payload = { title: "Rivo", body: event.data ? event.data.text() : "" };
	}
	if (!payload || typeof payload !== "object") payload = {};

	const data = payload.data && typeof payload.data === "object" ? payload.data : {};
	const tag =
		payload.tag || (data.conversationId ? `conversation-${data.conversationId}` : "");
	const options = {
		body: typeof payload.body === "string" ? payload.body : "",
		icon: payload.icon || ICON,
		badge: payload.badge || ICON,
		data,
	};
	// One notification per chat: a new message replaces the previous one and
	// still alerts the user
	if (tag) {
		options.tag = tag;
		options.renotify = true;
	}

	event.waitUntil(
		self.registration.showNotification(payload.title || "Rivo", options),
	);
});

// Only pages of this site may be opened from a notification
function safeUrl(data) {
	try {
		let path = APP_PATH;
		if (data && typeof data.url === "string" && data.url) {
			path = data.url;
		} else if (data && data.conversationId) {
			path = `${APP_PATH}?conversationId=${encodeURIComponent(String(data.conversationId))}`;
			if (data.messageId) path += `&messageId=${encodeURIComponent(String(data.messageId))}`;
		}
		const url = new URL(path, self.location.origin);
		if (url.origin !== self.location.origin) return new URL(APP_PATH, self.location.origin).href;
		return url.href;
	} catch (e) {
		return new URL(APP_PATH, self.location.origin).href;
	}
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const target = safeUrl(data);

	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			// The chat page is already open: bring it forward and let it open the chat
			const chat = windows.find((c) => {
				try {
					return new URL(c.url).pathname === APP_PATH;
				} catch (e) {
					return false;
				}
			});
			if (chat) {
				try {
					await chat.focus();
				} catch (e) {
					/* focusing can be refused; the message still opens the chat */
				}
				try {
					chat.postMessage({ type: "push:click", payload: data });
				} catch (e) {
					/* ignore */
				}
				return;
			}
			// Another page of the site (landing, sign-in): take it to the chat
			const other = windows.find((c) => "navigate" in c);
			if (other) {
				try {
					const navigated = await other.navigate(target);
					if (navigated) {
						await navigated.focus();
						return;
					}
				} catch (e) {
					/* fall back to a new window */
				}
			}
			if (self.clients.openWindow) await self.clients.openWindow(target);
		})(),
	);
});
