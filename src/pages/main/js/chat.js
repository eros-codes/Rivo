import { state, messages, contacts } from "./state.js";
import { showEmptyState, hideEmptyState, showToast } from "./ui.js";
import { createMessage, markMessagesAsSeen } from "../../../components/messages/messages.js";
import {
	moveToActiveChats,
	moveToContacts,
	refreshCard,
	sortActiveChats,
	sortContacts,
	updateTotalUnreadCount,
} from "./chat-logic.js";
import { emitMessage, emitEditMessage, emitMessageSeen, getSocket } from "./socket.js";
import { getMessages, getContacts } from "./api.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../../components/active-chats/active-chats.js";

// ─── Constants ────────────────────────────────────────────────────────────────
export const basePadding = 4;
export const lineHeight = 22.4;
export const maxLines = 7;
export const maxHeight = lineHeight * maxLines;

// Cap messages kept per conversation to avoid unbounded client memory growth
const MAX_MESSAGES_PER_CONVERSATION = 1000;

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
						id: m.replyToId,
						sender: m.replyToName,
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
	try {
		const stored = localStorage.getItem("user");
		if (!stored) return null;
		const parsed = JSON.parse(stored);
		return parsed?.id ?? null;
	} catch (e) {
		return null;
	}
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

	// Inform server we're leaving the active conversation (if any) so presence
	// and unread handling remain accurate, and clear local active contact.
	try {
		const prevContact = contacts.find((c) => c.id === state.contactUserId);
		if (prevContact && prevContact.conversationId) {
			const sock = getSocket();
			if (sock) sock.emit("conversation:leave", { conversationId: prevContact.conversationId });
		}
	} catch (e) {
		// ignore
	}

	state.contactUserId = null;
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
	_dom.pinnedMessageCount.textContent = "";
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
	const span = document.createElement("span");
	span.textContent = formatDateLabel(dateStr);
	el.appendChild(span);
	return el;
}

export function injectMessages(userId) {
	if (!_dom.chatEl) return;
	const userMessages = messages[userId];
	if (!userMessages) {
		showEmptyState(_dom.chatEl, _dom.emptyStateEl);
		return;
	}

	_dom.chatEl.textContent = "";
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
export async function receiveMessage(message) {
	let contact = contacts.find(
		(c) => c.conversationId === message.conversationId,
	);

	// If we don't know about this conversation yet, try to refresh contacts
	// from the server (handles case where someone added the current user).
	if (!contact) {
		try {
			const serverContacts = await getContacts();
			if (Array.isArray(serverContacts)) {
				const raw = serverContacts.find(
					(c) => c.conversationId === message.conversationId,
				);
				if (raw) {
					const newContact = {
						...raw,
						name: raw.nickname || raw.contact?.name || "",
						username: raw.contact?.username || "",
						profilePics: raw.contact?.profilePics || [],
						isOnline: raw.contact?.isOnline || false,
						lastSeen: raw.contact?.lastSeen || null,
						bio: raw.contact?.bio || "",
						email: raw.contact?.email || "",
						lastMessage: raw.conversation?.messages?.[0]?.text || "",
						lastMessageTime: raw.conversation?.messages?.[0]
							? new Date(raw.conversation.messages[0].createdAt).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
								hour12: false,
							})
							: null,
						lastMessageDate: raw.conversation?.messages?.[0]
							? new Date(raw.conversation.messages[0].createdAt).toISOString().slice(0, 10)
							: null,
						unreadCount: raw.unreadCount ?? 0,
						lastMessageSeen: (() => {
							const lastMsg = raw.conversation?.messages?.[0];
							if (!lastMsg) return true;
							return lastMsg.isSeen === true;
						})(),
					};

					// Avoid duplicates
					if (!contacts.find((c) => c.id === newContact.id)) {
						contacts.push(newContact);

						// append DOM card to the appropriate container
						const contactsContainer = document.querySelector(".contacts-container");
						const activeChatsContainer = document.querySelector(".active-chats-container");
						if (contactsContainer && activeChatsContainer) {
							if (newContact.isPinned || newContact.unreadCount > 0 || newContact.lastMessageSeen === false) {
								activeChatsContainer.appendChild(createActiveChatCard(newContact));
							} else {
								contactsContainer.appendChild(createContactCard({ ...newContact, hasMessages: !!newContact.lastMessage }, null));
							}
							updateTotalUnreadCount();
							sortActiveChats();
							sortContacts();
							// Hide the "No contacts yet" placeholder immediately
							const emptyEl = document.getElementById("contacts-empty");
							if (emptyEl) emptyEl.style.display = "none";
						}
					}

					contact = contacts.find((c) => c.conversationId === message.conversationId);
				}
			}
		} catch (e) {
			console.error("receiveMessage: failed to sync contacts", e);
		}
		if (!contact) return;
	}

	const normalized = {
		id: message.id,
		user: message.senderId === _currentUserId(),
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
				id: message.replyToId,
				sender: message.replyToName,
				text: message.replyToText,
			}
			: null,
		forwardedFrom: message.forwardedFrom || null,
		forwardedText: message.forwardedText || null,
	};

	if (!messages[contact.id]) messages[contact.id] = [];
	messages[contact.id].push(normalized);

	// Trim older messages if this conversation exceeds the cap
	if (messages[contact.id].length > MAX_MESSAGES_PER_CONVERSATION) {
		const overflow = messages[contact.id].length - MAX_MESSAGES_PER_CONVERSATION;
		messages[contact.id] = messages[contact.id].slice(overflow);
		// If this conversation is open, re-render to keep DOM indexes in sync
		if (state.contactUserId === contact.id) {
			injectMessages(contact.id);
			scrollChatToBottom();
		}
	}

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
		if (!messages[state.contactUserId] || typeof state.msgIndex === 'undefined' || !messages[state.contactUserId][Number(state.msgIndex)]) return;
		if (
			_dom.messageInput.value.trim() === "" ||
			messages[state.contactUserId][Number(state.msgIndex)].text ===
				_dom.messageInput.value.trim()
		)
			return;

		const txt = _dom.messageInput.value;
		const msg = messages[state.contactUserId][Number(state.msgIndex)];

		try {
			await emitEditMessage(msg.id, txt);
			// update local state first
			if (messages[state.contactUserId] && messages[state.contactUserId][Number(state.msgIndex)]) {
				messages[state.contactUserId][Number(state.msgIndex)].text = txt;
				messages[state.contactUserId][Number(state.msgIndex)].isEdited = true;
			}

			state.selectedMsg.querySelector(".chat-message-text").textContent = txt;
			if (!state.selectedMsg.querySelector(".chat-edited-label")) {
				const label = document.createElement("span");
				label.className = "chat-edited-label";
				label.textContent = "edited";
				state.selectedMsg
					.querySelector(".chat-message-meta")
					.prepend(label);
			}
		} catch (e) {
			console.error('edit failed', e);
			// optionally show UI error
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
					forwardedFrom: msg.forwardedFrom || (msg.user ? "You" : null),
					forwardedText: msg.text,
				});
				const normalized = _normalizeOutgoing(sent);
				normalized.index = messages[state.contactUserId].length;
				messages[state.contactUserId].push(normalized);
				_dom.chatEl.appendChild(createMessage(normalized));
			} catch {
				showToast("Failed to forward message", "");
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

	// Preserve previous contact preview state for rollback
	const prevContactState = contact
		? {
			lastMessage: contact.lastMessage,
			lastMessageTime: contact.lastMessageTime,
			lastMessageDate: contact.lastMessageDate,
			lastMessageSeen: contact.lastMessageSeen,
		}
		: null;

	// optimistic UI using a stable temporary id to avoid index races
	const now = new Date();
	const localId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
	const optimistic = {
		_localId: localId,
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
	// tag the DOM node with the localId so we can find & remove it reliably
	const appendedEl = _dom.chatEl.querySelector(
		`[data-index="${optimistic.index}"]`,
	);
	if (appendedEl) appendedEl.dataset.localId = localId;

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	const msgInputEl = _dom.messageInput || document.querySelector(".message-input");
	if (msgInputEl && typeof msgInputEl.focus === 'function') msgInputEl.focus();

	// send via socket
	try {
		const sent = await emitMessage({
			conversationId: contact.conversationId,
			text,
			replyToId: replyTo?.id || null,
			replyToName: replyTo?.sender || replyTo?.name || null,
			replyToText: replyTo?.text || null,
		});
		// replace local optimistic id with real id
		const localIdx = messages[state.contactUserId].findIndex(
			(m) => m._localId === localId,
		);
		if (localIdx !== -1) {
			messages[state.contactUserId][localIdx].id = sent.id;
			messages[state.contactUserId][localIdx].isSeen = sent.isSeen || false;
			messages[state.contactUserId][localIdx].isPinned = sent.isPinned || false;
			// preserve reply/forward metadata if server returned them
			messages[state.contactUserId][localIdx].replyTo = sent.replyToId
				? { id: sent.replyToId, sender: sent.replyToName, text: sent.replyToText }
				: messages[state.contactUserId][localIdx].replyTo || null;
			messages[state.contactUserId][localIdx].forwardedFrom = sent.forwardedFrom || messages[state.contactUserId][localIdx].forwardedFrom || null;
			messages[state.contactUserId][localIdx].forwardedText = sent.forwardedText || messages[state.contactUserId][localIdx].forwardedText || null;
			delete messages[state.contactUserId][localIdx]._localId;
		}
		// update DOM node if present
		const domEl = _dom.chatEl.querySelector(`[data-local-id="${localId}"]`);
		if (domEl) {
			domEl.dataset.messageId = sent.id;
			delete domEl.dataset.localId;
		}
	} catch {
		console.error("Failed to send message");
		const idx = messages[state.contactUserId].findIndex(
			(m) => m._localId === localId,
		);
		if (idx !== -1) messages[state.contactUserId].splice(idx, 1);
		const msgEl = _dom.chatEl.querySelector(`[data-local-id="${localId}"]`);
		if (msgEl) msgEl.remove();
		// rollback contact preview to previous state
		if (contact && prevContactState) {
			contact.lastMessage = prevContactState.lastMessage;
			contact.lastMessageTime = prevContactState.lastMessageTime;
			contact.lastMessageDate = prevContactState.lastMessageDate;
			contact.lastMessageSeen = prevContactState.lastMessageSeen;
			refreshCard(contact);
			sortActiveChats();
			sortContacts();
		}
	}

	_updateContactCard();
}

// ─── Normalize Outgoing Message ───────────────────────────────────────────────
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
		isPinned: m.isPinned || false,
		replyTo: m.replyToId
			? { id: m.replyToId, sender: m.replyToName, text: m.replyToText }
			: null,
		forwardedFrom: m.forwardedFrom || null,
		forwardedText: m.forwardedText || null,
		isSeen: m.isSeen || false,
	};
}

// ─── Update Contact Card ────────────────────────────────────────────────────────
function _updateContactCard() {
	const userMsgs = messages[state.contactUserId];
	const lastMsg = userMsgs?.at(-1);
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (friend && lastMsg) {
		friend.lastMessage = lastMsg.text;
		friend.lastMessageTime = lastMsg.time;
		friend.lastMessageDate = lastMsg.date;
		friend.lastMessageSeen = false; //new outgoing message which 2nd person has not seen
		refreshCard(friend);
		sortActiveChats();
	}
}

export function handleMessagesSeen(
	conversationId,
	messageIds = [],
	seenBy = null,
) {
	const contact = contacts.find((c) => c.conversationId === conversationId);
	if (!contact) return;

	const userMsgs = messages[contact.id];
	const seenIndices = [];

	if (
		Array.isArray(messageIds) &&
		messageIds.length > 0 &&
		Array.isArray(userMsgs)
	) {
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

	// Update DOM only if this conversation is currently open and there are indices
	if (state.contactUserId === contact.id && seenIndices.length > 0) {
		markMessagesAsSeen(_dom.chatEl, seenIndices);
	}

	const currentUserId = _currentUserId();
	const anyMarked = Array.isArray(messageIds) && messageIds.length > 0;

	// Only reset unreadCount for this contact when the current user is the one who saw the messages
	if (seenBy === currentUserId && anyMarked) {
		contact.unreadCount = 0;
	}

	// Also, if the conversation is currently open and messages were marked seen locally, reset unread count
	if (state.contactUserId === contact.id && seenIndices.length > 0) {
		contact.unreadCount = 0;
	}

	if (seenIndices.length > 0 || anyMarked) {
		refreshCard(contact);
		sortActiveChats();
	}

	// If any messages were marked as seen, mark the contact's last message as seen
	if (anyMarked && seenBy !== null && seenBy !== _currentUserId()) {
		contact.lastMessageSeen = true;
		if (!contact.isPinned && contact.unreadCount === 0) {
			moveToContacts(contact);
			sortContacts();
		}
	}
}
