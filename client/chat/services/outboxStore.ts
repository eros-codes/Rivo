// Unsent messages survive a reload: they are kept on this device (per
// account) until the server has them, and removed when the user signs out.
import { read, write } from "../../shared/lib/storage";
import { outbox } from "../state/stores";
import type { Pending } from "../state/types";

const key = (userId: number) => `rivo.outbox.${userId}`;

function isPending(v: unknown): v is Pending {
	if (!v || typeof v !== "object") return false;
	const p = v as Pending;
	return typeof p.clientId === "string" && typeof p.conversationId === "number" && typeof p.text === "string" && typeof p.createdAt === "string";
}

/** Loads what was waiting to be sent (everything goes back in the queue). */
export function restoreOutbox(userId: number): void {
	const raw = read(key(userId));
	if (!raw) return;
	try {
		const list: unknown = JSON.parse(raw);
		if (!Array.isArray(list)) return;
		const byId: Record<string, Pending> = {};
		for (const item of list) {
			if (!isPending(item)) continue;
			byId[item.clientId] = {
				clientId: item.clientId,
				conversationId: item.conversationId,
				text: item.text,
				createdAt: item.createdAt,
				replyTo: item.replyTo ?? null,
				forwardedFrom: item.forwardedFrom ?? null,
				forwardOf: typeof item.forwardOf === "number" ? item.forwardOf : null,
				isOneTime: !!item.isOneTime,
				isTimeCapsule: !!item.isTimeCapsule,
				scheduledFor: item.scheduledFor ?? null,
				// a refused message stays failed; one cut off by the reload is tried again
				status: item.status === "failed" && item.error ? "failed" : "queued",
				error: item.status === "failed" ? (item.error ?? null) : null,
				batchId: null,
			};
		}
		outbox.set((s) => ({ ...byId, ...s }));
	} catch {
		write(key(userId), null);
	}
}

let timer: number | null = null;

function storedList(userId: number): Pending[] {
	try {
		const list: unknown = JSON.parse(read(key(userId)) ?? "[]");
		return Array.isArray(list) ? list.filter(isPending) : [];
	} catch {
		return [];
	}
}

/**
 * Keeps the stored copy in step with the queue (written shortly after each
 * change). Other tabs of the same account keep theirs in the same place: what
 * they stored stays, unless this tab has sent or dropped it itself (a message
 * sent by two tabs is still stored once: the server keeps one per clientId).
 */
export function persistOutbox(userId: number): () => void {
	const settledHere = new Set<string>();
	let known = new Set(Object.keys(outbox.get()));
	const save = () => {
		timer = null;
		const mine = outbox.get();
		const theirs = storedList(userId).filter((p) => !mine[p.clientId] && !settledHere.has(p.clientId));
		const list = [...theirs, ...Object.values(mine)];
		write(key(userId), list.length ? JSON.stringify(list) : null);
	};
	const unsubscribe = outbox.subscribe(() => {
		const now = outbox.get();
		for (const id of known) if (!now[id]) settledHere.add(id);
		known = new Set(Object.keys(now));
		// (a bounded memory: the oldest ones are long gone from storage too)
		if (settledHere.size > 1000) for (const id of [...settledHere].slice(0, 500)) settledHere.delete(id);
		if (timer === null) timer = window.setTimeout(save, 300);
	});
	// a page being closed writes now
	const onHide = () => {
		if (timer !== null) {
			window.clearTimeout(timer);
			save();
		}
	};
	window.addEventListener("pagehide", onHide);
	return () => {
		unsubscribe();
		window.removeEventListener("pagehide", onHide);
	};
}

export function clearPersistedOutbox(userId: number): void {
	if (timer !== null) window.clearTimeout(timer);
	timer = null;
	write(key(userId), null);
	outbox.set({});
}
