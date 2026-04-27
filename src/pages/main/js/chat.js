import { state, messages, contacts } from "./state.js";
import { showEmptyState, hideEmptyState } from "./ui.js";
import { createMessage, markMessagesAsSeen } from "../../../components/messages/messages.js";
import {
	moveToActiveChats,
	refreshCard,
	sortActiveChats,
} from "./chat-logic.js";
import { emitMessage, emitEditMessage, emitMessageSeen } from "./socket.js";
import { getMessages } from "./api.js";

// ─── Constants ────────────────────────────────────────────────────────────────
export const basePadding = 4;
export const lineHeight = 22.4;
export const maxLines = 7;
export const maxHeight = lineHeight * maxLines;

let _dom = {};

export function initChat(dom) {
	_dom = dom;
}

// ─── Scroll ───────────────────────────────────────────────────────────────────
export function scrollChatToBottom() {
	if (!_dom.chatEl) return;
	_dom.chatEl.scrollTop = _dom.chatEl.scrollHeight;
}

// ─── Open / Close ─────────────────────────────────────────────────────────────
export async function openChat(fromClick = false) {
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

	// load messages از backend
	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (contact?.conversationId) {
		try {
			const serverMessages = await getMessages(contact.conversationId);
			// normalize برای فرانت
			messages[state.contactUserId] = serverMessages.map((m) => ({
				id: m.id,
				user: m.senderId === _currentUserId(),
				text: m.text,
				time: new Date(m.createdAt).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				}),
				date: new Date(m.createdAt).toISOString().slice(0, 10),
				isEdited: m.isEdited,
				isPinned: m.isPinned,
				isSeen: m.isSeen,
				replyTo: m.replyToId
					? {
							name: m.replyToName,
							text: m.replyToText,
						}
					: null,
				forwardedFrom: m.forwardedFrom || null,
				forwardedText: m.forwardedText || null,
			}));
		} catch {
			messages[state.contactUserId] = [];
		}
	}

	injectMessages(state.contactUserId);
	if (contact?.conversationId && fromClick) {
		emitMessageSeen(contact.conversationId);
	}
	if (contact?.isOnline) {
		_dom.chatProfilePicture.classList.add("online");
	} else {
		_dom.chatProfilePicture.classList.remove("online");
	}
	scrollChatToBottom();
}

function _currentUserId() {
	return JSON.parse(sessionStorage.getItem("user") || "{}").id;
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
		showEmptyState(_dom.chatEl, _dom.emptyStateEl);
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

// ─── Receive incoming message (from socket) ───────────────────────────────────
export function receiveMessage(message) {
	const contact = contacts.find(
		(c) => c.conversationId === message.conversationId,
	);
	if (!contact) return;

	const normalized = {
		id: message.id,
		user: false,
		text: message.text,
		time: new Date(message.createdAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}),
		date: new Date(message.createdAt).toISOString().slice(0, 10),
		isEdited: false,
		isPinned: false,
		isSeen: message.isSeen || false,
		replyTo: message.replyToId
			? {
					name: message.replyToName,
					text: message.replyToText,
				}
			: null,
	};

	if (!messages[contact.id]) messages[contact.id] = [];
	messages[contact.id].push(normalized);

	// اگه همین چت بازه نشون بده
	if (state.contactUserId === contact.id) {
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
		normalized.index = messages[contact.id].length - 1;
		_dom.chatEl.appendChild(createMessage(normalized));
		scrollChatToBottom();
		emitMessageSeen(contact.conversationId);
	}

	// کارت رو آپدیت کن
	contact.lastMessage = normalized.text;
	contact.lastMessageTime = normalized.time;
	contact.lastMessageDate = normalized.date;
	contact.lastMessageSeen = false;
	if (state.contactUserId !== contact.id) {
		contact.unreadCount = (contact.unreadCount || 0) + 1;
	}

	moveToActiveChats(contact);
	refreshCard(contact);
	sortActiveChats();
}

// ─── Send message ─────────────────────────────────────────────────────────────
export async function sendMessage() {
	// Edit mode
	if (state.isEditing) {
		if (
			_dom.messageInput.value.trim() === "" ||
			messages[state.contactUserId][Number(state.msgIndex)].text ===
				_dom.messageInput.value.trim()
		)
			return;

		const txt = _dom.messageInput.value;
		const msg = messages[state.contactUserId][Number(state.msgIndex)];

		emitEditMessage(msg.id, txt);

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

		const contact = contacts.find((c) => c.id === state.contactUserId);
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);

		for (const msg of msgsToSend) {
			try {
				const sent = await emitMessage({
					conversationId: contact.conversationId,
					text: msg.text,
					forwardedFrom: msg.forwardedFrom || msg.user ? "You" : null,
					forwardedText: msg.text,
				});
				const normalized = _normalizeOutgoing(sent);
				messages[state.contactUserId].push(normalized);
				_dom.chatEl.appendChild(createMessage(normalized));
			} catch {
				/* silent */
			}
		}

		state.forwardingMsgs = [];
		state.forwardingMsg = null;
		state.isForwarding = false;

		if (_dom.messageInput.value.trim() !== "") {
			await sendMessage();
		} else {
			resetInput();
			_updateContactCard();
		}
		scrollChatToBottom();
		return;
	}

	// Normal send
	if (_dom.messageInput.value.trim() === "") return;

	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (!contact) return;

	const text = _dom.messageInput.value;
	const replyTo = state.replyTo;

	// optimistic UI
	const now = new Date();
	const optimistic = {
		user: true,
		text,
		time: now.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}),
		date: now.toISOString().slice(0, 10),
		isEdited: false,
		isPinned: false,
		replyTo,
		isSeen: false,
	};

	hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
	if (!messages[state.contactUserId]) messages[state.contactUserId] = [];
	optimistic.index = messages[state.contactUserId].length;
	messages[state.contactUserId].push(optimistic);
	_dom.chatEl.appendChild(createMessage(optimistic));

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	document.querySelector(".message-input").focus();

	// send via socket
	try {
		const sent = await emitMessage({
			conversationId: contact.conversationId,
			text,
			replyToId: replyTo?.id || null,
			replyToName: replyTo?.name || null,
			replyToText: replyTo?.text || null,
		});
		// id واقعی رو بذار
		optimistic.id = sent.id;
		optimistic.isSeen = sent.isSeen || false;
	} catch {
		console.error("Failed to send message");
	}

	_updateContactCard();
}

function _normalizeOutgoing(m) {
	return {
		id: m.id,
		user: true,
		text: m.text,
		time: new Date(m.createdAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}),
		date: new Date(m.createdAt).toISOString().slice(0, 10),
		isEdited: false,
		isPinned: false,
		replyTo: null,
		isSeen: m.isSeen || false,
	};
}

function _updateContactCard() {
	const userMsgs = messages[state.contactUserId];
	const lastMsg = userMsgs?.at(-1);
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (friend && lastMsg) {
		friend.lastMessage = lastMsg.text;
		friend.lastMessageTime = lastMsg.time;
		friend.lastMessageDate = lastMsg.date;
		friend.lastMessageSeen = false;
		refreshCard(friend);
		sortActiveChats();
	}
}

export function handleMessagesSeen(conversationId, messageIds = [], seenBy = null) {
	const contact = contacts.find((c) => c.conversationId === conversationId);
	if (!contact) return;

	const userMsgs = messages[contact.id];
	const seenIndices = [];

	if (Array.isArray(messageIds) && messageIds.length > 0 && Array.isArray(userMsgs)) {
		messageIds.forEach((mid) => {
			const idx = userMsgs.findIndex((msg) => msg.id === mid);
			if (idx !== -1) {
				const msg = userMsgs[idx];
				if (msg.user && !msg.isSeen) {
					msg.isSeen = true;
					seenIndices.push(idx);
				}
			}
		});
	}

	// Update DOM only if this conversation is currently open
	if (state.contactUserId === contact.id && seenIndices.length > 0) {
		markMessagesAsSeen(_dom.chatEl, seenIndices);
	}

	contact.unreadCount = 0;
	contact.lastMessageSeen = true;
	refreshCard(contact);
	sortActiveChats();
}
