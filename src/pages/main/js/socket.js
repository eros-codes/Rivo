import { io } from "socket.io-client";

let socket = null;
let _onOnetimeDeleted = null;
let _capsuleOpenedHandler = null;
let _activeConversationId = null;

// Without a timeout, an unanswered socket acknowledgement can leave the UI
// stuck forever in a sending or saving state.
function emitWithAck(event, payload, { timeout = 10000, transform } = {}) {
	return new Promise((resolve, reject) => {
		if (!socket) return reject(new Error("Socket not connected"));
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("Request timed out"));
		}, timeout);

		socket.emit(event, payload, (res) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (res?.error) return reject(new Error(res.error));
			resolve(transform ? transform(res) : res);
		});
	});
}

function _showStatus(text) {
	const el = document.getElementById("connection-status");
	const textEl = document.getElementById("connection-status-text");
	if (!el || !textEl) return;
	textEl.textContent = text;
	el.classList.add("visible");
}

function _hideStatus() {
	const el = document.getElementById("connection-status");
	if (!el) return;
	el.classList.remove("visible");
}

// Named callbacks avoid silent breakage when a handler is added or reordered.
export function initSocket({
	onMessage,
	onMessageEdited,
	onMessageDeleted,
	onMessagesBulkDeleted,
	onUserOnline,
	onUserOffline,
	onMessageSeen,
	onTypingStart,
	onTypingStop,
	onMessagePinned,
	onUserUpdated,
	onContactRemoved,
	onReactionUpdated,
} = {}) {
	socket = io({
		withCredentials: true,
	});

	socket.on("message:new", (message) => {
		onMessage(message);
	});

	socket.on("message:edited", (data) => {
		onMessageEdited(data);
	});

	socket.on("message:deleted", (data) => {
		onMessageDeleted(data);
	});

	socket.on("messages:bulk-deleted", (data) => {
		if (!Array.isArray(data?.messageIds)) return;
		try { onMessagesBulkDeleted?.(data); } catch (e) { /* ignore */ }
	});

	socket.on("user:online", ({ userId }) => {
		onUserOnline(userId);
	});

	socket.on("user:offline", ({ userId, lastSeen }) => {
		onUserOffline(userId, lastSeen);
	});

	socket.on("message:seen", (data) => {
		onMessageSeen(data);
	});

	socket.on("message:pinned", (data) => {
		onMessagePinned?.(data);
	});

	socket.on("reaction:updated", (data) => {
		onReactionUpdated?.(data);
	});

	socket.on("message:onetime-deleted", (data) => {
		try { _onOnetimeDeleted?.(data); } catch (e) { /* ignore */ }
	});

	socket.on("message:capsule:opened", (payload) => {
		try { _capsuleOpenedHandler?.(payload); } catch (e) { /* ignore */ }
	});

	socket.on("user:updated", (user) => {
		try {
			onUserUpdated?.(user);
		} catch (e) {
			/* ignore handler errors */
		}
	});

	socket.on("contact:removed", (payload) => {
		try {
			onContactRemoved?.(payload);
		} catch (e) {
			/* ignore */
		}
	});

	socket.on("typing:start", ({ userId }) => onTypingStart?.(userId));

	socket.on("typing:stop", ({ userId }) => onTypingStop?.(userId));

	socket.on("connect", () => {
		_hideStatus();
		if (_activeConversationId) {
			try {
				socket.emit("conversation:join", { conversationId: _activeConversationId });
			} catch (e) {
				/* ignore reconnect join failures */
			}
		}
	});

	socket.on("disconnect", () => {
		_showStatus("Connecting...");
	});

	socket.on("reconnect_attempt", () => {
		_showStatus("Connecting...");
	});

	// Proactively disconnect when the page is being unloaded or hidden
	// so the server receives the disconnect event faster (helps presence).
	if (typeof window !== "undefined") {
		window.addEventListener("beforeunload", () => {
			try {
				socket?.disconnect();
			} catch (e) {
				/* ignore */
			}
		});

		window.addEventListener("pagehide", () => {
			try {
				socket?.disconnect();
			} catch (e) {
				/* ignore */
			}
		});
	}

	return socket;
}

export function getSocket() {
	return socket;
}

export function setActiveConversation(conversationId) {
	_activeConversationId = conversationId || null;
}

export function emitMessage({ conversationId, text, replyToId, replyToName, replyToText, forwardedFrom, forwardedText, isOneTime = false, isTimeCapsule = false, scheduledFor = null }) {
	return emitWithAck("message:send", {
		conversationId, text, replyToId, replyToName, replyToText,
		forwardedFrom, forwardedText, isOneTime, isTimeCapsule, scheduledFor,
	}, { transform: (res) => res?.message || res });
}

export function emitEditMessage(messageId, text) {
	return emitWithAck("message:edit", { messageId, text });
}

export function emitDeleteMessage(messageId) {
	return emitWithAck("message:delete", { messageId });
}

export function emitTypingStart(conversationId) {
	if (!socket) return;
	socket.emit("typing:start", { conversationId });
}

export function emitTypingStop(conversationId) {
	if (!socket) return;
	socket.emit("typing:stop", { conversationId });
}

export function emitMessageSeen(conversationId) {
	return emitWithAck("message:seen", { conversationId }, { transform: (res) => res?.marked || [] });
}

export function emitPinMessage(messageId) {
	return emitWithAck("message:pin", { messageId }, { transform: (res) => res?.isPinned });
}

export function emitReaction(messageId, emoji) {
	return emitWithAck("reaction:add", { messageId, emoji });
}

export function setOnetimeDeletedHandler(fn) {
 	_onOnetimeDeleted = fn;
}

export function setCapsuleOpenedHandler(fn) { _capsuleOpenedHandler = fn; }