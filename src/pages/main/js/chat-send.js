import { createMessage } from "../../../components/messages/messages.js";
import { updateContact as apiUpdateContact } from "./api.js";
import { refreshCard, sortActiveChats, sortContacts } from "./chat-logic.js";
import { resetInput } from "./chat-open.js";
import { _updateContactCard } from "./chat-receive.js";
import { createDateSeparator } from "./chat-render.js";
import { nearBottom, scrollChatToBottom, scrollChatToBottomAfterPadding } from "./chat-scroll.js";
import { _dom, getContactPreviewText, pendingMessages } from "./chat-state.js";
import { emitEditMessage, emitMessage } from "./socket.js";
import { contacts, findMessageById, messages, state } from "./state.js";
import { hideEmptyState, showToast } from "./ui.js";

export async function sendMessage() {
	// Edit mode
	if (state.isEditing) {
		// locate message object robustly
		const txt = _dom.messageInput.value;
		if (!txt || txt.trim() === "") return;
		let msg = null;
		if (
			typeof state.msgIndex !== "undefined" &&
			messages[state.contactUserId]
		) {
			msg = messages[state.contactUserId][Number(state.msgIndex)];
		}
		// fallback: try find by messageId present on selected DOM element
		if (!msg && state.selectedMsg) {
			const mid = state.selectedMsg.dataset?.messageId;
			if (mid) {
				const found = findMessageById(mid);
				if (found) msg = found.message;
			}
		}
		if (!msg) return;

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
			resetInput();
			return;
		}

		// If message has no server id (local-only), update locally and mark edited
		if (!msg.id) {
			msg.text = txt.trim();
			msg.isEdited = true;
			if (state.selectedMsg) {
				const textEl =
					state.selectedMsg.querySelector(".chat-message-text");
				if (textEl) textEl.textContent = msg.text;
				if (!state.selectedMsg.querySelector(".chat-edited-label")) {
					const label = document.createElement("span");
					label.className = "chat-edited-label";
					label.textContent = "edited";
					state.selectedMsg
						.querySelector(".chat-message-meta")
						?.prepend(label);
				}
			}
			// if user was near bottom before editing, keep them scrolled to bottom
			const nearBottomAfterEdit = nearBottom(
				_dom.chatEl,
				(_dom.msgAction?.getBoundingClientRect().height || 0) + 30,
			);
			if (nearBottomAfterEdit) scrollChatToBottomAfterPadding();
			state.isEditing = false;
			resetInput();
			// local edit applied; no toast for edits
			return;
		}

		// Normal path: message has server id — send edit request
		try {
			await emitEditMessage(msg.id, txt.trim());
			// update local state
			msg.text = txt.trim();
			msg.isEdited = true;
			if (state.selectedMsg) {
				const textEl =
					state.selectedMsg.querySelector(".chat-message-text");
				if (textEl) textEl.textContent = msg.text;
				if (!state.selectedMsg.querySelector(".chat-edited-label")) {
					const label = document.createElement("span");
					label.className = "chat-edited-label";
					label.textContent = "edited";
					state.selectedMsg
						.querySelector(".chat-message-meta")
						?.prepend(label);
				}
			}
		} catch (e) {
			console.error("edit failed", e);
			showToast(
				typeof e === "string" ? e : e?.message || "Edit failed",
				"",
			);
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
		if (!contact) return;
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);

		for (const msg of msgsToSend) {
			try {
				const sent = await emitMessage({
					conversationId: contact.conversationId,
					text: msg.text,
					forwardedFrom:
						msg.forwardedFrom || (msg.user ? "You" : null),
					forwardedText: msg.text,
				});
				const normalized = _normalizeOutgoing(sent);
				normalized.index = messages[state.contactUserId].length;
				messages[state.contactUserId].push(normalized);
				// Insert date separator if this message starts a new day
				const prev =
					messages[state.contactUserId][normalized.index - 1] || null;
				if (!prev || prev.date !== normalized.date) {
					_dom.chatEl.appendChild(
						createDateSeparator(normalized.date),
					);
				}
				_dom.chatEl.appendChild(createMessage(normalized));
			} catch {
				showToast("Failed to forward message", "");
			}
		}

		state.forwardingMsgs = [];
		state.forwardingMsg = null;
		state.isForwarding = false;

		if (_dom.messageInput.value.trim() !== "") {
			if (state.isForwarding) {
				state.isForwarding = false;
				console.warn("sendMessage: forwarding flag still set, aborting recursion");
			} else {
				try {
					await sendMessage();
				} catch (e) {
					console.error("nested sendMessage failed", e);
				}
			}
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

	// Auto-unarchive on send
	if (contact.isArchived) {
		contact.isArchived = false;
		apiUpdateContact(contact.id, { isArchived: false }).catch(() => {});
		document.dispatchEvent(
			new CustomEvent("contact:unarchived", {
				detail: { id: contact.id },
			}),
		);
	}

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

	// create pending UI and send; messages[] is not updated until confirmation
	_sendOutgoingMessage(contact, text, replyTo, prevContactState);

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	const msgInputEl = _dom.messageInput;
	if (msgInputEl && typeof msgInputEl.focus === "function") msgInputEl.focus();
}

export async function sendOneTimeMessage() {
	const text = _dom.messageInput.value.trim();
	if (!text) return;

	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (!contact) return;

	if (contact.isArchived) {
		contact.isArchived = false;
		apiUpdateContact(contact.id, { isArchived: false }).catch(() => {});
	}

	const replyTo = state.replyTo;
	const prevContactState = {
		lastMessage: contact.lastMessage,
		lastMessageTime: contact.lastMessageTime,
		lastMessageDate: contact.lastMessageDate,
		lastMessageSeen: contact.lastMessageSeen,
	};

	// Use the existing pending-message flow, but pass isOneTime: true
	_sendOutgoingMessage(contact, text, replyTo, prevContactState, true);

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

	if (contact.isArchived) {
		contact.isArchived = false;
		apiUpdateContact(contact.id, { isArchived: false }).catch(() => {});
	}

	const replyTo = state.replyTo;
	const prevContactState = {
		lastMessage: contact.lastMessage,
		lastMessageTime: contact.lastMessageTime,
		lastMessageDate: contact.lastMessageDate,
		lastMessageSeen: contact.lastMessageSeen,
	};

	_sendOutgoingMessage(contact, text, replyTo, prevContactState, false, true, scheduledFor);

	resetInput();
	state.replyTo = null;
	scrollChatToBottom();
	_dom.messageInput?.focus();
}

export function _normalizeOutgoing(m) {
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
		isOneTime: m.isOneTime || false,
		isTimeCapsule: m.isTimeCapsule || false,
		scheduledFor: m.scheduledFor || null,
		openedAt: m.openedAt || null,
		isLocked: false,
	};
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
					contact.lastMessage = entry.prevContactState.lastMessage;
					contact.lastMessageTime =
						entry.prevContactState.lastMessageTime;
					contact.lastMessageDate =
						entry.prevContactState.lastMessageDate;
					contact.lastMessageSeen =
						entry.prevContactState.lastMessageSeen;
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
	if (contact)
		_sendOutgoingMessage(
			contact,
			entry.text,
			entry.replyTo,
			entry.prevContactState,
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
	});
	if (failedNode) {
		failedNode.dataset.pendingId = pendingId;
		failedNode.dataset.contactId = entry.contactId;
		if (entry.node && entry.node.parentNode)
			entry.node.parentNode.replaceChild(failedNode, entry.node);
		entry.node = failedNode;
		entry.timeoutId = null;
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
	// normalize and push into messages array
	const normalized = _normalizeOutgoing(sent);
	// preserve one-time flag
	normalized.isOneTime = sent.isOneTime || false;
	if (!messages[entry.contactId]) messages[entry.contactId] = [];
	normalized.index = messages[entry.contactId].length;
	messages[entry.contactId].push(normalized);

	// replace DOM node with confirmed message
	const newNode = createMessage(normalized);
	if (newNode) {
		newNode.dataset.index = normalized.index;
		newNode.dataset.messageId = normalized.id;
		// find current node and replace
		if (entry.node && entry.node.parentNode)
			entry.node.parentNode.replaceChild(newNode, entry.node);
	}

	// remove pending tracking
	pendingMessages.delete(pendingId);

	// update contact preview
	const contact = contacts.find((c) => c.id === entry.contactId);
	if (contact) {
		contact.lastMessage = getContactPreviewText(normalized);
		contact.lastMessageTime = normalized.time;
		contact.lastMessageDate = normalized.date;
		contact.lastMessageSeen = false;
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
) {
	if (!contact) return;

	// Remove empty-state placeholder if present so the pending message replaces it
	hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
	const now = new Date();
	const timeStr = now.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const dateStr = now.toISOString().slice(0, 10);

	// create pending DOM node
	const pendingId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	const pendingNode = createMessage({
		user: true,
		text,
		time: timeStr,
		pending: true,
		isOneTime: !!isOneTime,
		isTimeCapsule: !!isTimeCapsule,
		scheduledFor: scheduledFor || null,
		isLocked: false,
	});
	pendingNode.dataset.pendingId = pendingId;
	pendingNode.dataset.contactId = contact.id;

	// insert date separator if needed
	const prev =
		messages[contact.id] && messages[contact.id].length
			? messages[contact.id][messages[contact.id].length - 1]
			: null;
	if (!_dom.chatEl) return;
	if (!prev || prev.date !== dateStr) {
		_dom.chatEl.appendChild(createDateSeparator(dateStr));
	}
	_dom.chatEl.appendChild(pendingNode);
	scrollChatToBottom();

	// update contact preview immediately
	if (contact) {
		contact.lastMessage = text;
		contact.lastMessageTime = timeStr;
		contact.lastMessageDate = dateStr;
		contact.lastMessageSeen = false;
		refreshCard(contact);
		sortActiveChats();
		sortContacts();
	}

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
	});

	// send via socket (don't await here to allow timeout behavior)
	(async () => {
		try {
			const sent = await emitMessage({
				conversationId: contact.conversationId,
				text,
				replyToId: replyTo?.id || null,
				replyToName: replyTo?.sender || replyTo?.name || null,
				replyToText: replyTo?.text || null,
				isOneTime: !!isOneTime,
				isTimeCapsule: !!isTimeCapsule,
				scheduledFor: scheduledFor || null,
			});
			// confirm pending (if still present)
			await _confirmPending(pendingId, sent);
		} catch (e) {
			console.error("Failed to send message", e);
			// mark failed in UI
			_markPendingFailed(pendingId);
		}
	})();
}
