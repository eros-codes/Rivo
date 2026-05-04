import { parseSvg } from "../../utils/svg.js";

const seenIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.3"></circle><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10s10-4.47 10-10S17.53 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8s8 3.58 8 8s-3.58 8-8 8"></path></svg>`;
const sentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"></path></svg>`;
const pinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="currentColor" d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"></path></svg>`;

// This file contains functions related to creating and manipulating message elements in the chat, as well as the context menu for messages.
export function escapeHtml(str) {
	if (!str) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function createMessage({
	id = null,
	user,
	text,
	time,
	index,
	_localId = null,
	isEdited = false,
	replyTo = null,
	forwardedFrom = null,
	isSeen = false,
	isPinned = false,
}) {
	const message = document.createElement("div");

	// Prepare reply attributes (support both id and index-based refs)
	let _replyAttr = "";
	let _replySender = "";
	if (replyTo) {
		_replyAttr = replyTo.id ?? (typeof replyTo.index !== "undefined" ? replyTo.index : "");
		_replySender = replyTo.sender ?? replyTo.name ?? "";
	}

	// "user ?" means that if the sender is user itself or not
	message.className = `chat-message ${user ? "outgoing" : "incoming"}`;
	if (typeof index !== "undefined") message.dataset.index = index; // Add index to message element for styling purposes
	if (id) message.dataset.messageId = id;
	if (_localId) message.dataset.localId = _localId;
	// Build DOM safely using textContent and DOM nodes
	if (replyTo) {
		const replyDiv = document.createElement("div");
		replyDiv.className = "chat-reply";
		if (_replyAttr) replyDiv.dataset.replyTo = String(_replyAttr);

		const senderSpan = document.createElement("span");
		senderSpan.className = "chat-reply-sender";
		senderSpan.textContent = _replySender || "";

		const replyText = document.createElement("span");
		replyText.className = "chat-reply-text";
		replyText.textContent = replyTo.text || "";

		replyDiv.appendChild(senderSpan);
		replyDiv.appendChild(replyText);
		message.appendChild(replyDiv);
	}

	if (forwardedFrom) {
		const fwd = document.createElement("div");
		fwd.className = "chat-forwarded-label";
		fwd.textContent = "Forwarded from " + forwardedFrom;
		message.appendChild(fwd);
	}

	const p = document.createElement("p");
	p.className = "chat-message-text";
	p.textContent = text || "";
	message.appendChild(p);

	const meta = document.createElement("span");
	meta.className = "chat-message-meta";

	if (user && isPinned) {
		const pinSpan = document.createElement("span");
		pinSpan.className = "chat-pinned-icon";
		const _svg = parseSvg(pinIcon);
		if (_svg) pinSpan.appendChild(_svg.cloneNode(true));
		meta.appendChild(pinSpan);
	}

	if (user && isEdited) {
		const edited = document.createElement("span");
		edited.className = "chat-edited-label";
		edited.textContent = "edited";
		meta.appendChild(edited);
	}

	const timeEl = document.createElement("span");
	timeEl.className = "chat-message-time";
	timeEl.textContent = time || "";
	meta.appendChild(timeEl);

	if (!user && isEdited) {
		const edited = document.createElement("span");
		edited.className = "chat-edited-label";
		edited.textContent = "edited";
		meta.appendChild(edited);
	}

	if (user && isSeen) {
		const status = document.createElement("span");
		status.className = "chat-message-status";
		const _s = parseSvg(seenIcon);
		if (_s) status.appendChild(_s.cloneNode(true));
		meta.appendChild(status);
	} else if (user && !isSeen) {
		const status = document.createElement("span");
		status.className = "chat-message-status";
		const _s = parseSvg(sentIcon);
		if (_s) status.appendChild(_s.cloneNode(true));
		meta.appendChild(status);
	}

	if (!user && isPinned) {
		const pinSpan = document.createElement("span");
		pinSpan.className = "chat-pinned-icon";
		const _svg2 = parseSvg(pinIcon);
		if (_svg2) pinSpan.appendChild(_svg2.cloneNode(true));
		meta.appendChild(pinSpan);
	}

	message.appendChild(meta);

	return message;
}

export function markMessagesAsSeen(chatEl, indices) {
	if (!chatEl) return;

	if (Array.isArray(indices) && indices.length > 0) {
		indices.forEach((idx) => {
			const el = chatEl.querySelector(`.chat-message[data-index="${idx}"] .chat-message-status`);
			if (el) {
				el.textContent = '';
				const _s = parseSvg(seenIcon);
				if (_s) el.appendChild(_s.cloneNode(true));
			}
		});
		return;
	}

	chatEl
		.querySelectorAll(".chat-message.outgoing .chat-message-status")
		.forEach((el) => {
			el.textContent = '';
			const _s = parseSvg(seenIcon);
			if (_s) el.appendChild(_s.cloneNode(true));
		});
}