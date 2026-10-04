import { state, contacts, messages } from "./state.js";
import { showToast } from "./ui.js";
import { deleteMessage, buildForwardedMsg } from "./context-menu.js";
import {
	scrollChatToBottom,
	basePadding,
	getContactPreviewText,
} from "./chat.js";
import { createForwardedContactCard } from "../../../components/contact-cards/contacts-forward.js";
import { applyComposerState } from "./profile.js";
import {
	refreshCard,
	sortActiveChats,
	sortContacts,
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
	// ensure we have a reference to the toolbar delete button
	_dom.selectionDeleteBtn = dom.selectionDeleteBtn;
}

// Selected messages are remembered by id: indexes move when older messages
// load or others are removed, and a delete must never hit the wrong one.
function _messageId(target) {
	if (target && typeof target === "object" && target.dataset) {
		return target.dataset.messageId || null;
	}
	const m = (messages[state.contactUserId] || [])[Number(target)];
	return m && m.id != null ? String(m.id) : null;
}

function _elementOf(id) {
	return _dom.chatEl?.querySelector(`.chat-message[data-message-id="${id}"]`) || null;
}

// The selected messages as they are now, in chat order
function _selectedInOrder() {
	const ids = new Set(state.selectedMessages.map(String));
	return (messages[state.contactUserId] || []).filter((m) => m.id != null && ids.has(String(m.id)));
}

// ─── Enter / cancel selection mode ───────────────────────────────────────────
/** `target`: the message element (or, for older callers, its index). */
export function enterSelectionMode(target) {
	const id = _messageId(target);
	// a message still being sent has no id yet and cannot be selected
	if (!id) return;
	state.isSelecting = true;
	state.selectedMessages = [id];
	_dom.chatEl.classList.add("selection-mode");
	_dom.messageContainer.style.display = "none";
	_dom.selectionToolbar.style.display = "flex";

	_elementOf(id)?.classList.add("selected");

	updateSelectionCount();
}

/** Selects or unselects a tapped message while selecting. */
export function toggleSelectedMessage(msgEl) {
	const id = _messageId(msgEl);
	if (!id) return;
	if (state.selectedMessages.includes(id)) {
		state.selectedMessages = state.selectedMessages.filter((x) => x !== id);
		msgEl.classList.remove("selected");
	} else {
		state.selectedMessages.push(id);
		msgEl.classList.add("selected");
	}
	if (state.selectedMessages.length === 0) cancelSelection();
	else updateSelectionCount();
}

export function cancelSelection() {
	state.isSelecting = false;
	state.selectedMessages = [];
	_dom.chatEl.classList.remove("selection-mode");
	_dom.chatEl
		.querySelectorAll(".selected")
		.forEach((m) => m.classList.remove("selected"));

	// the message box comes back (unless the contact is blocked or gone)
	applyComposerState(contacts.find((c) => c.id === state.contactUserId) || null);
	_dom.selectionToolbar.style.display = "none";
	// reset delete button visibility
	if (_dom.selectionDeleteBtn) _dom.selectionDeleteBtn.style.display = "flex";
}

export function updateSelectionCount() {
	_dom.selectionCount.textContent = `${state.selectedMessages.length} selected`;

	// Hide selection delete button if any selected message is incoming (not owned by current user)
	const anyIncoming = _selectedInOrder().some((m) => !m.user);
	if (_dom.selectionDeleteBtn) {
		_dom.selectionDeleteBtn.style.display = anyIncoming ? "none" : "flex";
	}
}

// ─── Bulk delete ──────────────────────────────────────────────────────────────
export function handleBulkDelete() {
	const contactId = state.contactUserId;
	const selected = _selectedInOrder();
	if (selected.length === 0) {
		cancelSelection();
		return;
	}

	// Only allow bulk delete when all selected messages belong to the current user.
	if (!selected.every((m) => !!m.user)) {
		showToast("You can only delete your own messages");
		cancelSelection();
		return;
	}

	const friend = contacts.find((c) => c.id === contactId);
	// save before state changes for undo
	const prevPreview = friend
		? {
				lastMessage: friend.lastMessage,
				lastMessageId: friend.lastMessageId ?? null,
				lastMessageTime: friend.lastMessageTime,
				lastMessageDate: friend.lastMessageDate,
				lastMessageTs: friend.lastMessageTs,
				lastMessageSeen: friend.lastMessageSeen,
			}
		: null;

	cancelSelection();
	// the undo below covers only this deletion
	state.deletingTimeouts = [];
	const fading = [];
	showToast(`${selected.length} messages deleted`, _dom.deleteIcon, true);
	selected.forEach((msg) => {
		const msgEl = _elementOf(msg.id);
		const idx = (messages[contactId] || []).indexOf(msg);
		if (!msgEl || idx === -1) return;
		const { timeout } = deleteMessage(msgEl, idx);
		state.deletingTimeouts.push(timeout);
		fading.push(msgEl);
	});

	if (friend) {
		const gone = new Set(selected);
		const remaining = (messages[contactId] || []).filter((m) => !gone.has(m));
		if (remaining.length > 0) {
			const lastMsg = remaining.at(-1);
			friend.lastMessage = getContactPreviewText(lastMsg);
			friend.lastMessageId = lastMsg.id ?? null;
			friend.lastMessageTime = lastMsg.time;
			friend.lastMessageDate = lastMsg.date || "";
			const ts = new Date(lastMsg.createdAt).getTime();
			friend.lastMessageTs = Number.isFinite(ts) ? ts : 0;
			// Only mark unseen when lastMsg.isSeen === false explicitly.
			friend.lastMessageSeen = lastMsg.user ? lastMsg.isSeen !== false : true;
		} else {
			friend.lastMessage = "";
			friend.lastMessageId = null;
			friend.lastMessageTime = "";
			friend.lastMessageDate = "";
			friend.lastMessageTs = 0;
			friend.lastMessageSeen = true;
		}
		refreshCard(friend);
		sortActiveChats();
		sortContacts();
	}

	state.currentUndoAction = () => {
		state.deletingTimeouts.forEach((t) => clearTimeout(t));
		state.deletingTimeouts = [];
		// only the messages of this deletion come back
		fading.forEach((m) => {
			m.style.transition = "opacity 0.15s ease";
			m.style.opacity = 1;
			setTimeout(() => {
				m.style.transition = "";
			}, 150);
		});
		// restore deleted messages in state
		if (friend && prevPreview) {
			Object.assign(friend, prevPreview);
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
	const list = _dom.forwardDialog.querySelector(".forwarded-contact-dialog");
	list.textContent = "";
	// only chats that can receive messages
	contacts
		.filter((c) => !c.isBlocked && !c.isDeleted)
		.forEach((contact) => {
			list.appendChild(createForwardedContactCard({ ...contact }));
		});
	_dom.forwardDialog.showModal();
}

/**

- Called from main’s forward-dialog listener once the target contact is chosen.
- @param {{ id, profilePics, name, nickname }} friend
- @param {string} sourceName
  */
export async function executeBulkForward(friend, sourceName) {
	// built while the source chat is still the current one, in chat order
	const forwardingMsgs = _selectedInOrder()
		.filter((m) => !(m.isLocked && !m.user) && !(m.isOneTime && !m.user))
		.map((m) => buildForwardedMsg(m, friend.id));

	state.isSelectionForwarding = false;
	cancelSelection();
	_dom.forwardDialog.close();
	if (forwardingMsgs.length === 0) {
		showToast("These messages can't be forwarded");
		return;
	}

	// the same flow as tapping the chat (rooms, cards, header, composer)
	await _dom.openChatWithContact(friend.id);
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
