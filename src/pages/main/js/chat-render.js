import { applyReactionsToMessage, createMessage } from "../../../components/messages/messages.js";
import { handleCapsuleOpened } from "./chat-capsule.js";
import { openChat } from "./chat-open.js";
import { updatePinCount } from "./chat-pinned.js";
import { nearBottom, scrollChatToBottom } from "./chat-scroll.js";
import { _dom, _pendingCapsuleReveals, _revealedCapsuleIds, _suppressInjectScroll, _unreadSeparatorContactId, _unreadSeparatorIndex } from "./chat-state.js";
import { getCurrentUser } from "./currentUser.js";
import { contacts, messages, state } from "./state.js";
import { hideEmptyState, showEmptyState } from "./ui.js";

export function formatDateLabel(dateStr) {
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

export function createDateSeparator(dateStr) {
	const el = document.createElement("div");
	el.className = "date-separator";
	const span = document.createElement("span");
	span.textContent = formatDateLabel(dateStr);
	el.appendChild(span);
	return el;
}

export function createUnreadSeparator() {
	const el = document.createElement("div");
	el.className = "unread-separator";
	el.setAttribute("role", "separator");
	el.setAttribute("aria-label", "Unread messages");
	const span = document.createElement("span");
	span.textContent = "Unread messages";
	el.appendChild(span);
	return el;
}

export function injectMessages(userId) {
	if (!_dom.chatEl) return;

	// Remember whether the view was near the bottom before we re-render so
	// we can preserve the user's scroll position (or pin to bottom) after
	// the DOM changes. This prevents an intermediate scroll from being lost
	// when another async render happens shortly after.
	let wasNear = false;
	try {
		wasNear = nearBottom(_dom.chatEl);
	} catch (e) {
		/* ignore */
	}
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

	// find the first incoming message that is unseen.
	// Treat missing/undefined isSeen as unseen (i.e., isSeen !== true).
	let firstUnseenIndex;
	if (_unreadSeparatorContactId === userId && _unreadSeparatorIndex !== -1) {
		firstUnseenIndex = _unreadSeparatorIndex;
	} else {
		firstUnseenIndex = Array.isArray(userMessages)
			? userMessages.findIndex((m) => m.isSeen !== true && !m.user)
			: -1;
	}

	// Fallback: if server didn't include explicit isSeen flags but contact
	// still reports unreadCount, place the separator before the last N
	// incoming messages (N = contact.unreadCount).
	if (
		!(_unreadSeparatorContactId === userId && _unreadSeparatorIndex !== -1)
	) {
		try {
			if (firstUnseenIndex === -1) {
				const contact = contacts.find((c) => c.id === userId);
				const unread = contact ? contact.unreadCount || 0 : 0;
				if (
					unread > 0 &&
					Array.isArray(userMessages) &&
					userMessages.length > 0
				) {
					let needed = Number(unread);
					let count = 0;
					for (let i = userMessages.length - 1; i >= 0; i--) {
						if (!userMessages[i].user) {
							count++;
							if (count === needed) {
								firstUnseenIndex = i;
								break;
							}
						}
					}
					// If we never reached 'needed' but counted some incoming msgs,
					// place separator at earliest incoming message.
					if (firstUnseenIndex === -1 && count > 0) {
						for (let i = 0; i < userMessages.length; i++) {
							if (!userMessages[i].user) {
								firstUnseenIndex = i;
								break;
							}
						}
					}
				}
			}
		} catch (e) {
			/* ignore fallback errors */
		}
	}

	// Debug: log unseen summary to help diagnose missing separator
	try {
		const _unseenCount = Array.isArray(userMessages)
			? userMessages.filter((m) => m.isSeen !== true && !m.user).length
			: 0;
		const contact = contacts.find((c) => c.id === userId);
		const _contactUnread = contact ? contact.unreadCount || 0 : 0;
	} catch (e) {
		/* ignore debug errors */
	}

	const fragment = document.createDocumentFragment();
	userMessages.forEach((message, index) => {
		message.index = index;

		if (message.date && message.date !== lastDate) {
			fragment.appendChild(createDateSeparator(message.date));
			lastDate = message.date;
		}

		// insert unread separator just before the first unseen incoming message
		if (index === firstUnseenIndex && firstUnseenIndex !== -1) {
			fragment.appendChild(createUnreadSeparator());
		}

		const _msgEl = createMessage(message);
		if (message.reactions && message.reactions.length > 0) {
			try {
				const _cu = getCurrentUser();
				applyReactionsToMessage(
					_msgEl,
					message.reactions,
					_cu?.id || null,
				);
			} catch (e) {}
		}
		fragment.appendChild(_msgEl);
		if (message.isPinned) state.pinnedIndexes.push(index);
	});

	if (state.pinnedIndexes.length > 0) {
		state.pinnedIndexes.sort((a, b) => a - b);
		const lastIdx = state.pinnedIndexes[state.pinnedIndexes.length - 1];
		_dom.pinnedMessageText.textContent = messages[userId][lastIdx].text;
		_dom.pinnedMessageText.dataset.messageId = String(messages[userId][lastIdx].id);
		_dom.pinnedMessageContainer.style.display = "flex";
		_dom.chatHeader.style.borderRadius = "1rem 1rem 0 0";
		updatePinCount(lastIdx);
	}

	_dom.chatEl.appendChild(fragment);

	// Track messageIds we schedule reveals for during this render so we
	// don't double-schedule the same reveal from the offline-scan below.
	const _scheduledNow = new Set();

	// After rendering, trigger any pending capsule reveals for this conversation
	try {
		if (_pendingCapsuleReveals.size > 0 && state.contactUserId === userId) {
			_pendingCapsuleReveals.forEach((payload, mid) => {
				const el = _dom.chatEl.querySelector(`.chat-message[data-message-id="${mid}"]`);
				if (el) {
					_pendingCapsuleReveals.delete(mid);
					_scheduledNow.add(mid);
					setTimeout(() => {
						try {
							handleCapsuleOpened({ messageId: Number(mid), ...payload });
						} catch (e) { /* ignore */ }
					}, 1200);
				}
			});
		}
	} catch (e) { /* ignore */ }

	// If any time-capsules were opened while this client was offline (openedAt set
	// on the server) and we haven't yet shown the reveal animation locally, render
	// them as locked and trigger the usual reveal flow so the user sees the
	// unlock animation when they open the chat.
	try {
		const userMsgs = userMessages || [];
		if (state.contactUserId === userId) {
			const _curContact = contacts.find(c => c.id === state.contactUserId);
			userMsgs.forEach((m) => {
				try {
					if (!m) return;
					if (m.isTimeCapsule && m.openedAt && !m.user && !_revealedCapsuleIds.has(String(m.id)) && !_scheduledNow.has(String(m.id))) {
						const existingEl = _dom.chatEl.querySelector(`.chat-message[data-message-id="${m.id}"]`);
						if (existingEl) {
							// If element wasn't rendered as locked, replace with a locked rendering
							if (!existingEl.classList.contains('capsule-locked')) {
								const newEl = createMessage({ ...m, isLocked: true });
								newEl.dataset.messageId = m.id;
								existingEl.parentNode.replaceChild(newEl, existingEl);
							}
							// Delay slightly so layout stabilizes before running reveal
							setTimeout(() => {
								try {
									handleCapsuleOpened({ messageId: m.id, text: m.text, openedAt: m.openedAt, conversationId: _curContact?.conversationId });
								} catch (e) {}
							}, 800);
						}
					}
				} catch (e) { /* ignore per-message errors */ }
			});
		}
	} catch (e) { /* ignore fallback errors */ }

	// After rendering messages, ensure viewport is pinned to the bottom
	// after the browser paints. Respect `_suppressInjectScroll` so callers
	// that intentionally suppress auto-scrolling (e.g., `openChat`) keep
	// control of final positioning.
	try {
		if (
			!_suppressInjectScroll &&
			state.contactUserId === userId &&
			wasNear
		) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					try {
						const el = _dom.chatEl;
						const doScroll = () => {
							try {
								scrollChatToBottom();
							} catch (e) {
								/* ignore */
							}
						};
						// Retry a couple of times in case of late layout shifts (images/fonts)
						const scheduleRetries = () => {
							try {
								setTimeout(doScroll, 80);
								setTimeout(doScroll, 200);
							} catch (e) {
								/* ignore */
							}
						};
						if (!el) return doScroll();
						const imgs = Array.from(
							el.querySelectorAll("img"),
						).filter((i) => !i.complete);
						if (imgs.length > 0) {
							let loaded = 0;
							const onOne = () => {
								loaded++;
								if (loaded >= imgs.length) {
									doScroll();
									scheduleRetries();
								}
							};
							imgs.forEach((img) => {
								img.addEventListener("load", onOne, {
									once: true,
								});
								img.addEventListener("error", onOne, {
									once: true,
								});
							});
							setTimeout(() => {
								doScroll();
								scheduleRetries();
							}, 300);
						} else {
							doScroll();
							scheduleRetries();
						}
					} catch (e) {
						/* ignore */
					}
				});
			});
		}
	} catch (e) { /* ignore */ }

	// After rendering messages, apply reaction badges for messages that have reactions
	try {
		const _cu = getCurrentUser();
		const currentUserId = _cu?.id || null;
		userMessages.forEach((msg) => {
			if (
				msg &&
				Array.isArray(msg.reactions) &&
				msg.reactions.length > 0
			) {
				const msgEl = _dom.chatEl.querySelector(
					`.chat-message[data-message-id="${msg.id}"]`,
				);
				try { applyReactionsToMessage(msgEl, msg.reactions, currentUserId); } catch (e) { /* ignore */ }
					}
				});
	} catch (e) {
		/* ignore */
	}
}
