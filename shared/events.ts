// The contract over the live connection (Socket.IO): what the server sends,
// and what a client sends with the answer it gets back. The server checks
// every payload against the schema named here (ClientEventSchemas) and its
// answers are type-checked against the acks; the app is type-checked against
// the same maps.
import type { z } from "zod";
import {
	ConversationRef,
	DeleteMessages,
	EditMessage,
	ForwardMessages,
	MarkSeen,
	MessageRef,
	React,
	SendMessage,
	Visibility,
} from "./schemas/messages.ts";
import type { ContactRow, Deleted, Edited, Forwarded, LiveMessage, Pinned, Privacy, Reacted, Reaction, Seen, Sent, WireMessage } from "./api.ts";

// ─── Server → client ──────────────────────────────────────────────────────

export interface ServerEvents {
	"message:new": LiveMessage;
	"message:edited": { messageId: number; conversationId: number; text: string; isEdited: true; updatedAt: string };
	"message:deleted": { messageId: number; conversationId: number; senderId: number; isSeen: boolean; updatedAt: string };
	/** every message up to `upToId` was deleted (the chat was cleared) */
	"messages:bulk-deleted": { conversationId: number; upToId: number };
	"message:pinned": { messageId: number; conversationId: number; isPinned: boolean; updatedAt: string };
	"reaction:updated": {
		messageId: number;
		conversationId: number;
		reactions: Reaction[];
		actorId: number;
		emoji: string;
		action: "added" | "changed" | "removed";
		updatedAt: string;
	};
	"message:seen": { conversationId: number; messageIds: number[]; seenBy: number };
	"message:onetime-deleted": { conversationId: number; messageIds: number[] };
	"message:capsule:opened": {
		messageId: number;
		conversationId: number;
		senderId: number;
		text: string | null;
		openedAt: string;
		message: WireMessage;
	};
	"typing:start": { userId: number; conversationId: number };
	"typing:stop": { userId: number; conversationId: number };
	"user:online": { userId: number };
	"user:offline": { userId: number; lastSeen: string | null; privacyOnline: Privacy };
	"user:updated": {
		id: number;
		name: string;
		username: string;
		bio: string;
		isDeleted: boolean;
		profilePics: string[];
		email: string | null;
	};
	"contact:upsert": ContactRow;
	"contact:removed": { contactUserId: number; contactRowId: number; conversationId: number };
	"session:ended": undefined;
}

// ─── Client → server ──────────────────────────────────────────────────────

/** Each event's schema: the server checks every payload against it. */
export const ClientEventSchemas = {
	"presence:visibility": Visibility,
	"message:send": SendMessage,
	"messages:forward": ForwardMessages,
	"message:edit": EditMessage,
	"messages:delete": DeleteMessages,
	"message:pin": MessageRef,
	"reaction:add": React,
	"message:seen": MarkSeen,
	"typing:start": ConversationRef,
	"typing:stop": ConversationRef,
	"conversation:join": ConversationRef,
	"conversation:leave": ConversationRef,
} as const;
type Schemas = typeof ClientEventSchemas;
export type ClientEventName = keyof Schemas;

/** An answer: what was asked for, or why not. */
export type Ack<T> = (T & { success: true; error?: undefined }) | { success?: undefined; error: string };

/** What each event answers (events without an answer are not here). */
export interface ClientAcks {
	"message:send": Ack<Sent>;
	/** (a forward stopped half way answers what it did and why it stopped) */
	"messages:forward": Ack<Forwarded> | (Forwarded & { success: true; error: string });
	"message:edit": Ack<Edited>;
	"messages:delete": Ack<Deleted>;
	"message:pin": Ack<Pinned>;
	"reaction:add": Ack<Reacted>;
	"message:seen": Ack<Seen>;
}

/** A payload as the server reads it (after its schema). */
export type ClientPayload<E extends ClientEventName> = z.output<Schemas[E]>;

/** What the app sends to post a message (its outbox keeps these). */
export interface SendPayload {
	conversationId: number;
	text: string;
	clientId: string;
	/** the server quotes the message itself */
	replyToId?: number;
	/** a forward: the server copies this message's text and author */
	forwardOf?: number;
	isOneTime?: boolean;
	isTimeCapsule?: boolean;
	scheduledFor?: string;
}

/** One item of a selection forward. */
export interface ForwardItem {
	forwardOf: number;
	clientId: string;
}

/**
 * What the app sends with each event. Narrower than what the schemas accept
 * (ids are numbers here; the server also takes "12"), and checked against
 * them below.
 */
export interface ClientPayloads {
	"presence:visibility": { visible: boolean };
	"message:send": SendPayload;
	"messages:forward": { conversationId: number; items: ForwardItem[] };
	"message:edit": { messageId: number; text: string };
	"messages:delete": { messageIds: number[] };
	"message:pin": { messageId: number };
	"reaction:add": { messageId: number; emoji: string };
	"message:seen": { conversationId: number; upToId: number };
	"typing:start": { conversationId: number };
	"typing:stop": { conversationId: number };
	"conversation:join": { conversationId: number };
	"conversation:leave": { conversationId: number };
}

/** [payload] or [payload, answer] per event, as the app emits them. */
export type ClientEvents = {
	[E in ClientEventName]: E extends keyof ClientAcks ? [ClientPayloads[E], (ack: ClientAcks[E]) => void] : [ClientPayloads[E]];
};

// Every payload the app sends is one its schema accepts, and every field in it
// is one the schema reads (a schema drops fields it does not know, so a
// renamed field would otherwise be ignored without a word). A compile-time
// check: a schema or payload that no longer fits is an error on its line here.
type Accepts<S extends z.ZodType, P> = [P] extends [z.input<S>] ? ([Exclude<keyof P, keyof z.input<S>>] extends [never] ? true : false) : false;
type Fits<E extends ClientEventName> = Accepts<Schemas[E], ClientPayloads[E]>;
type Check<T extends true> = T;
export type PayloadsFitTheSchemas = [
	Check<Fits<"presence:visibility">>,
	Check<Fits<"message:send">>,
	Check<Fits<"messages:forward">>,
	Check<Fits<"message:edit">>,
	Check<Fits<"messages:delete">>,
	Check<Fits<"message:pin">>,
	Check<Fits<"reaction:add">>,
	Check<Fits<"message:seen">>,
	Check<Fits<"typing:start">>,
	Check<Fits<"typing:stop">>,
	Check<Fits<"conversation:join">>,
	Check<Fits<"conversation:leave">>,
];
