import { io } from "/js/socket.io.esm.min.js";

let socket = null;
let _onOnetimeDeleted = null;
let _capsuleOpenedHandler = null;

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

export function initSocket(
	onMessage,
	onMessageEdited,
	onMessageDeleted,
	onUserOnline,
	onUserOffline,
	onMessageSeen,
	onTypingStart,
	onTypingStop,
	onMessagePinned,
	onUserUpdated,
	onContactRemoved,
	onReactionUpdated,
		onOnetimeDeleted,
) {
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

export function emitMessage({ conversationId, text, replyToId, replyToName, replyToText, forwardedFrom, forwardedText, isOneTime = false, isTimeCapsule = false, scheduledFor = null }) {
	return new Promise((resolve, reject) => {
 		if (!socket) return reject(new Error("No socket"));
 		socket.emit("message:send", {
			 conversationId, text, replyToId, replyToName, replyToText,
			 forwardedFrom, forwardedText, isOneTime,
			 isTimeCapsule,
			 scheduledFor,
 		}, (res) => {
 			if (res?.error) return reject(new Error(res.error));
 			resolve(res?.message || res);
 		});
 	});
}

export function emitEditMessage(messageId, text) {
	return new Promise((resolve, reject) => {
		if (!socket) return reject(new Error("Socket not connected"));
		socket.emit("message:edit", { messageId, text }, (res) => {
			if (res?.error) reject(res.error);
			else resolve(res);
		});
	});
}

export function emitDeleteMessage(messageId) {
	return new Promise((resolve, reject) => {
		if (!socket) return reject(new Error("Socket not connected"));
		socket.emit("message:delete", { messageId }, (res) => {
			if (res?.error) reject(res.error);
			else resolve(res);
		});
	});
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
	return new Promise((resolve, reject) => {
		if (!socket) return reject(new Error("Socket not connected"));
		socket.emit("message:seen", { conversationId }, (res) => {
			if (res?.error) return reject(res.error);
			return resolve(res?.marked || []);
		});
	});
}

export function emitPinMessage(messageId) {
	return new Promise((resolve, reject) => {
		if (!socket) return reject(new Error("Socket not connected"));
		socket.emit("message:pin", { messageId }, (res) => {
			if (res?.error) reject(res.error);
			else resolve(res?.isPinned);
		});
	});
}

export function emitReaction(messageId, emoji) {
	return new Promise((resolve, reject) => {
		if (!socket) return reject(new Error("Socket not connected"));
		socket.emit("reaction:add", { messageId, emoji }, (res) => {
			if (res?.error) return reject(res.error);
			return resolve(res);
		});
	});
}

export function setOnetimeDeletedHandler(fn) {
 	_onOnetimeDeleted = fn;
}

export function setCapsuleOpenedHandler(fn) { _capsuleOpenedHandler = fn; }