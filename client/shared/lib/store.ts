// A small observable state container and the hook that reads from it.
//
// State is immutable: an update returns a new object, and components re-render
// only when the part they selected changed (compared with `isEqual`).
import { useMemo, useRef, useEffect, useSyncExternalStore } from "react";

export interface Store<S> {
	get(): S;
	set(update: S | ((state: S) => S)): void;
	subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set(update) {
			const next = typeof update === "function" ? (update as (s: S) => S)(state) : update;
			if (Object.is(next, state)) return;
			state = next;
			for (const l of [...listeners]) l();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/**
 * The part of a store's state `selector` picks, kept up to date. When the
 * selection is equal (by `isEqual`) to the last rendered one, the component
 * does not re-render.
 */
export function useStore<S, T>(store: Store<S>, selector: (state: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
	// the selection last rendered (committed), shared by every getSnapshot
	const committed = useRef<{ value: T } | null>(null);
	const getSnapshot = useMemo(() => {
		let lastState: S;
		let lastValue: T;
		let has = false;
		return () => {
			const state = store.get();
			if (has && Object.is(state, lastState)) return lastValue;
			const value = selector(state);
			const prev = committed.current;
			lastState = state;
			has = true;
			// keep the identity of an equal selection: no re-render
			lastValue = prev && isEqual(prev.value, value) ? prev.value : value;
			return lastValue;
		};
	}, [store, selector, isEqual]);
	const value = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
	useEffect(() => {
		committed.current = { value };
	}, [value]);
	return value;
}

/** Equal when both have the same keys with identical values (one level deep). */
export function shallowEqual<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
		return true;
	}
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
		if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
	}
	return true;
}
