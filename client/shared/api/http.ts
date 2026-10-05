// The one way the app talks HTTP to its server: JSON in and out, the session
// cookie sent along, and the CSRF header on every request that changes
// something.

/** An answer other than 2xx (or no answer at all: status 0). */
export class ApiError extends Error {
	readonly status: number;
	readonly data: unknown;
	constructor(status: number, message: string, data: unknown = null) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.data = data;
	}
	/** The request never reached the server (offline, connection dropped). */
	get isNetwork(): boolean {
		return this.status === 0;
	}
}

const CSRF_COOKIES = ["__Host-rivo_csrf", "rivo_csrf"];

/** The value the server expects in X-CSRF-Token (readable copy of a signed token). */
export function csrfToken(): string {
	if (typeof document === "undefined") return "";
	const cookies = document.cookie ? document.cookie.split(";") : [];
	for (const name of CSRF_COOKIES) {
		for (const part of cookies) {
			const eq = part.indexOf("=");
			if (eq < 0) continue;
			if (part.slice(0, eq).trim() === name) {
				try {
					return decodeURIComponent(part.slice(eq + 1).trim());
				} catch {
					return "";
				}
			}
		}
	}
	return "";
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
	/** JSON body, or FormData for uploads */
	body?: unknown;
	signal?: AbortSignal;
	/** survives the page being closed (used for the undo window) */
	keepalive?: boolean;
	headers?: Record<string, string>;
}

/** Called once when the server says the session is over (401). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
	onUnauthorized = fn;
}

/** Extra headers for every request (the app adds its socket id). */
let headerProvider: (() => Record<string, string>) | null = null;
export function setHeaderProvider(fn: (() => Record<string, string>) | null): void {
	headerProvider = fn;
}

export async function request<T>(method: Method, url: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = { Accept: "application/json", ...(headerProvider?.() ?? {}), ...opts.headers };
	let body: BodyInit | undefined;
	if (opts.body instanceof FormData) {
		body = opts.body;
	} else if (opts.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(opts.body);
	}
	if (method !== "GET") {
		const token = csrfToken();
		if (token) headers["X-CSRF-Token"] = token;
	}

	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers,
			body,
			credentials: "same-origin",
			signal: opts.signal,
			keepalive: opts.keepalive,
			cache: "no-store",
		});
	} catch (e) {
		if ((e as Error)?.name === "AbortError") throw e;
		throw new ApiError(0, "No connection");
	}

	const type = res.headers.get("content-type") || "";
	let data: unknown = null;
	if (type.includes("application/json")) {
		try {
			data = await res.json();
		} catch {
			data = null;
		}
	}
	if (!res.ok) {
		const message =
			data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
				? (data as { error: string }).error
				: res.statusText || "Request failed";
		if (res.status === 401) onUnauthorized?.();
		throw new ApiError(res.status, message, data);
	}
	return data as T;
}

export const http = {
	get: <T>(url: string, opts?: RequestOptions) => request<T>("GET", url, opts),
	post: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", url, { ...opts, body }),
	patch: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", url, { ...opts, body }),
	del: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>("DELETE", url, { ...opts, body }),
};

/** A message fit to show the user for any thrown value. */
export function errorText(e: unknown, fallback = "Something went wrong. Please try again."): string {
	if (e instanceof ApiError) {
		if (e.isNetwork) return "No connection. Check your internet and try again.";
		if (e.status === 429) return e.message && e.message !== "Too Many Requests" ? e.message : "Too many attempts. Please wait a moment.";
		if (e.status >= 500) return fallback;
		return e.message || fallback;
	}
	return fallback;
}
