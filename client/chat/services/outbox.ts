// Sending messages. Every message gets an id on this device (clientId) and
// waits in the outbox until the server confirms it; one sender works through
// the outbox in order, so messages arrive in the order they were written.
// A retry after a lost answer is harmless: the server keeps one copy per id.
import { contactsApi } from "../../shared/api/endpoints";
import type { LiveMessage, SendPayload, WireMessage } from "../../shared/api/types";
import { randomId } from "../../shared/lib/ids";
import { applyWire, updateExisting } from "../state/chatModel";
import { getRow, patchRow, realName, toPreview } from "../state/contactModel";
import { outbox, session } from "../state/stores";
import type { ForwardSource, Pending, ReplyRef } from "../state/types";
import { showToast } from "./feedback";
import { serverNow } from "./clock";
import * as realtime from "./realtime";
import { stopTyping } from "./typing";

export const MAX_LENGTH = 1500;

/** Answers that mean "try again later", not "no". */
const TRANSIENT = new Set(["Server error", "Rate limit exceeded"]);

function setPending(clientId: string, patch: Partial<Pending>): void {
	outbox.set((s) => (s[clientId] ? { ...s, [clientId]: { ...s[clientId]!, ...patch } } : s));
}

function removePending(clientIds: string[]): void {
	outbox.set((s) => {
		if (!clientIds.some((id) => s[id])) return s;
		const next = { ...s };
		for (const id of clientIds) delete next[id];
		return next;
	});
}

/** The server has the message: it leaves the outbox and joins the chat. */
function delivered(m: WireMessage, clientId: string | null = m.clientId ?? null): void {
	if (clientId) removePending([clientId]);
	updateExisting(m.conversationId, (c) => applyWire(c, [m]));
	// a re-send of a message that was deleted in the meantime: nothing to show
	if (m.isDeleted) return;
	patchRow(m.conversationId, (r) => {
		const last = r.lastMessage;
		if (last && last.id !== m.id && (last.createdAt > m.createdAt || (last.createdAt === m.createdAt && last.id > m.id))) return {};
		return {
			lastMessage: toPreview(m),
			conversation: r.conversation ? { ...r.conversation, lastMessageAt: m.createdAt } : r.conversation,
		};
	});
}

function payloadOf(p: Pending): SendPayload {
	const out: SendPayload = { conversationId: p.conversationId, text: p.text, clientId: p.clientId };
	if (p.replyTo) out.replyToId = p.replyTo.id;
	if (p.forwardOf !== null) out.forwardOf = p.forwardOf;
	if (p.isOneTime) out.isOneTime = true;
	if (p.isTimeCapsule && p.scheduledFor) {
		out.isTimeCapsule = true;
		out.scheduledFor = p.scheduledFor;
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Sends one message; true when the sender may go on to the next. */
async function sendOne(p: Pending): Promise<"ok" | "stop" | "slow"> {
	setPending(p.clientId, { status: "sending" });
	try {
		const ack = await realtime.request("message:send", payloadOf(p), 10_000);
		if (ack.error === undefined) {
			delivered(ack.message, p.clientId);
			return "ok";
		}
		if (ack.error === "Rate limit exceeded") {
			setPending(p.clientId, { status: "queued" });
			return "slow";
		}
		setPending(p.clientId, { status: "failed", error: TRANSIENT.has(ack.error) ? null : ack.error });
		return "ok";
	} catch {
		// a reconnect while this was out already put it back in the queue: it
		// goes again (first, so the order holds) rather than being marked failed
		if (outbox.get()[p.clientId]?.status !== "sending") return realtime.isConnected() ? "ok" : "stop";
		// no connection, or no answer: it may have arrived (a retry is safe)
		setPending(p.clientId, realtime.isConnected() ? { status: "failed", error: null } : { status: "queued" });
		return realtime.isConnected() ? "ok" : "stop";
	}
}

/** Sends a forwarded batch at once. */
async function sendBatch(items: Pending[]): Promise<"ok" | "stop" | "slow"> {
	const first = items[0]!;
	for (const p of items) setPending(p.clientId, { status: "sending" });
	try {
		const ack = await realtime.request(
			"messages:forward",
			{
				conversationId: first.conversationId,
				items: items.filter((p) => p.forwardOf !== null).map((p) => ({ forwardOf: p.forwardOf!, clientId: p.clientId })),
			},
			15_000,
		);
		const sent = "messages" in ack && Array.isArray(ack.messages) ? ack.messages : [];
		for (const m of sent) delivered(m);
		const done = new Set(sent.map((m) => m.clientId));
		const rest = items.filter((p) => !done.has(p.clientId));
		if (ack.error === "Rate limit exceeded" && sent.length === 0) {
			for (const p of rest) setPending(p.clientId, { status: "queued" });
			return "slow";
		}
		for (const p of rest) {
			// sent one by one from now on
			setPending(p.clientId, { status: "failed", error: ack.error && !TRANSIENT.has(ack.error) ? ack.error : null, batchId: null });
		}
		return "ok";
	} catch {
		// (as in sendOne: ones a reconnect put back in the queue go again)
		const box = outbox.get();
		for (const p of items) {
			if (box[p.clientId]?.status !== "sending") continue;
			setPending(p.clientId, realtime.isConnected() ? { status: "failed", error: null, batchId: null } : { status: "queued" });
		}
		return realtime.isConnected() ? "ok" : "stop";
	}
}

let pumping = false;
let gate: Promise<void> = Promise.resolve();

/**
 * Sending waits until `until` settles: after (re)connecting, who is signed in
 * on this browser is checked first, so nothing goes out as another account.
 */
export function holdSends(until: Promise<void>): void {
	gate = until;
}

/** Works through the outbox, oldest first, while connected. */
export async function pump(): Promise<void> {
	if (pumping) return;
	pumping = true;
	try {
		await gate;
		while (realtime.isConnected()) {
			const queued = Object.values(outbox.get())
				.filter((p) => p.status === "queued")
				.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
			const next = queued[0];
			if (!next) break;
			const result = next.batchId
				? await sendBatch(queued.filter((p) => p.batchId === next.batchId))
				: await sendOne(next);
			if (result === "stop") break;
			if (result === "slow") await sleep(3000);
		}
	} finally {
		pumping = false;
	}
	// something was added while the last request was out
	if (realtime.isConnected() && Object.values(outbox.get()).some((p) => p.status === "queued")) void pump();
}

/** After reconnecting: messages that failed only for lack of an answer go again. */
export function requeueAfterReconnect(): void {
	outbox.set((s) => {
		let changed = false;
		const next = { ...s };
		for (const [id, p] of Object.entries(s)) {
			if (p.status === "sending" || (p.status === "failed" && p.error === null)) {
				next[id] = { ...p, status: "queued" };
				changed = true;
			}
		}
		return changed ? next : s;
	});
	void pump();
}

/** Sending to an archived chat brings it back. */
function unarchive(convId: number): void {
	const row = getRow(convId);
	if (!row?.isArchived) return;
	patchRow(convId, { isArchived: false });
	contactsApi.update(row.id, { isArchived: false }).catch(() => patchRow(convId, { isArchived: true }));
}

/** Local time for ordering (the server's clock, so it sorts with its messages). */
function stamp(offsetMs = 0): string {
	return serverNow(offsetMs);
}

export interface SendOptions {
	replyTo?: LiveMessage | null;
	isOneTime?: boolean;
	scheduledFor?: string | null;
}

/** Puts a message in the outbox and starts sending. */
export function sendText(convId: number, rawText: string, opts: SendOptions = {}): boolean {
	const text = rawText.trim();
	if (!text) return false;
	if (text.length > MAX_LENGTH) {
		showToast(`Messages can be at most ${MAX_LENGTH} characters.`, { icon: "error" });
		return false;
	}
	const me = session.get().me;
	const row = getRow(convId);
	let replyTo: ReplyRef | null = null;
	if (opts.replyTo && opts.replyTo.text !== null) {
		const q = opts.replyTo;
		replyTo = {
			id: q.id,
			senderId: q.senderId,
			text: q.text ?? "",
			name: q.senderId === me?.id ? (me?.name ?? "") : realName(row),
		};
	}
	const p: Pending = {
		clientId: randomId(),
		conversationId: convId,
		text,
		createdAt: stamp(),
		replyTo,
		forwardedFrom: null,
		forwardOf: null,
		isOneTime: !!opts.isOneTime,
		isTimeCapsule: !!opts.scheduledFor,
		scheduledFor: opts.scheduledFor ?? null,
		status: "queued",
		error: null,
		batchId: null,
	};
	outbox.set((s) => ({ ...s, [p.clientId]: p }));
	stopTyping();
	unarchive(convId);
	void pump();
	return true;
}

/** Forwards messages (and then the text typed with them, if any). */
export function forwardTo(convId: number, items: ForwardSource[], extraText = ""): void {
	if (items.length === 0) return;
	const batchId = items.length > 1 ? randomId(10) : null;
	const added: Record<string, Pending> = {};
	items.forEach((item, i) => {
		const p: Pending = {
			clientId: randomId(),
			conversationId: convId,
			text: item.text,
			createdAt: stamp(i),
			replyTo: null,
			forwardedFrom: item.forwardedFrom,
			forwardOf: item.sourceId,
			isOneTime: false,
			isTimeCapsule: false,
			scheduledFor: null,
			status: "queued",
			error: null,
			batchId,
		};
		added[p.clientId] = p;
	});
	outbox.set((s) => ({ ...s, ...added }));
	unarchive(convId);
	if (extraText.trim()) {
		// written after the forwarded ones
		const p: Pending = {
			clientId: randomId(),
			conversationId: convId,
			text: extraText.trim().slice(0, MAX_LENGTH),
			createdAt: stamp(items.length),
			replyTo: null,
			forwardedFrom: null,
			forwardOf: null,
			isOneTime: false,
			isTimeCapsule: false,
			scheduledFor: null,
			status: "queued",
			error: null,
			batchId: null,
		};
		outbox.set((s) => ({ ...s, [p.clientId]: p }));
	}
	stopTyping();
	void pump();
}

export function retry(clientId: string): void {
	setPending(clientId, { status: "queued", error: null, batchId: null });
	void pump();
}

export function discard(clientId: string): void {
	const p = outbox.get()[clientId];
	if (!p || p.status === "sending") return;
	removePending([clientId]);
}
