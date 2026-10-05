// The few browser globals the tested modules touch, kept in memory.
const items = new Map<string, string>();
const storage = {
	getItem: (k: string) => (items.has(k) ? items.get(k)! : null),
	setItem: (k: string, v: string) => void items.set(k, String(v)),
	removeItem: (k: string) => void items.delete(k),
	clear: () => items.clear(),
};
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.localStorage = storage;
g.addEventListener ??= () => undefined;
g.removeEventListener ??= () => undefined;

export const localStore = storage;
