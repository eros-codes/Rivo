// The phone's back button (and the browser's) closes what is on top — a
// menu, a dialog, a panel, the chat — instead of leaving the app. Each open
// layer owns one history entry; closing it from the UI removes that entry.
//
// History changes are asynchronous (going back reports later through
// "popstate"), so they are queued and done one at a time: an entry is never
// pushed while an earlier "go back" is still on its way.

interface Layer {
	key: string;
	close: () => void;
}

const stack: Layer[] = [];
const queue: Array<"push" | number> = [];
let waitingForOwnPop = false;
let safety: number | null = null;
let started = false;

function pump(): void {
	while (!waitingForOwnPop && queue.length > 0) {
		const op = queue.shift()!;
		if (op === "push") {
			history.pushState({ rivoLayer: true }, "", location.href);
			continue;
		}
		let n = op;
		while (typeof queue[0] === "number") n += queue.shift() as number;
		waitingForOwnPop = true;
		history.go(-n);
		// a browser that never reports it must not freeze the queue
		safety = window.setTimeout(() => {
			waitingForOwnPop = false;
			pump();
		}, 1000);
	}
}

function start(): void {
	if (started) return;
	started = true;
	// a reload keeps the old entry's state; it means nothing to the new page
	if (history.state && typeof history.state === "object" && "rivoLayer" in history.state) {
		history.replaceState(null, "", location.href);
	}
	window.addEventListener("popstate", () => {
		if (waitingForOwnPop) {
			waitingForOwnPop = false;
			if (safety !== null) window.clearTimeout(safety);
			safety = null;
			pump();
			return;
		}
		// the user went back: close the top layer
		stack.pop()?.close();
	});
}

/** Records an opened layer. Opening one that is already open only updates its closer. */
export function pushLayer(key: string, close: () => void): void {
	start();
	const existing = stack.find((l) => l.key === key);
	if (existing) {
		existing.close = close;
		return;
	}
	stack.push({ key, close });
	queue.push("push");
	pump();
}

/**
 * The layer was closed by the UI: forget it and its history entry. Layers
 * opened on top of it lose their entries too, so they are closed as well
 * (a back press could not reach them anymore).
 */
export function popLayer(key: string): void {
	const at = stack.findIndex((l) => l.key === key);
	if (at < 0) return;
	const above = stack.splice(at + 1);
	stack.pop();
	queue.push(above.length + 1);
	pump();
	for (const layer of above.reverse()) layer.close();
}

export function isLayerOpen(key: string): boolean {
	return stack.some((l) => l.key === key);
}
