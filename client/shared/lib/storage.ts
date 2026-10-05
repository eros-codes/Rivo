// localStorage that never throws (private mode, full quota, blocked storage).
// Only small per-device preferences live here, never anything secret.

export const keys = {
	theme: "rivo-theme",
	accent: "rivo-accent",
	wallpaper: "rivo-wallpaper",
	revealedCapsules: "rivo.revealedCapsules",
	notifyAsked: "rivo.notifyAsked",
	/** a display copy of the signed-in user, for an instant first paint */
	user: "user",
} as const;

export function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function write(key: string, value: string | null): boolean {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}

export function readJson<T>(key: string, isValid: (v: unknown) => v is T): T | null {
	const raw = read(key);
	if (!raw) return null;
	try {
		const v: unknown = JSON.parse(raw);
		return isValid(v) ? v : null;
	} catch {
		return null;
	}
}

export function writeJson(key: string, value: unknown): boolean {
	try {
		return write(key, JSON.stringify(value));
	} catch {
		return false;
	}
}
