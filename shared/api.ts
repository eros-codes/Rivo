// The contract between the app and the server over HTTP: every endpoint the
// app uses, what it sends (the input schema's type, shared/schemas) and what
// it gets back. Both sides are type-checked against this file, so a field
// renamed on one side is an error on the other before anything runs.
//
// Dates travel as ISO strings.
import type { z } from "zod";
import type { ChangePassword, DeleteAccount, Privacy, PushSubscriptionInput, PushUnsubscribe, UpdateProfile } from "./schemas/account.ts";
import type { Login, Logout, Register, RequestPasswordReset, ResetPassword, SendCode, VerifyCode } from "./schemas/auth.ts";
import type { AddContact, UpdateContact } from "./schemas/contacts.ts";
import type { DeleteMessages, EditMessage, ForwardMessages, SendMessage } from "./schemas/messages.ts";

export type { Privacy };

/** The signed-in user (GET /api/users/me). */
export interface Me {
	id: number;
	name: string;
	username: string;
	email: string;
	bio: string;
	profilePics: string[];
	isOnline?: boolean;
	lastSeen?: string | null;
	privacyOnline: Privacy;
	privacyEmail: Privacy;
	privacyProfile: Privacy;
	createdAt?: string;
}

/** Another person as the signed-in user may see them (privacy applied). */
export interface Person {
	id: number;
	name: string;
	username: string;
	bio: string | null;
	profilePics: string[];
	isOnline: boolean;
	lastSeen: string | null;
	email: string | null;
	isDeleted: boolean;
}

/** A search result (GET /api/users/search), privacy applied. */
export interface PersonFound {
	id: number;
	name: string;
	username: string;
	bio: string | null;
	profilePics: string[];
}

/** The short form of a chat's newest message (contact list previews). */
export interface MessagePreview {
	id: number;
	conversationId: number;
	senderId: number;
	/** null when the viewer may not read it (sealed capsule, someone else's one-time message) */
	text: string | null;
	createdAt: string;
	isDeleted: boolean;
	isEdited: boolean;
	isPinned: boolean;
	isSeen: boolean;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	isLocked: boolean;
	scheduledFor: string | null;
	openedAt: string | null;
}

/** One row of the contact list: a person (or Saved Messages) and the chat with them. */
export interface ContactRow {
	id: number;
	ownerId: number;
	contactId: number;
	conversationId: number;
	nickname: string | null;
	isPinned: boolean;
	pinOrder: number | null;
	isMuted: boolean;
	isBlocked: boolean;
	isArchived: boolean;
	isSaved: boolean;
	unreadCount: number;
	contact: Person | null;
	lastMessage: MessagePreview | null;
	conversation: { id: number; createdAt: string; lastMessageAt: string | null } | null;
}

export interface Reaction {
	userId: number;
	emoji: string;
}

/** A message as the viewer may see it. */
export interface LiveMessage {
	id: number;
	conversationId: number;
	senderId: number;
	/** null while it is someone else's sealed time capsule */
	text: string | null;
	isSeen: boolean;
	isEdited: boolean;
	isPinned: boolean;
	isDeleted: false;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	scheduledFor: string | null;
	openedAt: string | null;
	isLocked: boolean;
	replyToId: number | null;
	replyToName: string | null;
	replyToSenderId: number | null;
	replyToText: string | null;
	forwardedText: string | null;
	forwardedFrom: string | null;
	reactions: Reaction[];
	createdAt: string;
	updatedAt: string;
	/** the id the sending device gave it (only sent to the sender) */
	clientId?: string;
}

/** What is left of a deleted message. */
export interface Tombstone {
	id: number;
	conversationId: number;
	senderId: number;
	isDeleted: true;
	createdAt: string;
	updatedAt: string;
	/** (only to the sender) */
	clientId?: string;
}

export type WireMessage = LiveMessage | Tombstone;

export interface MessagePage {
	/** oldest first */
	messages: WireMessage[];
	hasMore: boolean;
	/** the moment the page was read; pass to /changes later */
	cursor: string;
}

export interface ChangesResult {
	/** too much changed: load the chat again */
	reset: boolean;
	messages: WireMessage[];
	cursor: string;
}

export interface PinnedItem {
	id: number;
	text: string | null;
	senderId: number;
	createdAt: string;
}

export interface SearchHit {
	id: number;
	messageId: number;
	conversationId: number;
	senderId: number;
	text: string;
	createdAt: string;
	isEdited: boolean;
	isPinned: boolean;
	isSeen: boolean;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	isLocked: boolean;
	scheduledFor: string | null;
	openedAt: string | null;
}

export interface DeviceSession {
	id: string;
	current: boolean;
	createdAt: string;
	lastSeenAt: string;
	userAgent: string;
}

/** What a send / forward / edit / … answers (over REST and as a socket ack). */
export interface Sent {
	message: WireMessage;
	/** the same clientId was stored already: this is that message */
	duplicate?: boolean;
}
export interface Forwarded {
	messages: WireMessage[];
	/** how many of the items were not forwarded */
	failed: number;
	failures?: { clientId: string | null; error: string }[];
}
export interface Edited {
	text: string;
	updatedAt: string;
}
export interface Deleted {
	deleted: number[];
}
export interface Pinned {
	isPinned: boolean;
}
export interface Reacted {
	action: "added" | "changed" | "removed";
	reactions: Reaction[];
}
export interface Seen {
	marked: number[];
	unreadCount?: number;
}

/** A plain "done". */
export interface Done {
	success: true;
}

type In<S extends z.ZodType> = z.input<S>;

/**
 * Every endpoint the app (and the tests' client) uses: what goes in, what
 * comes back. A path parameter is written :name; query strings are built by
 * the caller.
 */
export interface Endpoints {
	"POST /api/auth/send-code": { body: In<typeof SendCode>; response: Done };
	"POST /api/auth/verify-code": { body: In<typeof VerifyCode>; response: Done };
	"POST /api/auth/check-availability": { body: { username: string }; response: { usernameTaken: boolean } };
	"POST /api/auth/register": { body: In<typeof Register>; response: Done & { userId: number } };
	"POST /api/auth/login": { body: In<typeof Login>; response: Done & { user: Me } };
	"POST /api/auth/logout": { body: In<typeof Logout>; response: Done };
	"POST /api/auth/request-password-reset": { body: In<typeof RequestPasswordReset>; response: Done };
	"POST /api/auth/reset-password-with-token": { body: In<typeof ResetPassword>; response: Done };

	"GET /api/users/me": { response: Me };
	"PATCH /api/users/me": { body: In<typeof UpdateProfile>; response: Me };
	"POST /api/users/me/avatar": { body: FormData; response: { url: string } };
	"PATCH /api/users/me/password": { body: In<typeof ChangePassword>; response: Done & { signedOut: number } };
	"DELETE /api/users/me": { body: In<typeof DeleteAccount>; response: Done };
	"GET /api/users/search": { response: PersonFound[] };

	"GET /api/sessions": { response: { sessions: DeviceSession[] } };
	"POST /api/sessions/revoke-others": { response: Done & { revoked: number } };
	"DELETE /api/sessions/:id": { response: Done };

	"GET /api/contacts": { response: ContactRow[] };
	"GET /api/contacts/:id": { response: ContactRow };
	"POST /api/contacts": { body: In<typeof AddContact>; response: ContactRow };
	"PATCH /api/contacts/:id": { body: In<typeof UpdateContact>; response: ContactRow };
	"DELETE /api/contacts/:id": { response: Done };

	"GET /api/conversations/:id/messages": { response: MessagePage };
	"GET /api/conversations/:id/changes": { response: ChangesResult };
	"GET /api/conversations/:id/pinned": { response: { pinned: PinnedItem[] } };
	"DELETE /api/conversations/:id/messages": { response: Done };

	"GET /api/messages/search": { response: { results: SearchHit[]; truncated: boolean } };
	"POST /api/messages": { body: In<typeof SendMessage>; response: WireMessage };
	"POST /api/messages/forward": { body: In<typeof ForwardMessages>; response: Done & Forwarded & { error?: string } };
	"POST /api/messages/delete": { body: In<typeof DeleteMessages>; response: Done & Deleted };
	"PATCH /api/messages/:id": { body: Omit<In<typeof EditMessage>, "messageId">; response: Done & Edited };
	"DELETE /api/messages/:id": { response: Done };
	"POST /api/messages/:id/pin": { response: Pinned };

	"GET /api/push/publicKey": { response: { publicKey: string } };
	"POST /api/push/subscribe": { body: In<typeof PushSubscriptionInput>; response: Done };
	"POST /api/push/unsubscribe": { body: In<typeof PushUnsubscribe>; response: Done };
}

export type Endpoint = keyof Endpoints;
/** What an endpoint takes as its JSON body. */
export type Body<E extends Endpoint> = Endpoints[E] extends { body: infer B } ? B : never;
/** What an endpoint answers with (2xx). */
export type Answer<E extends Endpoint> = Endpoints[E]["response"];
