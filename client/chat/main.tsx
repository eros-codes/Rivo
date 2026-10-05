// The chat app starts here: who is signed in, the live connection, the
// first load of the chats, and the screen.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { usersApi } from "../shared/api/endpoints";
import { ApiError, setHeaderProvider, setUnauthorizedHandler } from "../shared/api/http";
import { keys, read, write } from "../shared/lib/storage";
import { applyStoredAppearance } from "../shared/lib/theme";
import { markAllStale } from "./state/chatModel";
import { getRow } from "./state/contactModel";
import { contacts, toasts, ui } from "./state/stores";
import { serverNow } from "./services/clock";
import { installEventHandlers } from "./services/events";
import { showToast } from "./services/feedback";
import { openChat } from "./services/navigation";
import { holdSends, requeueAfterReconnect } from "./services/outbox";
import { persistOutbox, restoreOutbox } from "./services/outboxStore";
import { enablePush, initPush, pushState, registerServiceWorker } from "./services/push";
import * as realtime from "./services/realtime";
import { SIGN_IN_PAGE, cachedMe, sessionEnded, setMe } from "./services/session";
import { catchUpPersistently, loadContactsUntilDone, loadPinned, refreshContacts } from "./services/sync";
import { clearAllTyping } from "./services/typing";
import { installExitFlush } from "./services/undo";
import { App } from "./ui/App";

// ─── Opening a chat from outside (a notification, a link) ─────────────────

interface ChatLink {
	conversationId: number;
	messageId: number | null;
}

function positiveInt(v: unknown): number | null {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** ?conversationId=…&messageId=… (removed from the address once read). */
function takeLinkFromUrl(): ChatLink | null {
	const params = new URLSearchParams(location.search);
	const conversationId = positiveInt(params.get("conversationId"));
	if (params.has("conversationId") || params.has("messageId")) history.replaceState(history.state, "", location.pathname);
	return conversationId ? { conversationId, messageId: positiveInt(params.get("messageId")) } : null;
}

let contactsReady = false;
let waitingLink: ChatLink | null = null;

function openLink(link: ChatLink): void {
	if (!contactsReady) {
		waitingLink = link;
		return;
	}
	if (getRow(link.conversationId)) openChat(link.conversationId, { focusMessageId: link.messageId });
	else showToast("This chat is no longer available", { icon: "error" });
}

function listenToServiceWorker(): void {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
		const data: unknown = e.data;
		if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "push:click") return;
		const payload = (data as { payload?: { conversationId?: unknown; messageId?: unknown } }).payload ?? {};
		const conversationId = positiveInt(payload.conversationId);
		if (conversationId) openLink({ conversationId, messageId: positiveInt(payload.messageId) });
	});
}

// ─── The phone keyboard ───────────────────────────────────────────────────

/**
 * The visible height as CSS variables, so the open chat fits above an
 * on-screen keyboard even where the browser does not resize the page for it
 * (Safari). Zooming in does not count.
 */
function trackViewport(): void {
	const vv = window.visualViewport;
	if (!vv) return;
	const root = document.documentElement.style;
	let frame = 0;
	const update = () => {
		frame = 0;
		if (Math.abs(vv.scale - 1) > 0.01) return;
		root.setProperty("--viewport-height", `${Math.round(vv.height)}px`);
		root.setProperty("--viewport-top", `${Math.round(vv.offsetTop)}px`);
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(update);
	};
	vv.addEventListener("resize", schedule);
	vv.addEventListener("scroll", schedule);
	update();
}

// ─── Notifications ────────────────────────────────────────────────────────

/** Asks once, gently, whether to turn on notifications (a tap must start it). */
function offerNotifications(): void {
	if (read(keys.notifyAsked) || !("Notification" in window) || Notification.permission !== "default") return;
	let tries = 0;
	const offer = () => {
		if (pushState.get().state !== "off" || Notification.permission !== "default") return;
		// another message on screen: a little later
		if (toasts.get().current || ui.get().dialog || ui.get().panel) {
			if (++tries < 10) window.setTimeout(offer, 5000);
			return;
		}
		write(keys.notifyAsked, "1");
		showToast("Get notified about new messages?", {
			icon: "bell",
			ms: 8000,
			action: {
				label: "Turn on",
				run: () => {
					void enablePush(true).then((r) => {
						if (r === "on") showToast("Notifications turned on", { icon: "bell" });
					});
				},
			},
		});
	};
	window.setTimeout(offer, 4000);
}

// ─── Start ────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
	applyStoredAppearance();
	trackViewport();

	setUnauthorizedHandler(() => void sessionEnded(true));
	setHeaderProvider((): Record<string, string> => {
		const id = realtime.socketId();
		// lets the server skip echoing a change back to the device that made it
		return id ? { "X-Socket-Id": id } : {};
	});

	// the copy kept on this device paints right away; the server's answer replaces it
	const cached = cachedMe();
	if (cached) setMe(cached);
	const fresh = usersApi.me().then(
		(me) => {
			setMe(me);
			return me;
		},
		(e: unknown) => {
			if (e instanceof ApiError && e.status === 401) return null;
			if (!cached) throw e;
			return cached;
		},
	);
	let me = cached;
	if (!me) {
		try {
			me = await fresh;
		} catch {
			// no copy on this device and no server: try again in a moment
			const root = document.getElementById("root");
			if (root) {
				const p = document.createElement("p");
				p.className = "boot-error";
				p.textContent = "Can't reach Rivo right now. Trying again…";
				root.replaceChildren(p);
			}
			window.setTimeout(() => location.reload(), 5000);
			return;
		}
	}
	if (!me) {
		window.location.replace(SIGN_IN_PAGE);
		return;
	}
	const userId = me.id;
	// A different account signed in on this browser (in another tab, or while
	// this one slept): this page starts over as that account. Nothing is sent
	// from the outbox until the server has confirmed who is signed in.
	const otherAccount = (m: { id: number } | null) => {
		if (!m || m.id === userId) return false;
		location.reload();
		return true;
	};
	const confirmed = (check: Promise<{ id: number } | null>): Promise<void> =>
		check.then(
			(m) => (otherAccount(m) ? new Promise<void>(() => undefined) : undefined),
			() => undefined,
		);
	holdSends(confirmed(fresh));
	window.addEventListener("storage", (e) => {
		if (e.key !== keys.user || !e.newValue) return;
		try {
			otherAccount(JSON.parse(e.newValue) as { id: number });
		} catch {
			/* not ours to read */
		}
	});

	restoreOutbox(userId);
	persistOutbox(userId);
	installEventHandlers();
	installExitFlush();
	listenToServiceWorker();
	const link = takeLinkFromUrl();

	realtime.connect({
		onConnect(first) {
			// (after a reconnect: the session may now be another account's)
			if (!first) holdSends(confirmed(usersApi.me()));
			const open = ui.get().openConvId;
			if (open !== null) realtime.send("conversation:join", { conversationId: open });
			requeueAfterReconnect();
			// what happened while there was no connection
			if (!first || contacts.get().loaded) void refreshContacts().catch(() => undefined);
			if (open !== null) {
				void catchUpPersistently(open);
				if (!first) void loadPinned(open).catch(() => undefined);
			}
		},
		onDisconnect() {
			// cached chats are brought up to date when opened again: from the
			// last time the server was heard from (a sleeping phone notices the
			// disconnect only when it wakes), with a margin for what was on the way
			markAllStale(serverNow(-realtime.silentForMs() - 30_000));
			clearAllTyping();
		},
		onSessionEnded(certain) {
			void sessionEnded(certain);
		},
	});

	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);

	void registerServiceWorker();
	initPush();

	try {
		await loadContactsUntilDone();
	} catch {
		// 401: the session is over (handled by the unauthorized handler)
		return;
	}
	contactsReady = true;
	const target = waitingLink ?? link;
	waitingLink = null;
	if (target) openLink(target);
	offerNotifications();
}

void start();
