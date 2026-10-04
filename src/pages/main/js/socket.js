import { io } from "socket.io-client";

let socket = null;
let _onOnetimeDeleted = null;
let _capsuleOpenedHandler = null;
let _activeConversationId = null;
let _onReconnect = null;
let _authFailureHandled = false;

function _isVisible() {
	try {
		return typeof document === "undefined" || document.visibilityState !== "hidden";
	} catch (e) {
		return true;
	}
}

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

// The session ended (logged out elsewhere, password changed, account
// deleted): go to the sign-in page instead of retrying forever.
function _endSession() {
	if (_authFailureHandled) return;
	_authFailureHandled = true;
	try {
		localStorage.removeItem("user");
	} catch (e) {
		/* ignore */
	}
	window.location.replace("/auth/auth.html");
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
	onReconnect,
} = {}) {
	_onReconnect = onReconnect || null;
	socket = io({
		withCredentials: true,
		// sent on every (re)connection: hidden tabs / backgrounded phones still
		// get push notifications and do not mark messages as seen
		auth: (cb) => cb({ visible: _isVisible() }),
	});

	socket.on("message:new", (message) => {
		onMessage?.(message);
	});

	socket.on("message:edited", (data) => {
		onMessageEdited?.(data);
	});

	socket.on("message:deleted", (data) => {
		onMessageDeleted?.(data);
	});

	socket.on("messages:bulk-deleted", (data) => {
		if (!Array.isArray(data?.messageIds)) return;
		try { onMessagesBulkDeleted?.(data); } catch (e) { /* ignore */ }
	});

	socket.on("user:online", ({ userId }) => {
		onUserOnline?.(userId);
	});

	socket.on("user:offline", ({ userId, lastSeen }) => {
		onUserOffline?.(userId, lastSeen);
	});

	socket.on("message:seen", (data) => {
		onMessageSeen?.(data);
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

	socket.on("session:ended", () => _endSession());

	let everConnected = false;
	socket.on("connect", () => {
		_hideStatus();
		if (_activeConversationId) {
			try {
				socket.emit("conversation:join", { conversationId: _activeConversationId });
			} catch (e) {
				/* ignore reconnect join failures */
			}
		}
		// Events sent while we were offline were missed: catch up.
		if (everConnected) {
			try {
				_onReconnect?.();
			} catch (e) {
				/* ignore */
			}
		}
		everConnected = true;
	});

	socket.on("disconnect", (reason) => {
		// "io server disconnect": the server ended this session on purpose
		if (reason === "io server disconnect") {
			_showStatus("Connecting...");
			// check whether we are still signed in; if not, leave
			fetch("/api/users/me", { credentials: "include" })
				.then((res) => {
					if (res.status === 401) _endSession();
					else socket.connect();
				})
				.catch(() => socket.connect());
			return;
		}
		_showStatus("Connecting...");
	});

	// The server refused the connection: an expired or revoked session is not
	// going to fix itself by retrying.
	socket.on("connect_error", (err) => {
		const msg = String(err && err.message || "");
		if (msg === "Unauthorized" || msg === "Invalid token" || msg === "TokenExpired") {
			fetch("/api/users/me", { credentials: "include" })
				.then((res) => {
					if (res.status === 401) _endSession();
					else setTimeout(() => socket.connect(), 2000);
				})
				.catch(() => setTimeout(() => socket.connect(), 3000));
			return;
		}
		// rate limited / server busy: the manager does not retry these itself
		if (!socket.active) setTimeout(() => socket.connect(), 3000);
	});

	socket.io?.on?.("reconnect_attempt", () => {
		_showStatus("Connecting...");
	});

	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => {
			try {
				if (socket?.connected) socket.emit("presence:visibility", { visible: _isVisible() });
			} catch (e) {
				/* ignore */
			}
		});
	}

	// Proactively disconnect when the page is being unloaded so the server
	// receives the disconnect event faster (helps presence). A page that is
	// only frozen in the back/forward cache comes back through "pageshow".
	if (typeof window !== "undefined") {
		window.addEventListener("pagehide", () => {
			try {
				socket?.disconnect();
			} catch (e) {
				/* ignore */
			}
		});
		window.addEventListener("pageshow", (ev) => {
			try {
				if (ev.persisted && socket && !socket.connected) socket.connect();
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

export function emitMessage({ conversationId, text, replyToId, replyToName, replyToText, forwardedFrom, forwardedText, isOneTime = false, isTimeCapsule = false, scheduledFor = null, clientMessageId = null }) {
	return emitWithAck("message:send", {
		conversationId, text, replyToId, replyToName, replyToText,
		forwardedFrom, forwardedText, isOneTime, isTimeCapsule, scheduledFor,
		...(clientMessageId ? { clientMessageId } : {}),
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
