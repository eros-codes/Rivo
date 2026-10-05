// Small React hooks shared by the apps.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** A callback with a stable identity that always runs the latest `fn`. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
	const ref = useRef(fn);
	useLayoutEffect(() => {
		ref.current = fn;
	});
	return useCallback((...args: A) => ref.current(...args), []);
}

/** Whether a media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(cb: () => void) => {
			const mql = window.matchMedia(query);
			mql.addEventListener("change", cb);
			return () => mql.removeEventListener("change", cb);
		},
		[query],
	);
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(query).matches,
		() => false,
	);
}

/** Phones: the layout below 701px (the stylesheet's breakpoint). */
export const PHONE_QUERY = "(max-width: 700px)";
export const useIsPhone = () => useMediaQuery(PHONE_QUERY);

export function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type PresenceState = "enter" | "shown" | "exit";

/**
 * Keeps something mounted while it animates out. `state` is "enter" for the
 * first `ms` after it opens, "shown" after that, and "exit" for the `ms`
 * before it is unmounted.
 */
export function usePresence(open: boolean, ms = 300): { mounted: boolean; state: PresenceState } {
	const [mounted, setMounted] = useState(open);
	const [state, setState] = useState<PresenceState>(open ? "shown" : "exit");
	const first = useRef(true);
	useEffect(() => {
		const instant = prefersReducedMotion() ? 0 : ms;
		if (first.current) {
			first.current = false;
			if (open) return undefined;
		}
		if (open) {
			setMounted(true);
			setState("enter");
			const t = window.setTimeout(() => setState("shown"), instant);
			return () => window.clearTimeout(t);
		}
		setState("exit");
		const t = window.setTimeout(() => setMounted(false), instant);
		return () => window.clearTimeout(t);
	}, [open, ms]);
	return { mounted: mounted || open, state: open && state === "exit" ? "enter" : state };
}

function visibleNow(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Whether the page is visible (not a background tab, not a locked phone). */
export function usePageVisible(): boolean {
	return useSyncExternalStore(
		(cb) => {
			document.addEventListener("visibilitychange", cb);
			return () => document.removeEventListener("visibilitychange", cb);
		},
		visibleNow,
		() => true,
	);
}

/** The current time, refreshed every `ms` (for "5 minutes ago" texts). */
export function useNow(ms = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), ms);
		return () => window.clearInterval(t);
	}, [ms]);
	return now;
}

/** Calls `fn` when a pointer goes down outside every given element. */
export function useOutsidePointer(refs: ReadonlyArray<{ current: Element | null }>, fn: () => void, active = true): void {
	const handler = useEvent(fn);
	useEffect(() => {
		if (!active) return undefined;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (!t) return;
			if (refs.some((r) => r.current?.contains(t))) return;
			handler();
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
		// the refs are stable objects: their contents are read when it runs
	}, [active, handler]);
}

/** Calls `fn` on Escape while active. */
export function useEscape(fn: () => void, active = true): void {
	const handler = useEvent(fn);
	useEffect(() => {
		if (!active) return undefined;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !e.defaultPrevented) handler();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [active, handler]);
}

/** A value from the previous render. */
export function usePrevious<T>(value: T): T | undefined {
	const ref = useRef<T | undefined>(undefined);
	useEffect(() => {
		ref.current = value;
	});
	return ref.current;
}

function subscribeTheme(cb: () => void): () => void {
	const mo = new MutationObserver(cb);
	mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => mo.disconnect();
}

/** Whether the dark theme is on (follows changes made in Settings). */
export function useIsDark(): boolean {
	return useSyncExternalStore(
		subscribeTheme,
		() => document.documentElement.classList.contains("dark-mode"),
		() => false,
	);
}

export interface ClickSuppressor {
	/** the next click (soon) is part of this gesture, not a tap */
	arm: () => void;
	/** true (once) when a click should be ignored */
	consume: () => boolean;
	/** whether one is armed, without using it up */
	armed: () => boolean;
}

/**
 * "Ignore the click this gesture causes". A swipe or a long press often
 * causes no click at all (touch), so it expires by itself rather than
 * swallowing the user's next real tap.
 */
export function useClickSuppressor(ms = 600): ClickSuppressor {
	const until = useRef(0);
	const [api] = useState<ClickSuppressor>(() => ({
		arm: () => {
			until.current = performance.now() + ms;
		},
		consume: () => {
			if (performance.now() >= until.current) return false;
			until.current = 0;
			return true;
		},
		armed: () => performance.now() < until.current,
	}));
	return api;
}
