// Dates and times as the app shows them. Days are the user's own calendar
// days (local time zone), never UTC days. The interface is English, so names
// of months are too; times are always 24-hour "HH:MM".

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function toDate(value: string | number | Date | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of a moment in the user's time zone. */
export function dayKey(value: string | number | Date = new Date()): string {
	const d = toDate(value);
	return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "";
}

/** The day key `days` days before `key`'s day. */
export function shiftDayKey(key: string, days: number): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (!m) return "";
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	d.setDate(d.getDate() + days);
	return dayKey(d);
}

/** "14:05" */
export function clock(value: string | number | Date): string {
	const d = toDate(value);
	return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}

/** "Oct 4" */
export function shortDate(value: string | number | Date): string {
	const d = toDate(value);
	return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}

/** Time of a chat's last message in the list: "14:05", "yesterday" or "Oct 4". */
export function listTime(value: string | number | Date | null | undefined, now = new Date()): string {
	const d = toDate(value);
	if (!d) return "";
	const key = dayKey(d);
	const today = dayKey(now);
	if (key === today) return clock(d);
	if (key === shiftDayKey(today, -1)) return "yesterday";
	if (d.getFullYear() !== now.getFullYear()) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	return shortDate(d);
}

/** Label between days in a chat: "Today", "Yesterday" or "October 4, 2026". */
export function dayLabel(key: string, now = new Date()): string {
	const today = dayKey(now);
	if (key === today) return "Today";
	if (key === shiftDayKey(today, -1)) return "Yesterday";
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (!m) return "";
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

/** "Oct 4 at 14:05" (time capsules). */
export function dateAtTime(value: string | number | Date): string {
	const d = toDate(value);
	return d ? `${shortDate(d)} at ${clock(d)}` : "";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago"… */
export function timeAgo(value: string | number | Date, now = Date.now()): string {
	const d = toDate(value);
	if (!d) return "";
	const diff = Math.max(0, now - d.getTime());
	if (diff < MINUTE) return "just now";
	if (diff < HOUR) return `${plural(Math.floor(diff / MINUTE), "minute")} ago`;
	if (diff < DAY) return `${plural(Math.floor(diff / HOUR), "hour")} ago`;
	if (diff < 2 * DAY) return "yesterday";
	if (diff < 7 * DAY) return `${plural(Math.floor(diff / DAY), "day")} ago`;
	if (diff < 14 * DAY) return "last week";
	if (diff < 30 * DAY) return `${plural(Math.floor(diff / (7 * DAY)), "week")} ago`;
	if (diff < 60 * DAY) return "last month";
	if (diff < 365 * DAY) return `${plural(Math.floor(diff / (30 * DAY)), "month")} ago`;
	return "a long time ago";
}

/** Value for <input type="datetime-local"> in local time: "2026-10-04T14:05". */
export function toLocalInputValue(d: Date): string {
	return `${dayKey(d)}T${clock(d)}`;
}

/** The moment a datetime-local value means, or null. */
export function fromLocalInputValue(v: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
	return Number.isNaN(d.getTime()) ? null : d;
}
