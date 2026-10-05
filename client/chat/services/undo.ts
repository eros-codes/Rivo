// Actions with an Undo window: the change shows at once, the server hears of
// it only when the window is over. Closing the page during the window still
// carries it out (a request that outlives the page).
import { hideToast, showToast } from "./feedback";
import type { ToastIcon } from "../state/types";

export const UNDO_MS = 3000;

interface Pending {
	commit: () => Promise<void>;
	revert: () => void;
	/** the same change as a request that survives the page closing */
	commitOnExit: () => void;
	timer: number;
}

const pending = new Map<string, Pending>();

/**
 * Runs `apply` now (hide the thing), shows a toast with Undo and, unless
 * undone, `commit`s after the window. `revert` puts things back (after Undo,
 * or when the commit fails).
 */
export function withUndo(opts: {
	key: string;
	text: string;
	icon?: ToastIcon;
	apply: () => void;
	revert: () => void;
	commit: () => Promise<void>;
	commitOnExit: () => void;
	failedText?: string;
}): void {
	// the same thing again (double tap): the first one stands
	if (pending.has(opts.key)) return;
	opts.apply();
	const entry: Pending = {
		commit: async () => {
			try {
				await opts.commit();
			} catch {
				opts.revert();
				showToast(opts.failedText ?? "Couldn't complete that. Try again.", { icon: "error" });
			}
		},
		revert: opts.revert,
		commitOnExit: opts.commitOnExit,
		timer: window.setTimeout(() => {
			pending.delete(opts.key);
			void entry.commit();
		}, UNDO_MS),
	};
	pending.set(opts.key, entry);
	showToast(opts.text, {
		icon: opts.icon,
		action: {
			label: "Undo",
			run: () => {
				const p = pending.get(opts.key);
				if (!p) return;
				window.clearTimeout(p.timer);
				pending.delete(opts.key);
				opts.revert();
			},
		},
	});
}

/** Undoes a waiting action from code (e.g. the same contact added again). */
export function cancelUndo(key: string): boolean {
	const p = pending.get(key);
	if (!p) return false;
	window.clearTimeout(p.timer);
	pending.delete(key);
	p.revert();
	hideToast();
	return true;
}

/** Carries out every waiting action now (the page is going away). */
export function flushOnExit(): void {
	for (const [key, p] of pending) {
		window.clearTimeout(p.timer);
		pending.delete(key);
		try {
			p.commitOnExit();
		} catch {
			/* nothing more can be done while leaving */
		}
	}
}

export function hasPendingUndo(): boolean {
	return pending.size > 0;
}

let installed = false;
export function installExitFlush(): void {
	if (installed) return;
	installed = true;
	window.addEventListener("pagehide", flushOnExit);
}
