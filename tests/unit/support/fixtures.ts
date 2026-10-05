// Small builders for the shapes the client works with, with sensible
// defaults: a test names only what it is about.
import type { ContactRow, LiveMessage, MessagePreview, Tombstone } from "../../../client/shared/api/types";
import type { ConvCache, Pending } from "../../../client/chat/state/types";

export const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();

export function msg(id: number, over: Partial<LiveMessage> = {}): LiveMessage {
	return {
		id,
		conversationId: 1,
		senderId: 2,
		text: `m${id}`,
		isSeen: false,
		isEdited: false,
		isPinned: false,
		isDeleted: false,
		isOneTime: false,
		isTimeCapsule: false,
		scheduledFor: null,
		openedAt: null,
		isLocked: false,
		replyToId: null,
		replyToName: null,
		replyToSenderId: null,
		replyToText: null,
		forwardedText: null,
		forwardedFrom: null,
		reactions: [],
		createdAt: at(id),
		updatedAt: at(id),
		...over,
	};
}

export function tomb(id: number, over: Partial<Tombstone> = {}): Tombstone {
	return { id, conversationId: 1, senderId: 2, isDeleted: true, createdAt: at(id), updatedAt: at(100 + id), ...over };
}

export function cache(messages: LiveMessage[], over: Partial<ConvCache> = {}): ConvCache {
	return {
		messages,
		hasMore: false,
		cursor: at(0),
		status: "ready",
		loadingOlder: false,
		staleSince: null,
		pinned: [],
		gone: {},
		usedAt: 0,
		...over,
	};
}

export function preview(id: number, over: Partial<MessagePreview> = {}): MessagePreview {
	return {
		id,
		conversationId: 1,
		senderId: 2,
		text: `m${id}`,
		createdAt: at(id),
		isDeleted: false,
		isEdited: false,
		isPinned: false,
		isSeen: false,
		isOneTime: false,
		isTimeCapsule: false,
		isLocked: false,
		scheduledFor: null,
		openedAt: null,
		...over,
	};
}

export function row(conversationId: number, over: Partial<ContactRow> = {}): ContactRow {
	return {
		id: conversationId * 10,
		ownerId: 1,
		contactId: conversationId + 100,
		conversationId,
		nickname: null,
		isPinned: false,
		pinOrder: null,
		isMuted: false,
		isBlocked: false,
		isArchived: false,
		isSaved: false,
		unreadCount: 0,
		contact: {
			id: conversationId + 100,
			name: `Person ${conversationId}`,
			username: `p${conversationId}`,
			bio: null,
			profilePics: [],
			isOnline: false,
			lastSeen: null,
			email: null,
			isDeleted: false,
		},
		lastMessage: null,
		conversation: null,
		...over,
	};
}

export function pending(clientId: string, over: Partial<Pending> = {}): Pending {
	return {
		clientId,
		conversationId: 1,
		text: clientId,
		createdAt: at(50),
		replyTo: null,
		forwardedFrom: null,
		forwardOf: null,
		isOneTime: false,
		isTimeCapsule: false,
		scheduledFor: null,
		status: "queued",
		error: null,
		batchId: null,
		...over,
	};
}
