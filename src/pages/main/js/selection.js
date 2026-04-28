import { state, contacts, messages } from "./state.js";
import { showToast } from "./ui.js";
import { deleteMessage, buildForwardedMsg } from "./context-menu.js";
import {
	openChat,
	injectMessages,
	scrollChatToBottom,
	basePadding,
} from "./chat.js";
import { createForwardedContactCard } from "../../../components/contact-cards/contacts-forward.js";
import {
	refreshCard,
	sortActiveChats,
	sortContacts,
	moveToContacts,
} from "./chat-logic.js";

let _dom = {};

/**

- @param {{
- chatEl, messageContainer, selectionToolbar, selectionCount,
- forwardDialog, deleteIcon, emptyStateEl,
- chatProfilePic, chatName, msgAction, msgActionText, msgActionmsg,
- messageInput, sendMessageBtn
- }} dom
  */
export function initSelection(dom) {
	_dom = dom;
}

// ─── Enter / cancel selection mode ───────────────────────────────────────────
export function enterSelectionMode(idx) {
	state.isSelecting = true;
	state.selectedMessages = [idx];
	_dom.chatEl.classList.add("selection-mode");
	_dom.messageContainer.style.display = "none";
	_dom.selectionToolbar.style.display = "flex";

	const msgEl = _dom.chatEl.querySelector(`[data-index="${idx}"]`);
	if (msgEl) msgEl.classList.add("selected");

	updateSelectionCount();
}

export function cancelSelection() {
	state.isSelecting = false;
	state.selectedMessages = [];
	_dom.chatEl.classList.remove("selection-mode");
	_dom.chatEl
		.querySelectorAll(".selected")
		.forEach((m) => m.classList.remove("selected"));

	_dom.messageContainer.style.display = "flex";
	_dom.selectionToolbar.style.display = "none";
}

export function updateSelectionCount() {
	_dom.selectionCount.textContent = `${state.selectedMessages.length} selected`;
}

// ─── Bulk delete ──────────────────────────────────────────────────────────────
export function handleBulkDelete() {
	const msgsToDelete = [...state.selectedMessages].sort((a, b) => b - a);

	const friend = contacts.find((c) => c.id === state.contactUserId);
	// save before state changes for undo
	const prevLastMessage = friend?.lastMessage;
	const prevLastMessageTime = friend?.lastMessageTime;
	const prevLastMessageDate = friend?.lastMessageDate;
	const prevLastMessageSeen = friend?.lastMessageSeen;

	cancelSelection();
	showToast(`${msgsToDelete.length} messages deleted`, _dom.deleteIcon, true);
	msgsToDelete.forEach((idx) => {
		const msgEl = _dom.chatEl.querySelector(`[data-index="${idx}"]`);
		if (msgEl) state.deletingTimeouts.push(deleteMessage(msgEl, idx));
	});

	if (friend) {
		const remaining = (messages[state.contactUserId] || []).filter(
			(_, i) => !msgsToDelete.includes(i),
		);
		if (remaining.length > 0) {
			const lastMsg = remaining.at(-1);
			friend.lastMessage = lastMsg.text;
			friend.lastMessageTime = lastMsg.time;
			friend.lastMessageDate = lastMsg.date || "";
			friend.lastMessageSeen = lastMsg.user ? lastMsg.isSeen === true : true;
		} else {
			friend.lastMessage = "";
			friend.lastMessageTime = "";
			friend.lastMessageDate = "";
			friend.lastMessageSeen = true;
		}
		refreshCard(friend);
		sortActiveChats();
		sortContacts();
	}

	state.currentUndoAction = () => {
		state.deletingTimeouts.forEach((t) => clearTimeout(t));
		state.deletingTimeouts = [];
		_dom.chatEl.querySelectorAll(".chat-message").forEach((m) => {
			if (parseFloat(m.style.opacity) < 1) {
				m.style.transition = "opacity 0.15s ease";
				m.style.opacity = 1;
				setTimeout(() => {
					m.style.transition = "";
				}, 150);
			}
		});
		// restore deleted messages in state
		if (friend) {
			friend.lastMessage = prevLastMessage;
			friend.lastMessageTime = prevLastMessageTime;
			friend.lastMessageDate = prevLastMessageDate;
			friend.lastMessageSeen = prevLastMessageSeen;
			refreshCard(friend);
			sortActiveChats();
			sortContacts();
		}
	};
}

// ─── Bulk forward ─────────────────────────────────────────────────────────────
/** Populates the forward dialog and opens it. The actual dispatch happens in main after a contact is chosen. */
export function prepareBulkForward() {
	state.isSelectionForwarding = true;
	_dom.forwardDialog.querySelector(".forwarded-contact-dialog").innerHTML =
		"";
	contacts.forEach((contact) => {
		_dom.forwardDialog
			.querySelector(".forwarded-contact-dialog")
			.appendChild(createForwardedContactCard({ ...contact }));
	});
	_dom.forwardDialog.showModal();
}

/**

- Called from main’s forward-dialog listener once the target contact is chosen.
- @param {{ id, profilePics, name, nickname }} friend
- @param {string} sourceName
  */
export function executeBulkForward(friend, sourceName) {
	const forwardingMsgs = [...state.selectedMessages]
		.sort((a, b) => a - b)
		.map((idx) =>
			buildForwardedMsg(messages[state.contactUserId][idx], friend.id),
		);

	const prevFriend = contacts.find((c) => c.id === state.contactUserId);
	if (prevFriend && prevFriend.id !== friend.id) {
		prevFriend.isInChat = false;
		if (
			!prevFriend.isPinned &&
			prevFriend.unreadCount === 0 &&
			prevFriend.lastMessageSeen !== false
		) {
			moveToContacts(prevFriend);
			sortActiveChats();
			sortContacts();
		}
	}

	state.contactUserId = friend.id;
	state.isSelectionForwarding = false;
	cancelSelection();
	_dom.forwardDialog.close();

	_dom.chatProfilePic.src =
		friend.profilePics[0] || "../../../public/assets/images/profile.jpeg";
	_dom.chatName.textContent = friend.nickname || friend.name;
	openChat(true);
	injectMessages(friend.id);
	scrollChatToBottom();

	_dom.msgAction.style.display = "flex";
	state.actionPreviewHeight =
		_dom.msgAction.getBoundingClientRect().height / 14;
	_dom.chatEl.style.paddingBottom =
		basePadding + state.actionPreviewHeight + "rem";
	_dom.msgActionText.textContent = "Forwarding from: " + sourceName;
	_dom.msgActionmsg.textContent = `${forwardingMsgs.length} messages`;
	_dom.messageInput.style.borderRadius = "0 0 2rem 2rem";
	_dom.sendMessageBtn.style.display = "block";

	state.isForwarding = true;
	state.forwardingMsgs = forwardingMsgs;
}
