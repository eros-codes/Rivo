// The service worker and push notifications for this device.
import { pushApi } from "../../shared/api/endpoints";
import { createStore } from "../../shared/lib/store";

export type PushState = "unsupported" | "blocked" | "off" | "on" | "working";

export const pushState = createStore<{ state: PushState }>({ state: "off" });

function supported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded);
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
	const current = sub.options?.applicationServerKey;
	if (!current) return true; // older browsers do not say: keep it
	const a = new Uint8Array(current);
	return a.length === key.length && a.every((v, i) => v === key[i]);
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the service worker (offline start and notifications). */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
	if (!("serviceWorker" in navigator) || !window.isSecureContext) return Promise.resolve(null);
	registration ??= navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch((e) => {
		console.warn("service worker registration failed", e);
		return null;
	});
	return registration;
}

async function refreshState(): Promise<void> {
	if (!supported()) return pushState.set({ state: "unsupported" });
	if (Notification.permission === "denied") return pushState.set({ state: "blocked" });
	const reg = await registerServiceWorker();
	const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
	pushState.set({ state: sub && Notification.permission === "granted" ? "on" : "off" });
}

/**
 * Makes sure this device is subscribed with the server's current key and
 * the server knows it (it may have been made for another account). Asks for
 * permission only when `ask` (it must come from a tap).
 */
export async function enablePush(ask: boolean): Promise<PushState> {
	if (!supported()) {
		pushState.set({ state: "unsupported" });
		return "unsupported";
	}
	if (Notification.permission === "denied") {
		pushState.set({ state: "blocked" });
		return "blocked";
	}
	if (Notification.permission === "default") {
		if (!ask) {
			pushState.set({ state: "off" });
			return "off";
		}
		const answer = await Notification.requestPermission().catch(() => "default" as NotificationPermission);
		if (answer !== "granted") {
			const s: PushState = answer === "denied" ? "blocked" : "off";
			pushState.set({ state: s });
			return s;
		}
	}
	pushState.set({ state: "working" });
	try {
		const reg = await registerServiceWorker();
		if (!reg) throw new Error("no service worker");
		await navigator.serviceWorker.ready;
		const { publicKey } = await pushApi.publicKey();
		const key = keyBytes(publicKey);
		let sub = await reg.pushManager.getSubscription();
		if (sub && !sameKey(sub, key)) {
			// made with an older key: it would never receive anything
			await sub.unsubscribe().catch(() => false);
			sub = null;
		}
		sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		await pushApi.subscribe(sub.toJSON());
		pushState.set({ state: "on" });
		return "on";
	} catch (e) {
		console.warn("push subscription failed", e);
		await refreshState().catch(() => pushState.set({ state: "off" }));
		return pushState.get().state;
	}
}

/** This browser's push address (the server stops only its notifications on logout). */
export async function currentEndpoint(): Promise<string | null> {
	if (!supported()) return null;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager.getSubscription();
		return sub?.endpoint ?? null;
	} catch {
		return null;
	}
}

/** Stops notifications on this device. `notifyServer: false` once the session is gone. */
export async function disablePush(notifyServer = true): Promise<void> {
	if (!supported()) return;
	try {
		// getRegistration, not .ready: .ready never settles without a worker
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager.getSubscription();
		if (sub) {
			if (notifyServer) await pushApi.unsubscribe(sub.endpoint).catch(() => undefined);
			await sub.unsubscribe().catch(() => false);
		}
	} finally {
		await refreshState().catch(() => undefined);
	}
}

/** Resolves with `fallback` if `p` takes longer than `ms` (logout must never hang). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([p, new Promise<T>((r) => window.setTimeout(() => r(fallback), ms))]);
}

export function initPush(): void {
	void refreshState().then(() => {
		// already allowed: keep the subscription current without asking
		if (supported() && Notification.permission === "granted") void enablePush(false);
	});
}
