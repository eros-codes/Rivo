// What the chat app keeps in memory, besides the server's own shapes.
import type { LiveMessage, PinnedItem } from "../../shared/api/types";

export type SendMode = "normal" | "one-time" | "time-capsule";

/** The quoted message of a reply, as the sender saw it. */
export interface ReplyRef {
	id: number;
	senderId: number;
	text: string;
}

/** A message this device is sending (or failed to send). */
export interface Pending {
	clientId: string;
	conversationId: number;
	text: string;
	/** local time it was written, ISO */
	createdAt: string;
	replyTo: ReplyRef | null;
	/** shown while sending; the server takes the author from the original */
	forwardedFrom: string | null;
	/** the message this one forwards (its text and author are taken from it) */
	forwardOf: number | null;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	scheduledFor: string | null;
	/** queued: waiting for a connection; sending: on its way; failed: needs the user */
	status: "queued" | "sending" | "failed";
	/** why it failed (shown to the user); null when it may simply be retried */
	error: string | null;
	/** a forwarded batch goes out together */
	batchId: string | null;
}

/** The part of a chat this device has loaded. */
export interface ConvCache {
	/** oldest first; only messages that exist (deleted ones are removed) */
	messages: LiveMessage[];
	/** older messages exist on the server */
	hasMore: boolean;
	/** everything changed up to this server time is reflected here */
	cursor: string | null;
	status: "loading" | "ready" | "error";
	loadingOlder: boolean;
	/** the connection dropped since the last sync: catch up before trusting it */
	staleSince: string | null;
	pinned: PinnedItem[] | null;
	/** ids deleted while this chat was cached: an older copy must not bring them back */
	gone: Record<number, true>;
	/** when it was last opened (least recently used chats are dropped) */
	usedAt: number;
}

export type Section = "active" | "contacts" | "archived";

export type ComposerAction =
	| { kind: "reply"; message: LiveMessage }
	| { kind: "edit"; message: LiveMessage }
	| { kind: "forward"; items: ForwardSource[]; fromName: string };

/** A message chosen to be forwarded. */
export interface ForwardSource {
	/** the message being forwarded */
	sourceId: number;
	text: string;
	/** the original author's name (shown until the server confirms) */
	forwardedFrom: string;
}

export interface Toast {
	id: number;
	text: string;
	icon: ToastIcon | null;
	/** a button on the toast ("Undo", "Turn on") */
	action: { label: string; run: () => void } | null;
}

export type ToastIcon = "delete" | "copy" | "archive" | "pin" | "mute" | "block" | "error" | "check" | "bell";

export interface InAppNotice {
	id: number;
	conversationId: number;
	title: string;
	text: string;
	messageId: number | null;
}
