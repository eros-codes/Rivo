// Settings read once from the environment, with their defaults. (Limits the
// app must know too, like a message's length, are not settings: they are in
// shared/limits.ts.)
import { readFileSync } from "node:fs";
import { BATCH_MAX, MESSAGE_MAX_LENGTH } from "../shared/limits.ts";

const num = (name: string, fallback: number): number => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && process.env[name] !== "" ? v : fallback;
};
const flag = (name: string, fallback = false): boolean => {
	const v = String(process.env[name] ?? "").toLowerCase();
	if (v === "") return fallback;
	return v === "1" || v === "true" || v === "yes";
};

const isProd = process.env.NODE_ENV === "production";

/** The running version: APP_VERSION (a deploy may set it) or package.json's. */
const version = (() => {
	try {
		return process.env.APP_VERSION || String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
	} catch {
		return "unknown";
	}
})();

const DEFAULT_ORIGINS = [
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"https://rivo.ir",
	"https://www.rivo.ir",
	"https://chat.rivo.ir",
];

export const config = {
	isProd,
	port: num("PORT", 3000),
	jwtSecret: process.env.JWT_SECRET || "",
	appName: process.env.APP_NAME || "Rivo",
	version,
	appUrl: (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
	trustProxy: isProd && flag("ENABLE_TRUST_PROXY"),
	allowedOrigins: new Set(
		process.env.ALLOWED_ORIGINS
			? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
			: DEFAULT_ORIGINS,
	),
	session: {
		ttlMs: num("SESSION_TTL_DAYS", 30) * 24 * 60 * 60 * 1000,
		// how often a used session gets a fresh cookie / last-seen time
		renewAfterMs: 24 * 60 * 60 * 1000,
		touchAfterMs: 5 * 60 * 1000,
		// __Host- cookies cannot be planted from another subdomain; they
		// require https, so plain names are used in development
		cookie: isProd ? "__Host-rivo_session" : "rivo_session",
		csrfCookie: isProd ? "__Host-rivo_csrf" : "rivo_csrf",
	},
	bcryptRounds: num("BCRYPT_ROUNDS", isProd ? 12 : 10),
	pages: {
		defaultLimit: num("DEFAULT_FETCH_LIMIT", 50),
		maxLimit: num("MAX_FETCH_LIMIT", 100),
		contactsDefault: num("CONTACTS_DEFAULT_LIMIT", 50),
		contactsMax: Math.max(num("MAX_FETCH_LIMIT", 100), 200),
	},
	sync: {
		// changes are looked up this much earlier than the client's cursor, so
		// a write that was still in flight when the cursor was taken is not lost
		overlapMs: 10_000,
		maxChanges: 500,
	},
	rate: {
		// (at least 1: a limit of 0 would refuse every request; ENABLE_HTTP_RATE_LIMITER=0 turns it off)
		http: { enabled: flag("ENABLE_HTTP_RATE_LIMITER", true), windowMs: num("HTTP_RATE_WINDOW_MS", 60_000), max: Math.max(1, num("HTTP_RATE_MAX", 600)) },
		auth: { windowMs: num("AUTH_RATE_WINDOW_MINUTES", 15) * 60_000, max: Math.max(1, num("AUTH_RATE_MAX", 10)) },
		socket: { windowMs: num("SOCKET_RATE_WINDOW_MS", 10_000), max: num("SOCKET_RATE_MAX", 20) },
		search: { perMinute: num("SEARCH_MAX_PER_MINUTE", 40), maxScan: num("SEARCH_MAX_SCAN", 5000) },
	},
	socket: {
		pingInterval: num("SOCKET_PING_INTERVAL", 5000),
		pingTimeout: num("SOCKET_PING_TIMEOUT", 5000),
		offlineGraceMs: num("OFFLINE_GRACE_MS", 7000),
		typingThrottleMs: num("TYPING_THROTTLE_MS", 500),
		connAttempt: {
			windowMs: num("SOCKET_CONN_ATTEMPT_WINDOW_MS", 60_000),
			max: num("SOCKET_CONN_ATTEMPT_MAX", 30),
			storeMax: num("SOCKET_CONN_ATTEMPT_STORE_MAX", 100),
			mapMax: num("SOCKET_CONN_ATTEMPT_MAP_MAX", 5000),
		},
	},
	messages: {
		maxLength: MESSAGE_MAX_LENGTH,
		pinLimit: 20,
		batchMax: BATCH_MAX,
	},
	sentryDsn: process.env.SENTRY_DSN || "",
};

export type Config = typeof config;

export { num as envNumber, flag as envFlag };
