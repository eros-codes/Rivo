// What the server sends and accepts (the wire format). Dates are ISO strings.

export type Privacy = "everyone" | "contacts" | "nobody";

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

// ─── Real-time events ─────────────────────────────────────────────────────

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

export interface ForwardItem {
	forwardOf: number;
	clientId: string;
}

export type Ack<T> = (T & { success: true; error?: undefined }) | { success?: undefined; error: string };

export interface ClientEvents {
	"presence:visibility": [{ visible: boolean }];
	/** a re-send of a message deleted meanwhile answers with its tombstone */
	"message:send": [SendPayload, (ack: Ack<{ message: WireMessage; duplicate?: boolean }>) => void];
	"messages:forward": [
		{ conversationId: number; items: ForwardItem[] },
		(ack: Ack<{ messages: WireMessage[]; failed: number }> | { success: true; messages: WireMessage[]; error: string }) => void,
	];
	"message:edit": [{ messageId: number; text: string }, (ack: Ack<{ text: string; updatedAt: string }>) => void];
	"messages:delete": [{ messageIds: number[] }, (ack: Ack<{ deleted: number[] }>) => void];
	"message:pin": [{ messageId: number }, (ack: Ack<{ isPinned: boolean }>) => void];
	"reaction:add": [{ messageId: number; emoji: string }, (ack: Ack<{ action: string; reactions: Reaction[] }>) => void];
	"message:seen": [{ conversationId: number; upToId: number }, (ack: Ack<{ marked: number[]; unreadCount?: number }>) => void];
	"typing:start": [{ conversationId: number }];
	"typing:stop": [{ conversationId: number }];
	"conversation:join": [{ conversationId: number }];
	"conversation:leave": [{ conversationId: number }];
}
