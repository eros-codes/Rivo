// ─── Shared mutable state ─────────────────────────────────────────────────────
export const state = {
	contactUserId: null,
	actionPreviewHeight: 0,
	touchTimeout: null,
	isMenuOpen: false,
	msgIndex: null,
	selectedMsg: null,
	isEditing: false,
	replyTo: null,
	isForwarding: false,
	forwardingMsg: null,
	forwardingMsgs: [],
	deleting: null,
	deletingTimeouts: [],
	isSelectionForwarding: false,
	pinnedIndexes: [],
	isProgrammaticScroll: false,
	isSelecting: false,
	selectedMessages: [],
	currentUndoAction: null,
	isProfileDialogOpen : false,
	skipShowChatOnProfileClose: false,
	// Send mode: canonical source-of-truth for how the next send should be performed.
	// Possible values: 'normal', 'one-time', 'time-capsule'
	sendMode: "normal",
	// When true, the UI should not trigger scroll-top pagination (used
	// during initial load to avoid accidental background fetches).
	suppressScrollLoad: false,
};

// ─── Contacts ─────────────────────────────────────────────────────────────────
export const contacts = [];

// ─── Messages ─────────────────────────────────────────────────────────────────
export const messages = {};

export function getMessageByIndex(contactId, index) {
	if (!messages[contactId] || typeof index === "undefined") return null;
	const i = Number(index);
	if (!Number.isInteger(i) || i < 0 || i >= messages[contactId].length) return null;
	return messages[contactId][i] || null;
}

export function findMessageById(messageId) {
	for (const [uid, msgs] of Object.entries(messages)) {
		if (!Array.isArray(msgs)) continue;
		const idx = msgs.findIndex((m) => m.id === messageId);
		if (idx !== -1) return { contactId: Number(uid), index: idx, message: msgs[idx] };
	}
	return null;
}