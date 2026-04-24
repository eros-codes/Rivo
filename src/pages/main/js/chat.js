import {
	sendMessage as apiSendMessage,
	editMessage as apiEditMessage,
} from "./api.js";
import { state, messages, contacts } from "./state.js";
import { showEmptyState, hideEmptyState } from "./ui.js";
import { createMessage } from "../../../components/messages/messages.js";
import { moveToActiveChats, refreshCard, sortActiveChats } from "./chat-logic.js";

// ─── Constants ────────────────────────────────────────────────────────────────
export const basePadding = 4;
export const lineHeight = 22.4;
export const maxLines = 7;
export const maxHeight = lineHeight * maxLines;

let _dom = {};

/**

- @param {{
- chatPart, mainContent, peoplePart, chatEl, contactProfileDetails,
- messageInput, sendMessageBtn, msgAction, cancelEditBtn,
- pinnedMessageContainer, pinnedMessageText, pinnedMessageCount,
- chatHeader, emptyStateEl
- }} dom
  */
export function initChat(dom) {
	_dom = dom;
}

// ─── Scroll ───────────────────────────────────────────────────────────────────
export function scrollChatToBottom() {
	if (!_dom.chatEl) return;
	_dom.chatEl.scrollTop = _dom.chatEl.scrollHeight;
}

// ─── Open / Close ─────────────────────────────────────────────────────────────
export function openChat() {
	const isAlreadyOpen = _dom.chatPart.style.display === "flex";
	const isMobile = window.matchMedia("(max-width: 768px)").matches;

	_dom.chatPart.style.display = "flex";

	if (!isAlreadyOpen && isMobile) {
		_dom.chatPart.classList.remove("slide-out");
		_dom.chatPart.classList.add("slide-in");
		_dom.chatPart.addEventListener(
			"animationend",
			() => {
				_dom.chatPart.classList.remove("slide-in");
			},
			{ once: true },
		);
	}

	if (!isMobile) {
		_dom.mainContent.style.flexDirection = "column-reverse";
	} else {
		_dom.peoplePart.querySelector(".main-header").style.zIndex = "0";
		setTimeout(() => {
			_dom.peoplePart.querySelector(".main-header").style.display =
				"none";
		}, 200);
	}
	scrollChatToBottom();
}

export function closeChat() {
	const isMobile = window.matchMedia("(max-width: 768px)").matches;

	_dom.peoplePart.querySelector(".main-header").style.display = "";
	_dom.peoplePart.querySelector(".main-header").style.zIndex = "";
	_dom.peoplePart.style.display = "";

	if (isMobile) {
		_dom.chatPart.classList.remove("slide-in");
		_dom.chatPart.classList.add("slide-out");

		_dom.chatPart.addEventListener(
			"animationend",
			() => {
				_dom.chatPart.classList.remove("slide-out");
				_dom.chatPart.style.display = "none";
			},
			{ once: true },
		);
	} else {
		_dom.chatPart.style.display = "none";
		_dom.mainContent.style.flexDirection = "row-reverse";
	}
}
// ─── Reset input ──────────────────────────────────────────────────────────────
export function resetInput() {
	_dom.messageInput.value = "";
	_dom.messageInput.rows = 1;
	_dom.messageInput.style.height = "auto";
	_dom.messageInput.style.borderRadius = "2rem";
	_dom.sendMessageBtn.style.display = "none";
	state.actionPreviewHeight = 0;
	_dom.chatEl.style.paddingBottom = basePadding + "rem";
	_dom.msgAction.style.display = "none";
}

// ─── Pin count ────────────────────────────────────────────────────────────────
export function updatePinCount(activeIdx) {
	_dom.pinnedMessageCount.innerHTML = "";
	const total = Math.min(state.pinnedIndexes.length, 3);
	if (total === 0) return;

	const pos = state.pinnedIndexes.indexOf(activeIdx);
	let activeSpan;
	if (state.pinnedIndexes.length <= 3) {
		activeSpan = pos;
	} else {
		if (pos === 0) activeSpan = 0;
		else if (pos === state.pinnedIndexes.length - 1) activeSpan = 2;
		else activeSpan = 1;
	}

	for (let i = 0; i < total; i++) {
		const span = document.createElement("span");
		if (i === activeSpan) {
			span.style.height = "1.2rem";
			span.style.opacity = "1";
		} else {
			span.style.height = "0.6rem";
			span.style.opacity = "0.4";
		}
		_dom.pinnedMessageCount.appendChild(span);
	}
}

// ─── Pinned message bar ───────────────────────────────────────────────────────
export function updatePinnedMessage() {
	const userMessages = messages[state.contactUserId];
	const pinnedMsg = userMessages.findLast((msg) => msg.isPinned);
	if (pinnedMsg) {
		_dom.pinnedMessageContainer.style.display = "flex";
		_dom.pinnedMessageText.textContent = pinnedMsg.text;
		_dom.pinnedMessageText.dataset.index = pinnedMsg.index;
		_dom.chatHeader.style.borderRadius = "1rem 1rem 0 0";
	} else {
		_dom.pinnedMessageContainer.style.display = "none";
		_dom.pinnedMessageText.textContent = "";
		_dom.pinnedMessageText.dataset.index = "";
		_dom.chatHeader.style.borderRadius = "1rem";
	}
	updatePinCount(pinnedMsg ? pinnedMsg.index : null);
}

// ─── Inject messages ──────────────────────────────────────────────────────────
function formatDateLabel(dateStr) {
	const date = new Date(dateStr);
	const today = new Date();
	const yesterday = new Date();
	yesterday.setDate(today.getDate() - 1);

	if (dateStr === today.toISOString().slice(0, 10)) return "Today";
	if (dateStr === yesterday.toISOString().slice(0, 10)) return "Yesterday";
	return date.toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

function createDateSeparator(dateStr) {
	const el = document.createElement("div");
	el.className = "date-separator";
	el.innerHTML = `<span>${formatDateLabel(dateStr)}</span>`;
	return el;
}

export function injectMessages(userId) {
	if (!_dom.chatEl) return;
	const userMessages = messages[userId];
	if (!userMessages) {
		alert("No messages for this user");
		return;
	}

	_dom.chatEl.innerHTML = "";
	_dom.pinnedMessageContainer.style.display = "none";
	_dom.chatHeader.style.borderRadius = "1rem";
	state.pinnedIndexes = [];
	let lastDate = null;

	if (Array.isArray(userMessages) && userMessages.length === 0) {
		showEmptyState(_dom.chatEl, _dom.emptyStateEl);
		return;
	}
	hideEmptyState(_dom.chatEl, _dom.emptyStateEl);

	const fragment = document.createDocumentFragment();
	userMessages.forEach((message, index) => {
		message.index = index;

		if (message.date && message.date !== lastDate) {
			fragment.appendChild(createDateSeparator(message.date));
			lastDate = message.date;
		}

		fragment.appendChild(createMessage(message));
		if (message.isPinned) state.pinnedIndexes.push(index);
	});

	if (state.pinnedIndexes.length > 0) {
		state.pinnedIndexes.sort((a, b) => a - b);
		const lastIdx = state.pinnedIndexes[state.pinnedIndexes.length - 1];
		_dom.pinnedMessageText.textContent = messages[userId][lastIdx].text;
		_dom.pinnedMessageText.dataset.index = lastIdx;
		_dom.pinnedMessageContainer.style.display = "flex";
		_dom.chatHeader.style.borderRadius = "1rem 1rem 0 0";
		updatePinCount(lastIdx);
	}

	_dom.chatEl.appendChild(fragment);
}

// ─── Send message ─────────────────────────────────────────────────────────────
export function sendMessage() {
	// Edit mode
	if (state.isEditing) {
		if (
			_dom.messageInput.value.trim() === "" ||
			messages[state.contactUserId][Number(state.msgIndex)].text ===
				_dom.messageInput.value.trim()
		)
			return;
		const txt = _dom.messageInput.value;
		apiEditMessage(state.contactUserId, Number(state.msgIndex), txt);
		state.selectedMsg.querySelector(".chat-message-text").textContent = txt;

		if (!state.selectedMsg.querySelector(".chat-edited-label")) {
			const label = document.createElement("span");
			label.className = "chat-edited-label";
			label.textContent = "edited";
			state.selectedMsg
				.querySelector(".chat-message-meta")
				.prepend(label);
		}
		state.isEditing = false;
		resetInput();
		return;
	}

	// Forward mode
	if (state.isForwarding) {
		const msgsToSend =
			state.forwardingMsgs.length > 0
				? state.forwardingMsgs
				: [state.forwardingMsg];

		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
		msgsToSend.forEach((msg) => {
			apiSendMessage(state.contactUserId, msg);
			_dom.chatEl.appendChild(createMessage(msg));
		});

		state.forwardingMsgs = [];
		state.forwardingMsg = null;
		state.isForwarding = false;

		if (_dom.messageInput.value.trim() !== "") {
			sendMessage();
		} else {
			resetInput();
			const lastSent = msgsToSend.at(-1);
			const fwd = contacts.find((c) => c.id === state.contactUserId);
			if (fwd && lastSent) {
				fwd.lastMessage = lastSent.text;
				fwd.lastMessageTime = lastSent.time;
				fwd.lastMessageDate = lastSent.date;
				fwd.lastMessageSeen = false;
				refreshCard(fwd);
				sortActiveChats();
			} 
		}
		scrollChatToBottom();
		return;
	}

	// Normal send
	if (_dom.messageInput.value.trim() === "") return;

	const now = new Date()
	const obj = {
		user: true,
		text: _dom.messageInput.value,
		time: now.toLocaleTimeString([], { hour: "2-digit",minute: "2-digit", hour12: false,}),
		date: now.toISOString().slice(0, 10),
		isEdited: false,
		replyTo: state.replyTo,
		seen: false,
	};
	hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
	apiSendMessage(state.contactUserId, obj);
	_dom.chatEl.appendChild(createMessage(obj));

	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (friend) {
		friend.lastMessage = obj.text;
		friend.lastMessageTime = obj.time;
		friend.lastMessageDate = obj.date;
		friend.lastMessageSeen = false;

		refreshCard(friend);
		sortActiveChats();
	}
	scrollChatToBottom();
	resetInput();
	state.replyTo = null;
	document.querySelector(".message-input").focus();
}
