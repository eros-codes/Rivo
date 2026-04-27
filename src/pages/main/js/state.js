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
};

// ─── Contacts ─────────────────────────────────────────────────────────────────
export const contacts = [];

// ─── Messages ─────────────────────────────────────────────────────────────────
export const messages = {};