// Limits and rules the browser app and the server must agree on: the app
// stops a person before the server would refuse. They are part of the
// protocol, so they live here and not in .env (a server-only setting the app
// cannot see would make the two disagree). Plain values only: the app bundles
// this file (the schemas, which need zod, it only uses as types).

/** Characters in a message. */
export const MESSAGE_MAX_LENGTH = 1500;

/** A display name, after trimming. */
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 100;

export const BIO_MAX_LENGTH = 300;

/** What someone calls a contact (longer ones are cut, not refused). */
export const NICKNAME_MAX_LENGTH = 100;

/** 3–30 letters, digits or underscores. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** The longest an email address can be. */
export const EMAIL_MAX_LENGTH = 254;

// Written so it cannot backtrack (the dots are separators, never optional
// parts of a repeated group): a long crafted address is refused in linear time.
export const EMAIL_PATTERN = /^[^\s@.]+(\.[^\s@.]+)*@[^\s@.]+(\.[^\s@.]+)+$/;

/** A plausible email address (and not longer than an address can be). */
export function isEmail(v: unknown): boolean {
	if (typeof v !== "string") return false;
	const s = v.trim();
	return s.length > 0 && s.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(s);
}

/** Digits in an emailed sign-up code. */
export const CODE_LENGTH = 6;

/** Messages in one delete or forward. */
export const BATCH_MAX = 100;

/** A reaction: one emoji (a few code points at most). */
export const EMOJI_MAX_LENGTH = 16;

/** Searching people by username: shorter is refused, longer too. */
export const USER_SEARCH_MIN = 2;
export const USER_SEARCH_MAX = 50;

/** Searching messages: shorter finds nothing, longer is refused. */
export const MESSAGE_SEARCH_MIN = 2;
export const MESSAGE_SEARCH_MAX = 100;

/** A time capsule opens at least this long after it is sent, and within a year. */
export const CAPSULE_MIN_DELAY_MS = 5 * 60_000;
export const CAPSULE_MAX_DELAY_MS = 365 * 24 * 60 * 60_000;
