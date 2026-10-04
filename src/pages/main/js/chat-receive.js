import { applyReactionsToMessage, createMessage, markMessagesAsSeen } from "../../../components/messages/messages.js";
import { moveToActiveChats, moveToContacts, refreshCard, sortActiveChats, sortContacts, updateTotalUnreadCount } from "./chat-logic.js";
import { markOpenChatSeen } from "./chat-open.js";
import { updatePinnedData, updatePinnedMessage } from "./chat-pinned.js";
import { createDateSeparator, createUnreadSeparator, messageForDisplay } from "./chat-render.js";
import { nearBottom, scrollChatToBottom, scrollChatToBottomAfterPadding } from "./chat-scroll.js";
import { _currentUserId, _dom, _localNotifQueue, basePadding, getContactPreviewText, lineHeight, maxLines, normalizeServerMessage } from "./chat-state.js";
import { getCurrentUser } from "./currentUser.js";
import { showNotification } from "./in-app-notification.js";
import { contacts, messages, state } from "./state.js";
import { hideEmptyState } from "./ui.js";

// Set by main.js: refreshes the contact list from the server and redraws it
let _syncContacts = null;
export function setContactsSync(fn) {
	_syncContacts = fn;
}

function _pageVisible() {
	try {
		return document.visibilityState !== "hidden";
	} catch (e) {
		return true;
	}
}

export async function receiveMessage(message) {
	if (!message || message.id == null) return;
	let contact = contacts.find(
		(c) => c.conversationId === message.conversationId,
	);

	// A conversation we do not know yet: someone added us, or wrote to us
	// after we had removed them. Refresh the list from the server.
	if (!contact) {
		try {
			await _syncContacts?.();
		} catch (e) {
			console.error("receiveMessage: failed to sync contacts", e);
		}
		contact = contacts.find((c) => c.conversationId === message.conversationId);
		if (!contact) return;
	}

	// The same message can arrive twice (live event + catch-up after a
	// reconnect); never show it twice.
	const known = messages[contact.id];
	if (Array.isArray(known) && known.some((m) => String(m.id) === String(message.id))) return;

	const normalized = normalizeServerMessage(message);
	const isOpen = state.contactUserId === contact.id;
	const visible = _pageVisible();

	if (!messages[contact.id]) messages[contact.id] = [];
	messages[contact.id].push(normalized);

	// اگه همین چت بازه نشون بده
	if (isOpen && _dom.chatEl) {
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
		normalized.index = messages[contact.id].length - 1;
		// If this incoming message falls on a different day than the previous
		// message, insert a date separator before appending it so the UI
		// updates live without requiring a refresh.
		const prevMsg = messages[contact.id][normalized.index - 1] || null;
		if (!prevMsg || prevMsg.date !== normalized.date) {
			_dom.chatEl.appendChild(createDateSeparator(normalized.date));
		}
		// Arrived while the app was in the background: mark where unread starts
		if (!normalized.user && !visible && !_dom.chatEl.querySelector(".unread-separator")) {
			_dom.chatEl.appendChild(createUnreadSeparator());
		}
		const newEl = createMessage(messageForDisplay(normalized, contact.id));
		try {
			if (normalized.reactions && normalized.reactions.length > 0) {
				const _cu = getCurrentUser();
				applyReactionsToMessage(newEl, normalized.reactions, _cu?.id || null);
			}
		} catch (e) {
			/* ignore */
		}
		// If the user is at the bottom, follow the new message and mark it
		// seen; otherwise show the "scroll to bottom" button.
		const wasAtBottom = nearBottom(_dom.chatEl);
		_dom.chatEl.appendChild(newEl);
		if (wasAtBottom) {
			scrollChatToBottom();
			if (!normalized.user && visible) markOpenChatSeen();
		} else {
			try {
				_dom.scrollToBottomBtn?.classList.add("visible");
			} catch (e) {}
		}
	}

	// کارت رو آپدیت کن
	// Use centralized preview helper so locked time-capsule content is never exposed
	contact.lastMessage = getContactPreviewText(normalized);
	contact.lastMessageId = normalized.id;
	contact.lastMessageTime = normalized.time;
	contact.lastMessageDate = normalized.date;
	// used to order the Contacts section (most recent first)
	const _receivedTs = new Date(message.createdAt).getTime();
	contact.lastMessageTs = Number.isFinite(_receivedTs) ? _receivedTs : Date.now();

	if (normalized.user) {
		// sent by this user from another device: not seen by the other side yet
		contact.lastMessageSeen = normalized.isSeen === true;
	} else if (isOpen && visible) {
		contact.lastMessageSeen = true;
	} else {
		contact.lastMessageSeen = false;
		contact.unreadCount = (contact.unreadCount || 0) + 1;
		// While the app is hidden the server sends a push notification instead
		try {
			if (visible && !contact.isSaved && !contact.isMuted) {
				const notifQueue = _localNotifQueue;
				if (!notifQueue.has(normalized.id)) {
					notifQueue.add(normalized.id);
					setTimeout(() => notifQueue.delete(normalized.id), 5000);
					showNotification(contact, { id: normalized.id, text: getContactPreviewText(normalized) });
				}
			}
		} catch (e) {
			// ignore notification errors
		}
	}

	// Do not auto-unarchive when receiving a message. Keep archived contacts archived
	// until the local user explicitly sends a message (auto-unarchive on send).
	if (!contact.isArchived) {
		moveToActiveChats(contact);
	}
	refreshCard(contact);
	sortActiveChats();
	updateTotalUnreadCount();
}

export function handleOnetimeDeleted({ messageIds }) {
	if (!Array.isArray(messageIds) || messageIds.length === 0) return;
	const idSet = new Set(messageIds.map(String));

	// First: apply a small fade/scale animation to any visible DOM nodes
	try {
		if (_dom && _dom.chatEl) {
			messageIds.forEach((id) => {
				const el = _dom.chatEl.querySelector(
					`.chat-message[data-message-id="${id}"]`,
				);
				if (el) {
					el.style.transition =
						"opacity 0.3s ease, transform 0.3s ease";
					el.style.opacity = "0";
					el.style.transform = "scale(0.95)";
				}
			});
		}
	} catch (e) {
		/* ignore animation errors */
	}

	// After animation completes, remove messages from memory, update UI and contact previews
	setTimeout(() => {
		const affectedUids = new Set();

		for (const [_uid, msgs] of Object.entries(messages)) {
			if (!Array.isArray(msgs)) continue;
			const before = msgs.length;
			const filtered = msgs.filter((m) => !idSet.has(String(m.id)));
			if (filtered.length !== before) {
				messages[Number(_uid)] = filtered;
				filtered.forEach((m, i) => {
					m.index = i;
				});
				affectedUids.add(Number(_uid));
			}
		}

		// Remove any pinned cache entries for the deleted messages so the
		// pinned banner doesn't show stale content.
		try {
			for (const uid of affectedUids) {
				for (const mid of idSet) {
					try { updatePinnedData(Number(uid), mid, null, false); } catch (e) {}
				}
			}
		} catch (e) {}

		// Remove DOM nodes if still present and fix the indices of the rest
		try {
			if (_dom && _dom.chatEl) {
				messageIds.forEach((id) => {
					_dom.chatEl.querySelector(`.chat-message[data-message-id="${id}"]`)?.remove();
				});
				_removeEmptyDateSeparators(_dom.chatEl);
				if (state.contactUserId && affectedUids.has(Number(state.contactUserId))) {
					_reindexDom(Number(state.contactUserId));
					updatePinnedMessage();
				}
			}
		} catch (e) {
			/* ignore */
		}

		// Update contact previews for affected conversations. One-time
		// messages are removed only after they were seen, so unread counters
		// do not change here.
		try {
			for (const uid of affectedUids) {
				const friend = contacts.find((c) => c.id === Number(uid));
				if (!friend) continue;
				// only the latest message decides the preview
				if (friend.lastMessageId != null && !idSet.has(String(friend.lastMessageId))) continue;
				const arr = messages[uid] || [];
				if (arr.length > 0) {
					const lastMsg = arr[arr.length - 1];
					friend.lastMessage = getContactPreviewText(lastMsg);
					friend.lastMessageId = lastMsg.id ?? null;
					friend.lastMessageTime = lastMsg.time || "";
					friend.lastMessageDate = lastMsg.date || "";
					friend.lastMessageTs = lastMsg.createdAt || 0;
					friend.lastMessageSeen = lastMsg.user
						? lastMsg.isSeen !== false
						: true;
				} else {
					friend.lastMessage = "";
					friend.lastMessageId = null;
					friend.lastMessageTime = "";
					friend.lastMessageDate = "";
					friend.lastMessageTs = 0;
					friend.lastMessageSeen = true;
				}
				refreshCard(friend);
			}
			sortActiveChats();
			sortContacts();
			updateTotalUnreadCount();
		} catch (e) {
			/* ignore */
		}

		// Recompute chat padding to avoid leftover spacing after DOM changes
		try {
			if (_dom && _dom.chatEl) {
				const inputEl = _dom.messageInput;
				if (inputEl) {
					let lines = Math.floor(inputEl.scrollHeight / lineHeight);
					if (lines < 1) lines = 1;
					if (lines > maxLines) lines = maxLines;
					if (lines < maxLines) {
						_dom.chatEl.style.paddingBottom =
							basePadding +
							2 * (lines - 1) * 0.75 +
							state.actionPreviewHeight +
							"rem";
					} else {
						_dom.chatEl.style.paddingBottom =
							basePadding +
							2 * ((maxLines - 2) * 0.75 + 0.2) +
							state.actionPreviewHeight +
							"rem";
					}
				} else {
					_dom.chatEl.style.paddingBottom =
						basePadding + state.actionPreviewHeight + "rem";
				}
				// If conversation open, ensure scroll stays correct
				if (state.contactUserId && nearBottom(_dom.chatEl)) scrollChatToBottomAfterPadding();
			}
		} catch (e) {
			/* ignore */
		}
	}, 300);
}

// data-index of every rendered message must match its place in messages[]
function _reindexDom(uid) {
	const arr = messages[uid] || [];
	const pos = new Map(arr.map((m, i) => [String(m.id), i]));
	_dom.chatEl.querySelectorAll(".chat-message[data-message-id]").forEach((node) => {
		const mid = node.dataset.messageId;
		if (!mid) return;
		const i = pos.get(String(mid));
		if (i !== undefined) node.dataset.index = String(i);
	});
	state.pinnedIndexes = arr.map((m, i) => (m.isPinned ? i : -1)).filter((i) => i !== -1);
}

// A day line with no message after it (its messages were all removed)
export function _removeEmptyDateSeparators(chatEl) {
	if (!chatEl) return;
	chatEl.querySelectorAll(".date-separator").forEach((sep) => {
		let next = sep.nextElementSibling;
		while (next && next.classList.contains("unread-separator")) next = next.nextElementSibling;
		if (!next || next.classList.contains("date-separator")) sep.remove();
	});
}

// ─── Send message ─────────────────────────────────────────────────────────────

export function _updateContactCard() {
	const userMsgs = messages[state.contactUserId];
	const lastMsg = userMsgs?.at(-1);
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (friend && lastMsg) {
		friend.lastMessage = getContactPreviewText(lastMsg);
		friend.lastMessageId = lastMsg.id ?? null;
		friend.lastMessageTime = lastMsg.time;
		friend.lastMessageDate = lastMsg.date;
		const ts = new Date(lastMsg.createdAt).getTime();
		friend.lastMessageTs = Number.isFinite(ts) ? ts : Date.now();
		friend.lastMessageSeen = false; //new outgoing message which 2nd person has not seen
		moveToActiveChats(friend);
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

	const me = _currentUserId();
	const ids = Array.isArray(messageIds) ? messageIds : [];
	const anyMarked = ids.length > 0;
	const userMsgs = messages[contact.id];
	const isOpen = state.contactUserId === contact.id;

	// Read on another device of this user: their incoming messages are read
	if (seenBy !== null && Number(seenBy) === Number(me)) {
		if (Array.isArray(userMsgs)) {
			const idSet = new Set(ids.map(String));
			userMsgs.forEach((m) => {
				if (!m.user && idSet.has(String(m.id))) m.isSeen = true;
			});
		}
		if (anyMarked) {
			contact.unreadCount = 0;
			if (isOpen) _dom.chatEl?.querySelector(".unread-separator")?.remove();
			refreshCard(contact);
			updateTotalUnreadCount();
			if (
				!isOpen &&
				!contact.isPinned &&
				!contact.isSaved &&
				contact.lastMessageSeen !== false
			) {
				moveToContacts(contact);
				sortContacts();
			}
			sortActiveChats();
		}
		return;
	}

	// The other person read this user's messages
	const seenIndices = [];
	if (anyMarked && Array.isArray(userMsgs)) {
		const idSet = new Set(ids.map(String));
		userMsgs.forEach((msg, idx) => {
			if (msg.user && !msg.isSeen && idSet.has(String(msg.id))) {
				msg.isSeen = true;
				seenIndices.push(idx);
			}
		});
	}

	// Update DOM only if this conversation is currently open and there are indices
	if (isOpen && seenIndices.length > 0) {
		markMessagesAsSeen(_dom.chatEl, seenIndices);
	}

	if (anyMarked && seenBy !== null) {
		contact.lastMessageSeen = true;
		refreshCard(contact);
		// the chat on screen keeps its card in Active Chats
		if (
			!isOpen &&
			!contact.isPinned &&
			!contact.isSaved &&
			(contact.unreadCount || 0) === 0
		) {
			moveToContacts(contact);
			sortContacts();
		}
		sortActiveChats();
	}
}
