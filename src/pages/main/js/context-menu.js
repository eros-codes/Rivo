import { deleteMessage as apiDeleteMessage} from "./api.js";
import { state, messages, contacts } from "./state.js";
import { showEmptyState } from "./ui.js";
import {
	scrollChatToBottom,
	updatePinnedMessage,
	basePadding,
} from "./chat.js";
import { refreshCard, moveToContacts, sortActiveChats, sortContacts } from "./chat-logic.js";
import { emitDeleteMessage, emitPinMessage } from "./socket.js";

const pinIconForMenu = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z"/></svg>`;
const unpinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="m20.97 17.172l-1.414 1.414l-3.535-3.535l-.073.074l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243L5.34 8.761l3.536-.707l.073-.074l-3.536-3.536L6.828 3.03zM10.365 9.394l-.502.502l-2.822.565l6.5 6.5l.564-2.822l.502-.502zm8.411.074l-1.34 1.34l1.414 1.415l1.34-1.34l.707.707l1.415-1.415l-8.486-8.485l-1.414 1.414l.707.707l-1.34 1.34l1.414 1.415l1.34-1.34z"/></svg>`;

let _dom = {};

/**

- @param {{
- messageMenu, chatOverlay, editMsg,
- chatEl, emptyStateEl,
- messageInput, sendMessageBtn, msgAction, msgActionText, msgActionmsg,
- cancelEditBtn
- }} dom
  */
export function initContextMenu(dom) {
	_dom = dom;
}

// ─── Open ─────────────────────────────────────────────────────────────────────
export function openContextMenu(msg, e) {
	if (state.isMenuOpen) {
		if (msg.dataset.index == state.msgIndex) {
			closeContextMenu();
			return;
		}
		closeContextMenu();
	}
	state.msgIndex = msg.dataset.index;
	state.selectedMsg = msg;

	_dom.messageMenu.style.display = "block";
	_dom.chatOverlay.style.display = "block";
	msg.style.zIndex = 500;

	// Pin/Unpin label & icon
	const pinLabels = document.querySelectorAll(".pin-message p");
	const pinIconEl = document.querySelector(".pin-message span");
	const isPinned = state.pinnedIndexes.includes(Number(msg.dataset.index));
	if (pinLabels[0]) pinLabels[0].textContent = isPinned ? "Unpin" : "Pin";
	if (pinIconEl) pinIconEl.innerHTML = isPinned ? unpinIcon : pinIconForMenu;

	// Forwarded messages can't be edited
	const forwardedFrom =
		messages[state.contactUserId][state.msgIndex]?.forwardedFrom;
	if (_dom.editMsg[0]) {
		_dom.editMsg[0].style.display =
			forwardedFrom === undefined ? "flex" : "none";
	}

	// Position menu
	const rect = msg.getBoundingClientRect();
	const menuHeight = _dom.messageMenu.getBoundingClientRect().height;
	let translateAmount = 0;

	if (window.innerHeight - rect.bottom < menuHeight) {
		translateAmount = menuHeight + rect.bottom - window.innerHeight + 24;
		msg.style.transform = `translateY(-${translateAmount}px)`;
	}

	_dom.messageMenu.style.top =
		rect.top + rect.height - translateAmount + basePadding + "px";

	if (msg.classList.contains("outgoing")) {
		_dom.messageMenu.style.right = window.innerWidth - rect.right + "px";
		_dom.messageMenu.style.left = "";
	} else {
		if (_dom.editMsg[0]) _dom.editMsg[0].style.display = "none";
		_dom.messageMenu.style.left = rect.left + "px";
		_dom.messageMenu.style.right = "";
	}

	state.isMenuOpen = true;
	setTimeout(() => {
		_dom.messageMenu.style.opacity = 1;
		_dom.chatOverlay.style.opacity = 1;
	}, 100);

	if (e && typeof e.stopPropagation === "function") e.stopPropagation();
}

// ─── Close ────────────────────────────────────────────────────────────────────
export function closeContextMenu() {
	_dom.messageMenu.style.opacity = 0;
	_dom.chatOverlay.style.opacity = 0;
	if (_dom.editMsg[0]) _dom.editMsg[0].style.display = "flex";
	_dom.messageMenu.style.display = "none";
	_dom.chatOverlay.style.display = "none";
	if (state.selectedMsg) {
		state.selectedMsg.style.zIndex = "";
		state.selectedMsg.style.transform = "translateY(0px)";
	}
	state.isMenuOpen = false;
}

// ─── Delete & undo ────────────────────────────────────────────────────────────
export function deleteMessage(msg, index) {
	const messageId = messages[state.contactUserId][Number(index)]?.id;

	msg.style.transition = "opacity 3s ease";
	msg.style.opacity = 0;
	const timeout = setTimeout(() => {
		setTimeout(() => {
			if (messageId) emitDeleteMessage(messageId);
			msg.remove();
			const idx = Number(index);
			const all = Array.isArray(messages[state.contactUserId])
				? messages[state.contactUserId]
				: [];
			const remaining = all.filter((_, i) => i !== idx);

			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (friend) {
				if (remaining.length > 0) {
					const lastMsg = remaining.at(-1);
					friend.lastMessage = lastMsg.text;
					friend.lastMessageTime = lastMsg.time;
					friend.lastMessageDate = lastMsg.date || "";
					friend.lastMessageSeen = lastMsg.user ? false : true;
				} else {
					friend.lastMessage = "";
					friend.lastMessageTime = "";
					friend.lastMessageDate = "";
					friend.lastMessageSeen = true;
				}
				refreshCard(friend);
				sortActiveChats();
				sortContacts();

				if (
					!friend.isPinned &&
					friend.unreadCount === 0 &&
					friend.lastMessageSeen === true
				) {
					moveToContacts(friend);
				}
			}
			if (remaining.length === 0) {
				showEmptyState(_dom.chatEl, _dom.emptyStateEl);
			}
		}, 310);
	}, 3000);

	return timeout;
}

export function undoDeleteMessage(msg) {
	clearTimeout(state.deleting);
	msg.style.transition = "opacity 0.15s ease";
	msg.style.opacity = 1;
	setTimeout(() => {
		msg.style.transition = "";
	}, 150);
}

// ─── Build forwarded message ──────────────────────────────────────────────────
export function buildForwardedMsg(originalMsg, targetContactId) {
	const senderName = originalMsg.user
		? "You"
		: (contacts.find((c) => c.id === state.contactUserId)?.name ??
			"Unknown");
	return {
		user: true,
		text: originalMsg.text,
		time: new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}),
		date: new Date().toISOString().slice(0, 10),
		isEdited: false,
		replyTo: null,
		forwardedFrom: senderName,
		isSeen: false,
		index: messages[targetContactId].length,
	};
}

// ─── Pin / Unpin ──────────────────────────────────────────────────────────────
export function pinMessage(pinIconSvg) {
	const idx = Number(state.selectedMsg?.dataset.index);
	const msg = messages[state.contactUserId][idx];
	const messageId = msg?.id;
	if (messageId) emitPinMessage(messageId).catch(() => {});

	const msgEl = _dom.chatEl.querySelector(`[data-index="${idx}"]`);
	const meta = msgEl.querySelector(".chat-message-meta");
	const existingIcon = msgEl.querySelector(".chat-pinned-icon");

	if (!msg.isPinned) {
		msg.isPinned = true;
		if (!existingIcon) {
			const pinSpan = document.createElement("span");
			pinSpan.className = "chat-pinned-icon";
			pinSpan.innerHTML = pinIconSvg;
			msg.user ? meta.prepend(pinSpan) : meta.appendChild(pinSpan);
		}
		state.pinnedIndexes.push(idx);
		state.pinnedIndexes.sort((a, b) => a - b);
	} else {
		msg.isPinned = false;
		if (existingIcon) existingIcon.remove();
		state.pinnedIndexes = state.pinnedIndexes.filter((i) => i !== idx);
	}

	updatePinnedMessage();
	closeContextMenu();
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
export function editMessage() {
	const msg = messages[state.contactUserId][Number(state.msgIndex)];

	state.isEditing = true;
	_dom.messageInput.value =
		messages[state.contactUserId][Number(state.msgIndex)].text;
	_dom.messageInput.focus();
	_dom.msgAction.style.display = "flex";
	state.actionPreviewHeight =
		_dom.msgAction.getBoundingClientRect().height / 14;
	_dom.chatEl.style.paddingBottom =
		basePadding + state.actionPreviewHeight + "rem";
	_dom.msgActionText.textContent = "Edit";
	_dom.msgActionmsg.textContent =
		messages[state.contactUserId][Number(state.msgIndex)].text;
	closeContextMenu();
	
	_dom.messageInput.style.borderRadius = "0 0 2rem 2rem";
	_dom.sendMessageBtn.style.display = "block";
	const nearBottom =
		_dom.chatEl.scrollTop + _dom.chatEl.clientHeight >=
		_dom.chatEl.scrollHeight -
			_dom.msgAction.getBoundingClientRect().height -
			30;
	if (nearBottom) scrollChatToBottom();
}

// ─── Reply ────────────────────────────────────────────────────────────────────
export function replyMessage() {
	const senderName = messages[state.contactUserId][Number(state.msgIndex)]
		.user
		? "You"
		: contacts.find((c) => c.id === state.contactUserId)?.name;
	_dom.msgAction.style.display = "flex";
	state.actionPreviewHeight =
		_dom.msgAction.getBoundingClientRect().height / 14;
	_dom.chatEl.style.paddingBottom =
		basePadding + state.actionPreviewHeight + "rem";
	_dom.msgActionText.textContent = "Replying to " + senderName;
	_dom.msgActionmsg.textContent =
		messages[state.contactUserId][Number(state.msgIndex)].text;
	_dom.messageInput.focus();
	_dom.messageInput.style.borderRadius = "0 0 2rem 2rem";

	state.replyTo = {
		text: messages[state.contactUserId][Number(state.msgIndex)].text,
		sender: senderName,
		index: Number(state.msgIndex),
	};
	closeContextMenu();

	const nearBottom =
		_dom.chatEl.scrollTop + _dom.chatEl.clientHeight >=
		_dom.chatEl.scrollHeight -
			_dom.msgAction.getBoundingClientRect().height -
			20;
	if (nearBottom) setTimeout(scrollChatToBottom, 200);
}
