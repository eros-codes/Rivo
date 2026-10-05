// Time capsules whose unlock animation this device has already shown.
import { keys, read, write } from "../../shared/lib/storage";

const MAX = 1000;
let revealed: string[] | null = null;

function load(): string[] {
	if (revealed) return revealed;
	try {
		const v: unknown = JSON.parse(read(keys.revealedCapsules) || "[]");
		revealed = Array.isArray(v) ? v.map(String) : [];
	} catch {
		revealed = [];
	}
	return revealed;
}

export function isRevealed(messageId: number): boolean {
	return load().includes(String(messageId));
}

export function markRevealed(messageId: number): void {
	const list = load();
	const id = String(messageId);
	if (list.includes(id)) return;
	list.push(id);
	if (list.length > MAX) list.splice(0, list.length - MAX);
	write(keys.revealedCapsules, JSON.stringify(list));
}
