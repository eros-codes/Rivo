import { applyReactionsToMessage, createMessage } from "../../../components/messages/messages.js";
import { updateContact as apiUpdateContact } from "./api.js";
import { moveToActiveChats, refreshCard, sortActiveChats, sortContacts } from "./chat-logic.js";
import { resetInput } from "./chat-open.js";
import { _updateContactCard } from "./chat-receive.js";
import { createDateSeparator, messageForDisplay } from "./chat-render.js";
import { nearBottom, scrollChatToBottom, scrollChatToBottomAfterPadding } from "./chat-scroll.js";
import { _currentUserId, _dom, getContactPreviewText, newClientMessageId, normalizeServerMessage, pendingMessages } from "./chat-state.js";
import { emitEditMessage, emitMessage } from "./socket.js";
import { contacts, messages, state } from "./state.js";
import { hideEmptyState, showToast } from "./ui.js";
import { formatClock, localDateKey } from "../../../utils/date.js";

// Sending to an archived chat brings it back (the server is told too)
function _unarchiveOnSend(contact) {
	if (!contact || !contact.isArchived) return;
	contact.isArchived = false;
	apiUpdateContact(contact.id, { isArchived: false }).catch(() => {});
}

// Redraws an edited message from its data (links, direction, "edited")
function _redrawMessage(msgEl, msg) {
	if (!msgEl || !msgEl.isConnected || !msg) return;
	const contactId = state.contactUserId;
	const idx = (messages[contactId] || []).indexOf(msg);
	if (idx !== -1) msg.index = idx;
	const el = createMessage(messageForDisplay(msg, contactId));
	if (msg.id != null) el.dataset.messageId = String(msg.id);
	if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
		try {
			applyReactionsToMessage(el, msg.reactions, _currentUserId() || null);
		} catch (e) {
			/* ignore */
		}
	}
	if (msgEl.classList.contains("selected")) el.classList.add("selected");
	msgEl.replaceWith(el);
}

function _findEditedMessage() {
	const list = messages[state.contactUserId] || [];
	if (state.editingMessageId != null) {
		return list.find((m) => String(m.id) === String(state.editingMessageId)) || null;
	}
	// a message without a server id (still local)
	return typeof state.msgIndex !== "undefined" ? list[Number(state.msgIndex)] || null : null;
}

function _messageElement(msg) {
	if (!msg || !_dom.chatEl) return null;
	if (msg.id != null) {
		return _dom.chatEl.querySelector(`.chat-message[data-message-id="${msg.id}"]`);
	}
	return state.selectedMsg || null;
}

export async function sendMessage() {
	// Edit mode
	if (state.isEditing) {
		// locate message object robustly
		const txt = _dom.messageInput.value;
		if (!txt || txt.trim() === "") return;
		const msg = _findEditedMessage();
		if (!msg) {
			// it was deleted meanwhile
			state.isEditing = false;
			state.editingMessageId = null;
			resetInput();
			showToast("This message no longer exists");
			return;
		}

		// Breadcrumb: attempted edit
		try {
			if (
				typeof window !== "undefined" &&
				window.Sentry &&
				window.Sentry.addBreadcrumb
			) {
				window.Sentry.addBreadcrumb({
					category: "edit",
					message: "submit_edit",
					data: { messageId: msg?.id, localOnly: !msg.id },
				});
			}
		} catch (e) {
			void e;
		}
		if (msg.text === txt.trim()) {
			state.isEditing = false;
			state.editingMessageId = null;
			resetInput();
			return;
		}

		// If message has no server id (local-only), update locally and mark edited
		if (!msg.id) {
			msg.text = txt.trim();
			msg.isEdited = true;
			_redrawMessage(_messageElement(msg), msg);
			// if user was near bottom before editing, keep them scrolled to bottom
			const nearBottomAfterEdit = nearBottom(
				_dom.chatEl,
				(_dom.msgAction?.getBoundingClientRect().height || 0) + 30,
			);
			if (nearBottomAfterEdit) scrollChatToBottomAfterPadding();
			state.isEditing = false;
			state.editingMessageId = null;
			resetInput();
			// local edit applied; no toast for edits
			return;
		}

		// Normal path: message has server id — send edit request
		const editedText = txt.trim();
		const editedChat = state.contactUserId;
		state.isEditing = false;
		state.editingMessageId = null;
		resetInput();
		try {
			await emitEditMessage(msg.id, editedText);
			// update local state
			msg.text = editedText;
			msg.isEdited = true;
			if (state.contactUserId === editedChat) _redrawMessage(_messageElement(msg), msg);
			// the edited message may be the chat's preview
			const friend = contacts.find((c) => c.id === editedChat);
			if (friend && String(friend.lastMessageId) === String(msg.id)) {
				friend.lastMessage = getContactPreviewText(msg);
				refreshCard(friend);
			}
		} catch (e) {
			console.error("edit failed", e);
			showToast(
				typeof e === "string" ? e : e?.message || "Edit failed",
				"",
			);
		}
		return;
	}

	// Forward mode
	if (state.isForwarding) {
		const msgsToSend = (
			state.forwardingMsgs.length > 0
				? state.forwardingMsgs
				: [state.forwardingMsg]
		).filter(Boolean);

		const contact = contacts.find((c) => c.id === state.contactUserId);
		if (!contact) return;
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
		_unarchiveOnSend(contact);
		if (!Array.isArray(messages[contact.id])) messages[contact.id] = [];

		state.forwardingMsgs = [];
		state.forwardingMsg = null;
		state.isForwarding = false;
		const extraText = _dom.messageInput.value;
		resetInput();

		let failed = 0;
		let lastError = "";
		for (const msg of msgsToSend) {
			try {
				const sent = await emitMessage({
					conversationId: contact.conversationId,
					text: msg.text,
					forwardedFrom: msg.forwardedFrom || null,
					forwardedText: msg.text,
					clientMessageId: newClientMessageId(),
				});
				const list = messages[contact.id];
				if (list.some((m) => String(m.id) === String(sent.id))) continue;
				const normalized = _normalizeOutgoing(sent);
				normalized.index = list.length;
				list.push(normalized);
				// only draw it if this chat is still the one on screen
				if (state.contactUserId === contact.id) {
					// Insert date separator if this message starts a new day
					const prev = list[normalized.index - 1] || null;
					if (!prev || prev.date !== normalized.date) {
						_dom.chatEl.appendChild(createDateSeparator(normalized.date));
					}
					_dom.chatEl.appendChild(createMessage(messageForDisplay(normalized, contact.id)));
				}
			} catch (e) {
				failed++;
				lastError = e?.message || "";
			}
		}
		if (failed > 0) {
			showToast(
				msgsToSend.length > 1
					? `${failed} of ${msgsToSend.length} messages could not be forwarded`
					: lastError && lastError !== "Request timed out" && lastError !== "Socket not connected"
						? lastError
						: "Failed to forward message",
				"",
			);
		}

		if (state.contactUserId === contact.id) _updateContactCard();

		// Text typed next to the forwarded message(s) goes out as a normal message
		if (extraText.trim() !== "" && state.contactUserId === contact.id) {
			_dom.messageInput.value = extraText;
			try {
				await sendMessage();
			} catch (e) {
				console.error("sending the extra text failed", e);
			}
		}
		scrollChatToBottom();
		return;
	}

	// Normal send
	if (_dom.messageInput.value.trim() === "") return;

	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (!contact) return;

	_unarchiveOnSend(contact);

	const text = _dom.messageInput.value;
	const replyTo = state.replyTo;

	// create pending UI and send; messages[] is not updated until confirmation
	_sendOutgoingMessage(contact, text, replyTo, _snapshotPreview(contact));

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	const msgInputEl = _dom.messageInput;
	if (msgInputEl && typeof msgInputEl.focus === "function") msgInputEl.focus();
}

// Preview state of a contact before a send, to restore it if the send fails
function _snapshotPreview(contact) {
	return {
		lastMessage: contact.lastMessage,
		lastMessageId: contact.lastMessageId ?? null,
		lastMessageTime: contact.lastMessageTime,
		lastMessageDate: contact.lastMessageDate,
		lastMessageTs: contact.lastMessageTs,
		lastMessageSeen: contact.lastMessageSeen,
	};
}

export async function sendOneTimeMessage() {
	const text = _dom.messageInput.value.trim();
	if (!text) return;

	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (!contact) return;

	_unarchiveOnSend(contact);

	const replyTo = state.replyTo;
	// Use the existing pending-message flow, but pass isOneTime: true
	_sendOutgoingMessage(contact, text, replyTo, _snapshotPreview(contact), true);

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	_dom.messageInput?.focus();
}

export async function sendTimeCapsuleMessage(scheduledFor) {
	const text = _dom.messageInput.value.trim();
	if (!text) return;

	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (!contact) return;

	_unarchiveOnSend(contact);

	const replyTo = state.replyTo;
	_sendOutgoingMessage(contact, text, replyTo, _snapshotPreview(contact), false, true, scheduledFor);

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	_dom.messageInput?.focus();
}

export function _normalizeOutgoing(m) {
	const normalized = normalizeServerMessage(m);
	normalized.user = true;
	normalized.isEdited = false;
	normalized.isLocked = false;
	return normalized;
}

// Pending message helpers
export function _closeFailedPanel() {
	const root = _dom && _dom.chatEl ? _dom.chatEl : document;
	const existing = root.querySelector(".msg-failed-panel");
	if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
	try {
		document.removeEventListener("click", _closeFailedPanel);
	} catch (e) {
		/* ignore */
	}
}

export function _openFailedPanel(msgEl, pendingId) {
	_closeFailedPanel();
	const panel = document.createElement("div");
	panel.className = "msg-failed-panel";

	const retryBtn = document.createElement("button");
	retryBtn.type = "button";
	retryBtn.className = "retry-btn";
	retryBtn.textContent = "Retry";

	const copyBtn = document.createElement("button");
	copyBtn.type = "button";
	copyBtn.className = "copy-btn";
	copyBtn.textContent = "Copy";

	const delBtn = document.createElement("button");
	delBtn.type = "button";
	delBtn.className = "delete-btn";
	delBtn.textContent = "Delete";

	panel.appendChild(retryBtn);
	panel.appendChild(copyBtn);
	panel.appendChild(delBtn);

	// attach handlers
	retryBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		_retryPending(pendingId);
		_closeFailedPanel();
	});
	copyBtn.addEventListener("click", async (e) => {
		e.stopPropagation();
		const entry = pendingMessages.get(pendingId);
		if (entry && entry.text) {
			try {
				await navigator.clipboard.writeText(entry.text);
				showToast("Copied");
			} catch (err) {
				showToast("Copy failed");
			}
		}
		_closeFailedPanel();
	});
	delBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const entry = pendingMessages.get(pendingId);
		if (entry) {
			// remove node and clear any timeout
			try {
				if (entry.timeoutId) clearTimeout(entry.timeoutId);
			} catch (e) {
				/* ignore */
			}
			if (entry.node && entry.node.parentNode)
				entry.node.parentNode.removeChild(entry.node);
			pendingMessages.delete(pendingId);
			// restore contact preview if we have prevContactState
			if (entry.prevContactState) {
				const contact = contacts.find((c) => c.id === entry.contactId);
				if (contact) {
					Object.assign(contact, entry.prevContactState);
					refreshCard(contact);
					sortActiveChats();
					sortContacts();
				}
			}
		}
		_closeFailedPanel();
	});

	// append to message element so positioning (bottom/right) works
	msgEl.appendChild(panel);

	// close when clicking elsewhere
	setTimeout(() => {
		document.addEventListener("click", _closeFailedPanel);
	}, 0);
}

export function _toggleFailedPanel(msgEl, pendingId) {
	const existing = msgEl.querySelector(".msg-failed-panel");
	if (existing) {
		_closeFailedPanel();
	} else {
		_openFailedPanel(msgEl, pendingId);
	}
}

export function _retryPending(pendingId) {
	const entry = pendingMessages.get(pendingId);
	if (!entry) return;
	const contact = contacts.find((c) => c.id === entry.contactId);
	if (entry.timeoutId)
		try {
			clearTimeout(entry.timeoutId);
		} catch (e) {
			/* ignore */
		}
	// remove failed node from DOM
	if (entry.node && entry.node.parentNode)
		entry.node.parentNode.removeChild(entry.node);
	pendingMessages.delete(pendingId);
	// Same kind of message, same id: if the first attempt did reach the
	// server, this returns that message instead of sending a second one.
	if (contact)
		_sendOutgoingMessage(
			contact,
			entry.text,
			entry.replyTo,
			entry.prevContactState,
			entry.isOneTime,
			entry.isTimeCapsule,
			entry.scheduledFor,
			entry.clientMessageId,
		);
}

export function _markPendingFailed(pendingId) {
	const entry = pendingMessages.get(pendingId);
	if (!entry) return;
	// replace node with failed variant
	const failedNode = createMessage({
		user: true,
		text: entry.text,
		time: entry.time,
		failed: true,
		isOneTime: entry.isOneTime,
		isTimeCapsule: entry.isTimeCapsule,
		scheduledFor: entry.scheduledFor,
	});
	if (failedNode) {
		failedNode.dataset.pendingId = pendingId;
		failedNode.dataset.contactId = entry.contactId;
		if (entry.node && entry.node.parentNode)
			entry.node.parentNode.replaceChild(failedNode, entry.node);
		entry.node = failedNode;
		entry.timeoutId = null;
		entry.failed = true;
		pendingMessages.set(pendingId, entry);
	}
}

export async function _confirmPending(pendingId, sent) {
	const entry = pendingMessages.get(pendingId);
	if (!entry) return;
	try {
		if (entry.timeoutId) clearTimeout(entry.timeoutId);
	} catch (e) {
		/* ignore */
	}
	// remove pending tracking
	pendingMessages.delete(pendingId);

	// normalize and push into messages array (once)
	const normalized = _normalizeOutgoing(sent);
	if (!messages[entry.contactId]) messages[entry.contactId] = [];
	const list = messages[entry.contactId];
	const already = list.find((m) => String(m.id) === String(normalized.id));
	if (!already) {
		normalized.index = list.length;
		list.push(normalized);
	}

	// replace DOM node with confirmed message
	const shown = already || normalized;
	const newNode = createMessage(messageForDisplay(shown, entry.contactId));
	if (newNode) {
		newNode.dataset.index = shown.index;
		newNode.dataset.messageId = shown.id;
		if (entry.node && entry.node.parentNode) {
			entry.node.parentNode.replaceChild(newNode, entry.node);
		} else if (state.contactUserId === entry.contactId && _dom.chatEl && !already) {
			// the chat was redrawn meanwhile and the pending bubble went with it
			const prev = list[normalized.index - 1] || null;
			if (!prev || prev.date !== normalized.date) _dom.chatEl.appendChild(createDateSeparator(normalized.date));
			_dom.chatEl.appendChild(newNode);
		}
	}

	// update contact preview
	const contact = contacts.find((c) => c.id === entry.contactId);
	if (contact) {
		contact.lastMessage = getContactPreviewText(normalized);
		contact.lastMessageId = normalized.id;
		contact.lastMessageTime = normalized.time;
		contact.lastMessageDate = normalized.date;
		const _sentTs = new Date(sent?.createdAt).getTime();
		if (Number.isFinite(_sentTs)) contact.lastMessageTs = _sentTs;
		contact.lastMessageSeen = normalized.isSeen === true;
		refreshCard(contact);
		sortActiveChats();
	}
}

// Create a pending message in the UI and send via socket. Does not add to messages[] until confirmed.
export function _sendOutgoingMessage(
	contact,
	text,
	replyTo = null,
	prevContactState = null,
	isOneTime = false,
	isTimeCapsule = false,
	scheduledFor = null,
	clientMessageId = null,
) {
	if (!contact) return;
	if (!_dom.chatEl) return;
	const cmid = clientMessageId || newClientMessageId();

	// Remove empty-state placeholder if present so the pending message replaces it
	hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
	const now = new Date();
	const timeStr = formatClock(now);
	const dateStr = localDateKey(now);

	// create pending DOM node
	const pendingId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const pendingNode = createMessage(messageForDisplay({
		user: true,
		text,
		time: timeStr,
		pending: true,
		replyTo: replyTo ? { id: replyTo.id, sender: replyTo.sender, senderId: replyTo.senderId ?? null, text: replyTo.text } : null,
		isOneTime: !!isOneTime,
		isTimeCapsule: !!isTimeCapsule,
		scheduledFor: scheduledFor || null,
		isLocked: false,
	}, contact.id));
	pendingNode.dataset.pendingId = pendingId;
	pendingNode.dataset.contactId = contact.id;

	// insert date separator if needed (compare with the last thing on screen)
	const prev =
		messages[contact.id] && messages[contact.id].length
			? messages[contact.id][messages[contact.id].length - 1]
			: null;
	const lastSep = Array.from(_dom.chatEl.querySelectorAll(".date-separator")).pop();
	if ((!prev || prev.date !== dateStr) && (!lastSep || lastSep.dataset.date !== dateStr)) {
		_dom.chatEl.appendChild(createDateSeparator(dateStr));
	}
	_dom.chatEl.appendChild(pendingNode);
	scrollChatToBottom();

	// update contact preview immediately
	contact.lastMessage = text;
	contact.lastMessageTime = timeStr;
	contact.lastMessageDate = dateStr;
	// used to order the Contacts section (most recent first)
	contact.lastMessageTs = now.getTime();
	contact.lastMessageSeen = false;
	moveToActiveChats(contact);
	refreshCard(contact);
	sortActiveChats();
	sortContacts();

	// store pending entry
	const timeoutId = setTimeout(() => {
		_markPendingFailed(pendingId);
	}, 8000);
	pendingMessages.set(pendingId, {
		node: pendingNode,
		timeoutId,
		contactId: contact.id,
		text,
		replyTo,
		time: timeStr,
		prevContactState,
		isOneTime: !!isOneTime,
		isTimeCapsule: !!isTimeCapsule,
		scheduledFor: scheduledFor || null,
		clientMessageId: cmid,
	});

	// send via socket (don't await here to allow timeout behavior)
	(async () => {
		try {
			const sent = await emitMessage({
				conversationId: contact.conversationId,
				text,
				replyToId: replyTo?.id || null,
				// the quoted author's real name (labels are worked out per viewer)
				replyToName: replyTo?.name || replyTo?.sender || null,
				replyToText: replyTo?.text || null,
				isOneTime: !!isOneTime,
				isTimeCapsule: !!isTimeCapsule,
				scheduledFor: scheduledFor || null,
				clientMessageId: cmid,
			});
			// confirm pending (if still present)
			await _confirmPending(pendingId, sent);
		} catch (e) {
			console.error("Failed to send message", e);
			// mark failed in UI, and say why when the server refused it
			_markPendingFailed(pendingId);
			const reason = e?.message || "";
			if (reason && reason !== "Request timed out" && reason !== "Socket not connected" && reason !== "Server error") {
				showToast(reason);
			}
		}
	})();
}
