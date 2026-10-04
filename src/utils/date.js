// Dates are grouped by the user's own calendar day. (toISOString() gives the
// UTC day, which put messages sent after midnight in Tehran under "yesterday".)

/** "YYYY-MM-DD" of the given moment in the user's time zone. */
export function localDateKey(value = new Date()) {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A "YYYY-MM-DD" key back to a local Date (midnight). */
export function dateFromKey(key) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
	if (!m) return new Date(NaN);
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 24-hour "HH:MM" in the user's time zone. */
export function formatClock(value = new Date()) {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Key of the day before `key`. */
export function previousDateKey(key = localDateKey()) {
	const d = dateFromKey(key);
	d.setDate(d.getDate() - 1);
	return localDateKey(d);
}
