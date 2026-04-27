import { io } from "/node_modules/socket.io-client/dist/socket.io.esm.min.js";

let socket = null;

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
) {
	const token = localStorage.getItem("token");

	socket = io({
		auth: { token },
	});

	socket.on("connect", () => {
		console.log("Socket connected");
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

	socket.on("disconnect", () => {
		console.log("Socket disconnected");
	});

	socket.on("message:seen", (data) => {
		onMessageSeen(data);
	});

	socket.on("typing:start", ({ userId }) => onTypingStart?.(userId));

	socket.on("typing:stop", ({ userId }) => onTypingStop?.(userId));

	socket.on("connect", () => {
		console.log("Socket connected");
		_hideStatus();
	});

	socket.on("disconnect", () => {
		console.log("Socket disconnected");
		_showStatus("Connecting...");
	});

	socket.on("reconnect_attempt", () => {
		_showStatus("Connecting...");
	});

	return socket;
}

export function getSocket() {
	return socket;
}

export function emitMessage(data) {
	return new Promise((resolve, reject) => {
		socket.emit("message:send", data, (res) => {
			if (res.error) reject(res.error);
			else resolve(res.message);
		});
	});
}

export function emitEditMessage(messageId, text) {
	socket.emit("message:edit", { messageId, text });
}

export function emitDeleteMessage(messageId) {
	socket.emit("message:delete", { messageId });
}

export function emitTypingStart(conversationId) {
	socket.emit("typing:start", { conversationId });
}

export function emitTypingStop(conversationId) {
	socket.emit("typing:stop", { conversationId });
}

export function emitMessageSeen(conversationId) {
	socket.emit("message:seen", { conversationId });
}
