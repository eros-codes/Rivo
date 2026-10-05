// Rivo's service worker: push notifications (and opening the chat they are
// about), and the chat's own files kept on the device so it starts fast and
// still opens without a connection.
/// <reference lib="WebWorker" />
export {};

declare const self: ServiceWorkerGlobalScope;
/** changes with every build (set by the build) */
declare const __SW_VERSION__: string;
/** the chat page's scripts and styles (set by the build) */
declare const __SHELL_ASSETS__: string[];

const SHELL_CACHE = `rivo-shell-${__SW_VERSION__}`;
const FONT_CACHE = "rivo-fonts-v1";
const CHAT_PAGE = "/chat/";
const ICON = "/assets/icons/Icon-192.png";

// ─── Install and update ───────────────────────────────────────────────────

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			// best effort: notifications must work even if keeping the files fails
			const cache = await caches.open(SHELL_CACHE);
			await cache.addAll(__SHELL_ASSETS__).catch(() => undefined);
			await cache.add(new Request(CHAT_PAGE, { cache: "reload" })).catch(() => undefined);
			// a new version takes over right away (its files are all cached)
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(names.filter((n) => n.startsWith("rivo-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)));
			await self.clients.claim();
		})(),
	);
});

// ─── Requests ─────────────────────────────────────────────────────────────

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
	const cache = await caches.open(cacheName);
	const hit = await cache.match(request);
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok && res.type === "basic") await cache.put(request, res.clone()).catch(() => undefined);
	return res;
}

/** The chat page: always the newest from the server, the kept copy only without a connection. */
async function chatPage(request: Request): Promise<Response> {
	try {
		const res = await fetch(request);
		if (res.ok && res.type === "basic" && !res.redirected) {
			const cache = await caches.open(SHELL_CACHE);
			await cache.put(CHAT_PAGE, res.clone()).catch(() => undefined);
		}
		return res;
	} catch (e) {
		const kept = await caches.match(CHAT_PAGE);
		if (kept) return kept;
		throw e;
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (request.mode === "navigate" && url.pathname === CHAT_PAGE) {
		event.respondWith(chatPage(request));
		return;
	}
	// built files never change under the same name
	if (url.pathname.startsWith("/app/")) {
		event.respondWith(cacheFirst(request, SHELL_CACHE));
		return;
	}
	if (url.pathname.startsWith("/assets/fonts/")) {
		event.respondWith(cacheFirst(request, FONT_CACHE));
	}
	// everything else (the API, pictures, other pages) goes to the network as usual
});

// ─── Notifications ────────────────────────────────────────────────────────

interface PushPayload {
	title?: unknown;
	body?: unknown;
	tag?: unknown;
	data?: { conversationId?: unknown; messageId?: unknown; url?: unknown };
}

self.addEventListener("push", (event) => {
	let payload: PushPayload = {};
	try {
		const parsed: unknown = event.data?.json();
		if (parsed && typeof parsed === "object") payload = parsed as PushPayload;
	} catch {
		payload = { title: "Rivo", body: event.data?.text() ?? "" };
	}
	const data = payload.data && typeof payload.data === "object" ? payload.data : {};
	const tag = typeof payload.tag === "string" ? payload.tag : data.conversationId ? `conversation-${String(data.conversationId)}` : "";
	const options: NotificationOptions & { renotify?: boolean } = {
		body: typeof payload.body === "string" ? payload.body : "",
		icon: ICON,
		badge: ICON,
		data,
	};
	// one notification per chat: a new message replaces it and still alerts
	if (tag) {
		options.tag = tag;
		options.renotify = true;
	}
	event.waitUntil(self.registration.showNotification(typeof payload.title === "string" && payload.title ? payload.title : "Rivo", options));
});

const positive = (v: unknown): string | null => {
	const n = Number(v);
	return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
};

/** Only pages of this site can be opened from a notification. */
function targetUrl(data: PushPayload["data"]): string {
	const conversationId = positive(data?.conversationId);
	const messageId = positive(data?.messageId);
	const url = new URL(CHAT_PAGE, self.location.origin);
	if (conversationId) url.searchParams.set("conversationId", conversationId);
	if (conversationId && messageId) url.searchParams.set("messageId", messageId);
	return url.href;
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = (event.notification.data ?? {}) as PushPayload["data"];
	const target = targetUrl(data);
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			// the chat is open: bring it forward, it opens the chat itself
			const chat = windows.find((c) => {
				try {
					return new URL(c.url).pathname === CHAT_PAGE;
				} catch {
					return false;
				}
			});
			if (chat) {
				await chat.focus().catch(() => undefined);
				chat.postMessage({ type: "push:click", payload: { conversationId: positive(data?.conversationId), messageId: positive(data?.messageId) } });
				return;
			}
			// another page of the site (landing, sign-in): take it to the chat
			const other = windows.find((c) => "navigate" in c);
			if (other) {
				const moved = await other.navigate(target).catch(() => null);
				if (moved) {
					await moved.focus().catch(() => undefined);
					return;
				}
			}
			await self.clients.openWindow(target);
		})(),
	);
});
