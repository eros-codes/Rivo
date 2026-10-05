// One place for the server's log lines.
//
// Production: one JSON object per line ({time, level, msg, reqId, userId, …}),
// easy to search (grep, jq) or to send to a log service. Development: a
// readable line. A line written while a request or a socket event is being
// handled carries its context (request id, user) without it being passed
// around, through AsyncLocalStorage.
//
//   LOG_LEVEL   debug | info | warn | error   (default: info)
//   LOG_FORMAT  json | pretty                 (default: json in production)
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || "").toLowerCase()] ?? LEVELS.info;
const asJson = (process.env.LOG_FORMAT || (process.env.NODE_ENV === "production" ? "json" : "pretty")).toLowerCase() === "json";
const store = new AsyncLocalStorage();

const isError = (v) => v instanceof Error || (v !== null && typeof v === "object" && typeof v.message === "string" && typeof v.stack === "string");

function errorFields(e) {
	const out = { name: e.name, message: e.message };
	if (e.code !== undefined) out.code = e.code;
	if (e.stack) out.stack = String(e.stack).split("\n").slice(0, 12).join("\n");
	return out;
}

/** Plain data for a JSON line (never throws: a circular object becomes text). */
function plain(v) {
	if (v === undefined || v === null || typeof v !== "object") return v;
	try {
		return JSON.parse(JSON.stringify(v));
	} catch {
		return String(v);
	}
}

function write(level, msg, args) {
	if (LEVELS[level] < threshold) return;
	const ctx = store.getStore();
	if (asJson) {
		const line = { time: new Date().toISOString(), level, msg: typeof msg === "string" ? msg : String(msg), ...ctx };
		const details = [];
		for (const a of args) {
			if (isError(a) && !line.err) line.err = errorFields(a);
			else details.push(isError(a) ? errorFields(a) : plain(a));
		}
		if (details.length) line.details = details.length === 1 ? details[0] : details;
		const text = `${JSON.stringify(line)}\n`;
		if (LEVELS[level] >= LEVELS.warn) process.stderr.write(text);
		else process.stdout.write(text);
		return;
	}
	const tags = ctx ? Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(" ") : "";
	const head = `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)}${tags ? ` [${tags}]` : ""}`;
	const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
	out(head, msg, ...args);
}

export const log = {
	debug: (msg, ...args) => write("debug", msg, args),
	info: (msg, ...args) => write("info", msg, args),
	warn: (msg, ...args) => write("warn", msg, args),
	error: (msg, ...args) => write("error", msg, args),
};

/** Runs `fn` with these fields added to every log line written inside it. */
export function withLogContext(fields, fn) {
	return store.run({ ...store.getStore(), ...fields }, fn);
}

/** Adds fields to the current context (e.g. the user, once known). */
export function addLogContext(fields) {
	const ctx = store.getStore();
	if (ctx) Object.assign(ctx, fields);
}

const REQUEST_ID = /^[\w-]{8,64}$/;

/**
 * Express middleware: every request gets an id (the proxy's X-Request-Id
 * when it sends a sane one), echoed in the response so a user's report can
 * be matched to the log; API requests get one access line when they end.
 */
export function requestLogging() {
	return (req, res, next) => {
		const incoming = req.get("x-request-id");
		const reqId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID().slice(0, 13);
		res.setHeader("X-Request-Id", reqId);
		const started = process.hrtime.bigint();
		const path = req.originalUrl.split("?")[0].slice(0, 200);
		store.run({ reqId }, () => {
			if (path.toLowerCase().startsWith("/api/") && path !== "/api/health") {
				res.on("finish", () => {
					const ms = Number(process.hrtime.bigint() - started) / 1e6;
					// (the query string is left out: it can hold tokens)
					const fields = { method: req.method, path, status: res.statusCode, ms: Math.round(ms * 10) / 10 };
					const ctx = req.userId ? { reqId, userId: req.userId } : { reqId };
					store.run(ctx, () => write(res.statusCode >= 500 ? "error" : "info", "http", [fields]));
				});
			}
			next();
		});
	};
}
