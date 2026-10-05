// Each chat's message box: draft, reply/edit/forward in progress, send mode.
import { composers, EMPTY_COMPOSER, type ComposerState } from "./stores";

export function getComposer(convId: number): ComposerState {
	return composers.get()[convId] ?? EMPTY_COMPOSER;
}

export function patchComposer(convId: number, patch: Partial<ComposerState>): void {
	composers.set((s) => ({ ...s, [convId]: { ...(s[convId] ?? EMPTY_COMPOSER), ...patch } }));
}

/** Clears what the box was doing (reply, edit, forward, special send mode); the draft stays unless `draft` too. */
export function resetComposer(convId: number, { draft = false } = {}): void {
	composers.set((s) => {
		const cur = s[convId];
		if (!cur) return s;
		return { ...s, [convId]: { ...EMPTY_COMPOSER, draft: draft ? "" : cur.draft } };
	});
}

export function dropComposer(convId: number): void {
	composers.set((s) => {
		if (!s[convId]) return s;
		const next = { ...s };
		delete next[convId];
		return next;
	});
}
