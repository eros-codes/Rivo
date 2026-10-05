// The server's clock as seen from here. Sync cursors are server times, and a
// device's own clock may be minutes off; every cursor the server sends tells
// us the difference.

let offsetMs = 0;

/** Notes a moment the server just reported as "now". */
export function noteServerTime(iso: string): void {
	const t = Date.parse(iso);
	if (Number.isFinite(t)) offsetMs = t - Date.now();
}

/** The server's current time (shifted by `deltaMs`), as an ISO string. */
export function serverNow(deltaMs = 0): string {
	return new Date(Date.now() + offsetMs + deltaMs).toISOString();
}
