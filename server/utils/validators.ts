const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || "1500", 10);
const MAX_NAME_LENGTH = parseInt(process.env.MAX_NAME_LENGTH || "255", 10);
const MAX_INT = 2147483647;

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
// Written so it cannot backtrack (the dots are separators, never optional
// parts of a repeated group): a long crafted address is rejected in linear time.
export const EMAIL_RE = /^[^\s@.]+(\.[^\s@.]+)*@[^\s@.]+(\.[^\s@.]+)+$/;
export const MAX_EMAIL_LENGTH = 254;

/** A plausible email address (and not longer than an address can be). */
export function isEmail(v: unknown): boolean {
	if (typeof v !== "string") return false;
	const s = v.trim();
	return s.length > 0 && s.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(s);
}
export const PRIVACY_VALUES: ReadonlySet<string> = new Set(["everyone", "contacts", "nobody"]);

export function isNonEmptyString(v: unknown, maxLen = MAX_MESSAGE_LENGTH): boolean {
	return typeof v === "string" && v.trim().length > 0 && v.trim().length <= maxLen;
}

/**
 * A database id from user input: a positive whole number that fits the
 * column (anything else would make the database query fail with a 500).
 * Strings like "12abc", "1.5" or "1e3" are rejected.
 */
export function parseId(v: unknown): number | null {
	if (typeof v === "number") return Number.isInteger(v) && v > 0 && v <= MAX_INT ? v : null;
	if (typeof v !== "string" || !/^\d{1,10}$/.test(v.trim())) return null;
	const n = Number(v.trim());
	return n > 0 && n <= MAX_INT ? n : null;
}

/** @deprecated use parseId (kept for scripts) */
export function parseIntSafe(v: unknown): number | null {
	return parseId(v);
}

export function isPositiveInt(v: unknown): boolean {
	return parseId(v) !== null;
}

export { MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH };
