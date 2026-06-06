import { state, messages, contacts, findMessageById } from "./state.js";
import { showEmptyState, hideEmptyState, showToast } from "./ui.js";
import {
	createMessage,
	markMessagesAsSeen,
	applyReactionsToMessage,
	unlockCapsule,
} from "../../../components/messages/messages.js";
import {
	moveToActiveChats,
	moveToContacts,
	refreshCard,
	sortActiveChats,
	sortContacts,
	updateTotalUnreadCount,
} from "./chat-logic.js";
import {
	emitMessage,
	emitEditMessage,
	emitMessageSeen,
	getSocket,
} from "./socket.js";
import {
	getMessagesPage,
	getContacts,
	updateContact as apiUpdateContact,
	getPinnedMessages,
} from "./api.js";
import { makeMessageSkeleton, createTopMessageSkeleton } from "./skeleton.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../../components/active-chats/active-chats.js";
import { showNotification } from "./in-app-notification.js";
import { getCurrentUserId } from "../../../utils/user.js";
import { getCurrentUser } from "./currentUser.js";

// Local notification dedupe fallback (main may expose window._notifQueue)
const _localNotifQueue = new Set();

// Persisted set of capsule messageIds we've already shown the reveal animation for.
// Stored in localStorage so reloads don't re-play the reveal.
const _REVEALED_CAPSULES_KEY = "rivo.revealedCapsules";
let _revealedCapsuleIds = new Set();
try {
	const raw = localStorage.getItem(_REVEALED_CAPSULES_KEY) || "[]";
	const arr = JSON.parse(raw || "[]");
	if (Array.isArray(arr)) arr.forEach((id) => _revealedCapsuleIds.add(String(id)));
} catch (e) {
	_revealedCapsuleIds = new Set();
}

function _markCapsuleRevealed(id) {
	try {
		if (!id) return;
		const sid = String(id);
		if (_revealedCapsuleIds.has(sid)) return;
		_revealedCapsuleIds.add(sid);
		try {
			localStorage.setItem(_REVEALED_CAPSULES_KEY, JSON.stringify(Array.from(_revealedCapsuleIds)));
		} catch (e) {}
	} catch (e) {}
}

// ─── Constants ────────────────────────────────────────────────────────────────
export const basePadding = 4;
export const lineHeight = 22.4;
export const maxLines = 7;
export const maxHeight = lineHeight * maxLines;
// Read client pagination config from environment or global injected config.
function _getClientEnvNumber(name, fallback) {
	try {
		if (typeof process !== "undefined" && process.env && process.env[name]) {
			const v = Number(process.env[name]);
			if (!Number.isNaN(v)) return v;
		}
	} catch (e) {}

	try {
		if (typeof window !== "undefined") {
			// Attempt multiple injected config sources
			if (window.__RIVO_CLIENT_CONFIG && window.__RIVO_CLIENT_CONFIG[name] != null) {
				const v = Number(window.__RIVO_CLIENT_CONFIG[name]);
				if (!Number.isNaN(v)) return v;
			}
			if (window.__env && window.__env[name] != null) {
				const v = Number(window.__env[name]);
				if (!Number.isNaN(v)) return v;
			}
			if (window.RIVO_CONFIG && window.RIVO_CONFIG[name] != null) {
				const v = Number(window.RIVO_CONFIG[name]);
				if (!Number.isNaN(v)) return v;
			}
		}
	} catch (e) {}

	return fallback;
}
	// debug log removed
function _getClientEnvBool(name, fallback) {
	try {
		if (typeof process !== 'undefined' && process.env && typeof process.env[name] !== 'undefined') {
			const raw = String(process.env[name]).toLowerCase();
			return raw === '1' || raw === 'true';
		}
	} catch (e) {}
	try {
		if (typeof window !== 'undefined') {
			const src = (window.__RIVO_CLIENT_CONFIG && window.__RIVO_CLIENT_CONFIG[name]) || (window.__env && window.__env[name]) || (window.RIVO_CONFIG && window.RIVO_CONFIG[name]);
			if (typeof src !== 'undefined' && src !== null) {
				const raw = String(src).toLowerCase();
				return raw === '1' || raw === 'true';
			}
		}
	} catch (e) {}
	return !!fallback;
}

export const DEFAULT_PAGE_LIMIT = _getClientEnvNumber('DEFAULT_PAGE_LIMIT', 50);
// Client-side hard limit to avoid requesting huge pages
export const MAX_CLIENT_PAGE_LIMIT = _getClientEnvNumber('MAX_CLIENT_PAGE_LIMIT', 100);
// Returns a safe preview string for contact cards. For locked time-capsule
// messages destined for the recipient, return an empty string so nothing
// is leaked in contact lists or previews.
export function getContactPreviewText(msg) {
	try {
		if (!msg) return "";
		const isSenderLocal = !!msg.user;
		// If message is a time-capsule and still locked for the recipient,
		// don't reveal anything in previews. If it has been opened and the
		// server provided plaintext, show that; otherwise show a neutral
		// placeholder.
		if (msg.isTimeCapsule) {
			if (msg.isLocked && !isSenderLocal) return "";
			if (msg.openedAt && !isSenderLocal) {
				if (msg.text) return msg.text;
				return "Time capsule unlocked";
			}
		}
		return msg.text || "";
	} catch (e) {
		return "";
	}
}
// After server reports messages marked as seen, keep the unread separator
// visible for at least this many milliseconds before applying the seen state
const _MIN_SEPARATOR_VISIBLE_AFTER_MARK_MS = 600;

// Returns true when the chat view is near bottom within `offset` pixels.
export function nearBottom(chatEl, offset = 70) {
	if (!chatEl) return false;
	return (
		chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - offset
	);
}

// Returns true when the chat view is near the start (oldest messages)
// within `offset` pixels. This handles reversed layouts by comparing
// the first message element's proximity to the container edges.
export function nearTop(chatEl, offset = 60) {
	if (!chatEl) return false;
	try {
		const firstEl = chatEl.querySelector('.chat-message');
		if (!firstEl) return false;
		const firstRect = firstEl.getBoundingClientRect();
		const chatRect = chatEl.getBoundingClientRect();
		const distTop = Math.abs(firstRect.top - chatRect.top);
		const distBottom = Math.abs(chatRect.bottom - firstRect.bottom);
		// Determine which edge the first element is anchored to and
		// compare distance to that edge.
		if (distTop <= distBottom) {
			return (firstRect.top - chatRect.top) <= offset;
		}
		return (chatRect.bottom - firstRect.bottom) <= offset;
	} catch (e) {
		return false;
	}
}

function _chatPaddingBottom() {
	try {
		if (!_dom || !_dom.chatEl) return 0;
		// Prefer the actual input element height if available so the last
		// message aligns above the input area (covers overlay/input cases).
		const inputEl = _dom.messageInput;
		if (inputEl) {
			try {
				const r = inputEl.getBoundingClientRect();
				if (r && r.height) return r.height;
			} catch (e) {
				// fall back to computed style
			}
		}
		const el = _dom.chatEl;
		const style = getComputedStyle(el);
		return parseFloat(style.paddingBottom) || 0;
	} catch (e) {
		return 0;
	}
}

		// debug log removed
export function canLoadOlder() {
	try {
		const uid = state.contactUserId;
		if (!uid) return false;
		const meta = messagePaging[uid];
		if (!meta) return true; // allow if no metadata yet
		return !!meta.hasMore && !meta.loading;
	} catch (e) {
		return false;
	}
}

// Cap messages kept per conversation to avoid unbounded client memory growth
const MAX_MESSAGES_PER_CONVERSATION = 1000;

// Pending capsule reveals received while chat or message element not present
const _pendingCapsuleReveals = new Map(); // String(messageId) -> { text, openedAt, conversationId }

let _dom = {};
// Unread messages separator state
let _unreadSeparatorContactId = null;
let _unreadSeparatorIndex = -1;
// paging state per contact
const messagePaging = {};
// pinned messages cache fetched separately from pagination
const pinnedData = {}; // contactId -> [{ id, text, senderId, createdAt }]
export function getPinnedData(contactId) {
	return pinnedData[contactId] || [];
}

// Update in-memory pinned cache for a contact. Used by UI actions
// (pin/unpin) so the pinned banner reflects changes immediately.
export function updatePinnedData(contactId, messageId, messageObj, isPinned) {
	try {
		if (!contactId) return;
		if (!pinnedData[contactId]) pinnedData[contactId] = [];
		const arr = pinnedData[contactId];
		const mid = String(messageId || (messageObj && messageObj.id) || '');
		if (!mid) return;
		if (isPinned) {
			const exists = arr.some((p) => String(p.id) === String(mid));
			if (!exists) {
				arr.push({
					id: mid,
					text: (messageObj && messageObj.text) || '',
					senderId: messageObj && messageObj.user ? getCurrentUserId() : (messageObj && messageObj.senderId) || null,
					createdAt: (messageObj && messageObj.createdAt) || Date.now(),
				});
			}
		} else {
			pinnedData[contactId] = arr.filter((p) => String(p.id) !== String(mid));
		}
	} catch (e) {}
}
// Map of pending messages keyed by pendingId -> { node, timeoutId, contactId, text, replyTo }
const pendingMessages = new Map();
// Timeout handle used to debounce/delay marking messages as seen when opening a chat
let _seenTimeoutId = null;
	// debug log removed
let _seenApplyTimeoutId = null;

let _suppressInjectScroll = false;

export function initChat(dom) {
	_dom = dom;

	// Delegated click handler for failed message buttons
	try {
		if (_dom.chatEl) {
			_dom.chatEl.addEventListener("click", (e) => {
				const btn =
					e.target.closest && e.target.closest(".msg-failed-btn");
				if (!btn) return;
				e.stopPropagation();
				const msgEl = btn.closest(".chat-message");
				if (!msgEl) return;
				const pendingId = msgEl.dataset.pendingId;
				_toggleFailedPanel(msgEl, pendingId);
			});
		}
	} catch (e) {
		/* ignore */
	}
}

// ─── Scroll ───────────────────────────────────────────────────────────────────
export function scrollChatToBottom() {
	if (!_dom.chatEl) return;
	try {
		state.isProgrammaticScroll = true;
	} catch (e) {}
	requestAnimationFrame(() => {
		if (_dom.chatEl) _dom.chatEl.scrollTop = _dom.chatEl.scrollHeight;
		requestAnimationFrame(() => {
			try {
				state.isProgrammaticScroll = false;
			} catch (e) {}
		});
	});
}

export function scrollChatToBottomAfterPadding(timeout = 400) {
	if (!_dom.chatEl) return;
	const el = _dom.chatEl;
	let called = false;

	try {
		state.isProgrammaticScroll = true;
	} catch (e) {}

	function doScroll() {
		if (called) return;
		called = true;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
			requestAnimationFrame(() => {
				// یه بار دیگه بعد از RAF برای layout shifts ناشی از fonts/images
				// debug log removed
				try {
					state.isProgrammaticScroll = false;
				} catch (e) {}
			});
		});
	}

	// debug log removed
	el.addEventListener("transitionend", function onT(e) {
		if (!e.propertyName || !e.propertyName.includes("padding")) return;
		el.removeEventListener("transitionend", onT);
		doScroll();
	});
	setTimeout(() => doScroll(), timeout);
}

// ─── Open / Close ─────────────────────────────────────────────────────────────
export async function openChat(fromClick = false) {
	const isAlreadyOpen = _dom.chatPart.style.display === "flex";
	const isMobile = window.matchMedia("(max-width: 768px)").matches;
	// Mark that we're initializing so pagination/scroll-based loads don't fire
	try {
		state.initializingChat = true;
	} catch (e) {}

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
	// contact lookup (no debug log)
	if (contact?.conversationId) {
		// show message skeletons while fetching
		if (_dom.chatEl) {
			_dom.chatEl
				.querySelectorAll(".skeleton-placeholder")
				.forEach((n) => n.remove());
			_dom.chatEl.appendChild(makeMessageSkeleton(8));
			_dom.chatEl.setAttribute("aria-busy", "true");
			// debug log removed
		}

		try {
			const PAGE_LIMIT = DEFAULT_PAGE_LIMIT;
			// debug log removed
			const serverMessages = await getMessagesPage(
				contact.conversationId,
				{ limit: PAGE_LIMIT },
			);
			// remove skeletons once we have results
			if (_dom.chatEl) {
				_dom.chatEl
					.querySelectorAll(".skeleton-placeholder")
					.forEach((n) => n.remove());
				_dom.chatEl.removeAttribute("aria-busy");
			}
			// debug log removed
			// normalize for frontend and keep createdAt for paging
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
				createdAt: m.createdAt,
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
				reactions: m.reactions || [],
				isOneTime: m.isOneTime || false,
				isTimeCapsule: m.isTimeCapsule || false,
				scheduledFor: m.scheduledFor || null,
				openedAt: m.openedAt || null,
				isLocked: m.isLocked || false,
			}));

			// fetch pinned messages separately (independent of pagination)
			try {
				const res = await getPinnedMessages(contact.conversationId);
				if (res && Array.isArray(res.pinned)) {
					pinnedData[state.contactUserId] = res.pinned;
				} else {
					pinnedData[state.contactUserId] = [];
				}
			} catch (e) {
				pinnedData[state.contactUserId] = [];
			}
			// debug log removed

			// paging metadata (suppress auto-load immediately after open)
			messagePaging[state.contactUserId] = {
				hasMore:
					Array.isArray(serverMessages) &&
					serverMessages.length === PAGE_LIMIT,
				loading: false,
				pageSize: PAGE_LIMIT,
				// optional prefetch buffer
				prefetched: null,
				prefetching: false,
				// prevent `loadOlderMessages` from firing immediately after open
				openSuppressedUntil: Date.now() + 3000,
			};
			// debug log removed
		} catch (err) {
			console.error("getMessagesPage failed", err);
			// debug log removed
			messages[state.contactUserId] = [];
			messagePaging[state.contactUserId] = {
				hasMore: false,
				loading: false,
			};
		}
	}

	// Hide chat while we render initial batch to avoid flicker during
	// positioning. We'll reveal after we've pinned to bottom.
	try {
		if (_dom && _dom.chatEl) {
			_dom.chatEl.style.visibility = "hidden";
			// debug log removed
		}
	} catch (e) {}

	// ثبت موقعیت separator قبل از اینکه isSeen تغییر کنه
	if (_unreadSeparatorContactId !== state.contactUserId) {
		const _loadedMsgs = messages[state.contactUserId] || [];
		_unreadSeparatorContactId = state.contactUserId;
		_unreadSeparatorIndex = _loadedMsgs.findIndex(
			(m) => m.isSeen !== true && !m.user,
		);
		if (_unreadSeparatorIndex === -1) {
			const _uc = contacts.find((c) => c.id === state.contactUserId);
			const _unread = _uc ? _uc.unreadCount || 0 : 0;
			if (_unread > 0) {
				let _cnt = 0;
				for (let i = _loadedMsgs.length - 1; i >= 0; i--) {
					if (!_loadedMsgs[i].user) {
						_cnt++;
						if (_cnt === _unread) {
							_unreadSeparatorIndex = i;
							break;
						}
					}
				}
			}
		}
	}
	_suppressInjectScroll = true;
	// Prevent the global scroll handler from triggering pagination while
	// we are doing the initial render and positioning.
	try {
		state.suppressScrollLoad = true;
	} catch (e) {}
	// debug log removed
	injectMessages(state.contactUserId);
	_suppressInjectScroll = false;
	// debug log removed

	// Safety: clear suppression in case positioning callback never fires
	setTimeout(() => {
		try {
			state.suppressScrollLoad = false;
		} catch (e) {}
	}, 1000);
	if (contact?.conversationId && fromClick) {
		// Delay marking messages as seen briefly so the unread separator
		// is visible to the user when the chat opens. Debounce multiple
		// rapid opens by clearing previous timeout.
		try {
			if (_seenTimeoutId) clearTimeout(_seenTimeoutId);
		} catch (e) {
			/* ignore */
		}
		_seenTimeoutId = setTimeout(() => {
			emitMessageSeen(contact.conversationId)
				.then((marked) => {
					try {
						const arr = messages[state.contactUserId] || [];

						// فقط isSeen رو توی memory آپدیت کن
						if (Array.isArray(marked) && marked.length > 0) {
							const idSet = new Set(marked.map(String));
							arr.forEach((m) => {
								if (!m.user && idSet.has(String(m.id)))
									m.isSeen = true;
							});
						} else {
							arr.forEach((m) => {
								if (!m.user) m.isSeen = true;
							});
						}

						// فقط separator رو از DOM حذف کن — بدون re-render
						if (_dom.chatEl) {
							_dom.chatEl
								.querySelector(".unread-separator")
								?.remove();
						}

						// unread count رو reset کن
						const c = contacts.find(
							(c) => c.id === state.contactUserId,
						);
						if (c) {
							c.unreadCount = 0;
							refreshCard(c);
							updateTotalUnreadCount();
						}

						// separator tracking reset
						_unreadSeparatorContactId = null;
						_unreadSeparatorIndex = -1;
					} catch (e) {
						/* ignore */
					}
				})
				.catch(() => {})
				.finally(() => {
					try {
						_seenTimeoutId = null;
					} catch (e) {
						/* ignore */
					}
				});
		}, 700);
	}
	if (_dom && _dom.chatProfilePicture) {
		if (contact?.isOnline) {
			_dom.chatProfilePicture.classList.add("online");
		} else {
			_dom.chatProfilePicture.classList.remove("online");
		}
	}

	// Pin to bottom (no smooth scroll). Reveal chat after padding settles.
	// Mark that we're doing a programmatic scroll so scroll handlers ignore it.
	try {
		state.isProgrammaticScroll = true;
	} catch (e) {}
	// Hide → render → scroll → reveal (instant, no corrective loop)
	try {
		if (_dom.chatEl) _dom.chatEl.style.visibility = "hidden";
	} catch (e) {}

	// No-op: messages were already injected above; retain programmatic scroll
	// setup without an extra injection.

	try {
		state.isProgrammaticScroll = true;
	} catch (e) {}
	requestAnimationFrame(() => {
		if (_dom.chatEl) {
			_dom.chatEl.scrollTop = _dom.chatEl.scrollHeight;
		}
		requestAnimationFrame(() => {
			if (_dom.chatEl) {
				_dom.chatEl.scrollTop = _dom.chatEl.scrollHeight; // second pass for layout shifts
				_dom.chatEl.style.visibility = "";
			}
			try {
				state.isProgrammaticScroll = false;
				state.suppressScrollLoad = false;
				state.initializingChat = false;
			} catch (e) {}
		});
	});
}

function _currentUserId() {
	return getCurrentUserId();
}

export function closeChat() {
	const isMobile = window.matchMedia("(max-width: 768px)").matches;

	_dom.peoplePart.querySelector(".main-header").style.display = "";
	_dom.peoplePart.querySelector(".main-header").style.zIndex = "";
	_dom.peoplePart.style.display = "";
	// Clear initializing flag if chat is closed mid-init
	try { state.initializingChat = false; } catch (e) {}

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
			if (sock)
				sock.emit("conversation:leave", {
					conversationId: prevContact.conversationId,
				});
		}
	} catch (e) {
		// ignore
	}

	// Cancel pending timeouts for messages in the chat being closed
	try {
		for (const [pid, entry] of pendingMessages) {
			if (entry && entry.contactId === state.contactUserId) {
				if (entry.timeoutId) {
					clearTimeout(entry.timeoutId);
					entry.timeoutId = null;
					pendingMessages.set(pid, entry);
				}
			}
		}
	} catch (e) {
		/* ignore */
	}
	// Clear seen-marking timeouts so they don't apply after the chat is closed
	try {
		if (_seenTimeoutId) {
			clearTimeout(_seenTimeoutId);
			_seenTimeoutId = null;
		}
	} catch (e) {
		/* ignore */
	}
	try {
		if (_seenApplyTimeoutId) {
			clearTimeout(_seenApplyTimeoutId);
			_seenApplyTimeoutId = null;
		}
	} catch (e) {
		/* ignore */
	}
	_unreadSeparatorContactId = null;
	// Reset send mode when chat is closed
	if (typeof state !== "undefined") {
		state.sendMode = "normal";
	}

	// Clear any pending capsule reveals tied to this chat
	try { _pendingCapsuleReveals.clear(); } catch (e) { /* ignore */ }
	// Notify other UI modules that the chat was closed so they can hide overlays
	try {
		document.dispatchEvent(new CustomEvent("chat:closed"));
	} catch (e) {
		/* ignore */
	}

	_unreadSeparatorIndex = -1;
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
export function updatePinnedMessage(contactId = state.contactUserId) {
	// Prefer server-provided pinned list if available
	const allPinned = pinnedData[contactId] || [];

	if (allPinned.length > 0) {
		if (contactId !== state.contactUserId) return;
		const latest = allPinned[allPinned.length - 1];
		_dom.pinnedMessageContainer.style.display = 'flex';
		_dom.pinnedMessageText.textContent = latest.text || '';
		_dom.pinnedMessageText.dataset.messageId = String(latest.id);
		_dom.chatHeader.style.borderRadius = '1rem 1rem 0 0';
		_updatePinCountFromData(allPinned, latest.id, contactId);
		return;
	}

	// Fallback to local model when pinnedData isn't available
	const userMessages = messages[contactId];
	if (!Array.isArray(userMessages)) return;
	const pinnedMsg = [...userMessages].reverse().find((msg) => msg.isPinned);
	if (pinnedMsg) {
		if (contactId === state.contactUserId) {
			_dom.pinnedMessageContainer.style.display = 'flex';
			_dom.pinnedMessageText.textContent = pinnedMsg.text;
			_dom.pinnedMessageText.dataset.messageId = String(pinnedMsg.id);
			_dom.chatHeader.style.borderRadius = '1rem 1rem 0 0';
		}
	} else {
		if (contactId === state.contactUserId) {
			_dom.pinnedMessageContainer.style.display = 'none';
			_dom.pinnedMessageText.textContent = '';
			_dom.pinnedMessageText.dataset.messageId = '';
			_dom.chatHeader.style.borderRadius = '1rem';
		}
	}

	if (contactId === state.contactUserId)
		updatePinCount(pinnedMsg ? pinnedMsg.index : null);
}

function _updatePinCountFromData(allPinned, activeId, contactId) {
	if (contactId !== state.contactUserId) return;
	_dom.pinnedMessageCount.textContent = '';
	const total = Math.min(allPinned.length, 3);
	if (total === 0) return;
	const pos = allPinned.findIndex((m) => m.id === activeId);
	let activeSpan;
	if (allPinned.length <= 3) {
		activeSpan = pos;
	} else {
		if (pos === 0) activeSpan = 0;
		else if (pos === allPinned.length - 1) activeSpan = 2;
		else activeSpan = 1;
	}

	for (let i = 0; i < total; i++) {
		const span = document.createElement('span');
		if (i === activeSpan) {
			span.style.height = '1.2rem';
			span.style.opacity = '1';
		} else {
			span.style.height = '0.6rem';
			span.style.opacity = '0.4';
		}
		_dom.pinnedMessageCount.appendChild(span);
	}
}

export async function scrollToPinnedMessage(messageId) {
	if (!messageId) return;
	if (!_dom || !_dom.chatEl) return;
	const mid = String(messageId);

	let el = _dom.chatEl.querySelector(
		`.chat-message[data-message-id="${mid}"]`,
	);
	if (el) {
		try {
			state.isProgrammaticScroll = true;
		} catch (e) {}
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		setTimeout(() => {
			try {
				state.isProgrammaticScroll = false;
			} catch (e) {}
		}, 800);
		return;
	}

	clearOpenSuppression(state.contactUserId);

	const MAX_PAGES = 10;
		for (let i = 0; i < MAX_PAGES; i++) {
			if (!canLoadOlder()) break;
			await loadOlderMessages({ skipSuppress: true });
		// loadOlderMessages در finally یه openSuppressedUntil جدید ست میکنه — clear کن
		clearOpenSuppression(state.contactUserId);
		await new Promise((r) => setTimeout(r, 150));
		el = _dom.chatEl.querySelector(
			`.chat-message[data-message-id="${mid}"]`,
		);
		if (el) {
			try {
				state.isProgrammaticScroll = true;
			} catch (e) {}
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			setTimeout(() => {
				try {
					state.isProgrammaticScroll = false;
				} catch (e) {}
			}, 800);
			return;
		}
	}

	try {
		showToast("Could not load this message");
	} catch (e) {}
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

function createUnreadSeparator() {
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
	// debug log removed
	const userMessages = messages[userId];
	if (!userMessages) {
		showEmptyState(_dom.chatEl, _dom.emptyStateEl);
		// debug log removed
		return;
	}

	_dom.chatEl.textContent = "";
	_dom.pinnedMessageContainer.style.display = "none";
	_dom.chatHeader.style.borderRadius = "1rem";
	state.pinnedIndexes = [];
	let lastDate = null;

	if (Array.isArray(userMessages) && userMessages.length === 0) {
		showEmptyState(_dom.chatEl, _dom.emptyStateEl);
		// debug log removed
		return;
	}
	hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
	// debug log removed

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
	// debug log removed
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
		// debug log removed
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
	// debug log removed

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
				// debug log removed
	} catch (e) {
		/* ignore */
	}
}

// Load older messages (page) and prepend to the current message list.
export async function loadOlderMessages({ skipSuppress = false } = {}) {
	const uid = state.contactUserId;
	if (!uid) return;
	const contact = contacts.find((c) => c.id === uid);
	if (!contact || !contact.conversationId) return;
	// debug log removed

	let meta = messagePaging[uid] || {
		hasMore: true,
		loading: false,
		pageSize: DEFAULT_PAGE_LIMIT,
		prefetched: null,
		prefetching: false,
	};
	// persist meta reference
	messagePaging[uid] = meta;
	// If this conversation was just opened, respect the per-conversation
	// suppression window so we don't auto-load older pages during initial
	// positioning/layout work.
	try {
		if (meta.openSuppressedUntil && Date.now() < meta.openSuppressedUntil) {
			// debug log removed
			return;
		}
	} catch (e) {}
	if (!meta.hasMore || meta.loading) return;
	meta.loading = true;

	try {
		const earliest =
			messages[uid] && messages[uid][0]
				? messages[uid][0].createdAt
				: null;
		if (!earliest) {
			meta.loading = false;
			return;
		}

		// Compute page limit and earliestId early so logs below are accurate
		const PAGE_LIMIT = Math.min(
			meta.pageSize || DEFAULT_PAGE_LIMIT,
			MAX_CLIENT_PAGE_LIMIT,
		);
		const earliestId =
			messages[uid] && messages[uid][0] ? messages[uid][0].id : null;

		// insert a small top skeleton so user sees loading in progress
		let topSkel = null;
		if (_dom.chatEl) {
			topSkel = createTopMessageSkeleton();
			_dom.chatEl.prepend(topSkel);
			_dom.chatEl.setAttribute("aria-busy", "true");
		}

		const oldScrollHeight = _dom.chatEl ? _dom.chatEl.scrollHeight : 0;
		const oldScrollTop = _dom.chatEl ? _dom.chatEl.scrollTop : 0;
		// debug log removed

		let more = null;
			// Use prefetched page if available
			if (meta.prefetched && Array.isArray(meta.prefetched)) {
				more = meta.prefetched;
				meta.prefetched = null;
				// debug log removed
			} else {
				// debug log removed
				more = await getMessagesPage(contact.conversationId, {
					limit: PAGE_LIMIT,
					before: earliest,
					beforeId: earliestId,
				});
				// debug log removed
			}

		if (!Array.isArray(more) || more.length === 0) {
			meta.hasMore = false;
			meta.loading = false;
			// cleanup skeleton
			if (topSkel && topSkel.parentNode) topSkel.remove();
			if (_dom.chatEl) _dom.chatEl.removeAttribute("aria-busy");
			return;
		}

		const normalized = more.map((m) => ({
			id: m.id,
			user: m.senderId === _currentUserId(),
			text: m.text,
			time: new Date(m.createdAt).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}),
			date: new Date(m.createdAt).toISOString().slice(0, 10),
			createdAt: m.createdAt,
			isEdited: m.isEdited,
			isPinned: m.isPinned,
			isSeen: m.isSeen,
				isOneTime: m.isOneTime || false,
				isTimeCapsule: m.isTimeCapsule || false,
				scheduledFor: m.scheduledFor || null,
				openedAt: m.openedAt || null,
				isLocked: m.isLocked || false,
			replyTo: m.replyToId
				? {
					id: m.replyToId,
					sender: m.replyToName,
					text: m.replyToText,
				}
				: null,
			forwardedFrom: m.forwardedFrom || null,
			forwardedText: m.forwardedText || null,
			reactions: m.reactions || [],
		}));

		// prepend into model
		const oldMsgs = messages[uid] || [];
		messages[uid] = [...normalized, ...oldMsgs];
		// debug log removed

		// enforce size cap
		if (
			Array.isArray(messages[uid]) &&
			messages[uid].length > MAX_MESSAGES_PER_CONVERSATION
		) {
			messages[uid] = messages[uid].slice(-MAX_MESSAGES_PER_CONVERSATION);
		}

		// update hasMore
		meta.hasMore = more.length === PAGE_LIMIT;

		// reindex model
		messages[uid].forEach((m, i) => (m.index = i));

		// -- DOM incremental prepend (do not re-render whole list) --
		if (_dom.chatEl) {
			try {
				const L = normalized.length;
				// shift existing DOM indices by L
				const existing = Array.from(_dom.chatEl.querySelectorAll(".chat-message"));
				existing.forEach((n) => {
					try {
						const oldIdx = Number(n.dataset.index);
						if (!Number.isNaN(oldIdx)) n.dataset.index = String(oldIdx + L);
					} catch (e) {}
				});

				// rebuild pinned indexes from model
				state.pinnedIndexes = [];
				messages[uid].forEach((m, i) => {
					if (m.isPinned) state.pinnedIndexes.push(i);
				});

				// Build fragment for the newly fetched older messages
				const frag = document.createDocumentFragment();
				let lastDate = null;
				normalized.forEach((message, _idx) => {
					// message.index should already be 0..L-1
					if (message.date && message.date !== lastDate) {
						frag.appendChild(createDateSeparator(message.date));
						lastDate = message.date;
					}
					// If unread separator belongs in this new range, insert it
					const firstUnseenIndex = Array.isArray(messages[uid])
						? messages[uid].findIndex((m) => m.isSeen !== true && !m.user)
						: -1;
					if (message.index === firstUnseenIndex && firstUnseenIndex !== -1) {
						frag.appendChild(createUnreadSeparator());
					}
					const node = createMessage(message);
					if (message.reactions && message.reactions.length > 0) {
						try {
							const _cu = getCurrentUser();
							applyReactionsToMessage(node, message.reactions, _cu?.id || null);
						} catch (e) {}
					}
					frag.appendChild(node);
				});

				// Remember original first node to detect duplicate separators
				const originalFirst = _dom.chatEl.firstElementChild;
				// Prepend fragment
				_dom.chatEl.prepend(frag);

				// If we introduced duplicate date separators at the boundary, remove one
				try {
					if (originalFirst) {
						const prev = originalFirst.previousElementSibling;
						if (prev && prev.classList && prev.classList.contains("date-separator") && originalFirst.classList && originalFirst.classList.contains("date-separator")) {
							originalFirst.parentNode.removeChild(originalFirst);
						}
					}
				} catch (e) {}

				// remove top skeleton if present
				if (topSkel && topSkel.parentNode) topSkel.remove();
				_dom.chatEl.removeAttribute("aria-busy");

				// restore scroll position to keep the viewport stable
				// Perform a programmatic scroll to preserve viewport. Mark state so
				// scroll handlers ignore this adjustment.
				try {
					state.isProgrammaticScroll = true;
				} catch (e) {}
				_dom.chatEl.scrollTop = _dom.chatEl.scrollHeight - oldScrollHeight + oldScrollTop;
				// debug log removed
				// Clear programmatic flag after next paint.
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						try { state.isProgrammaticScroll = false; } catch (e) {}
					});
				});

				// update pinned banner
				try {
					updatePinnedMessage();
				} catch (e) {}
			} catch (e) {
				console.error("loadOlderMessages DOM update failed", e);
				// Fallback: full re-render if incremental update fails
				injectMessages(uid);
				if (topSkel && topSkel.parentNode) topSkel.remove();
				_dom.chatEl.removeAttribute("aria-busy");
			}
		}
	} catch (e) {
		console.error("loadOlderMessages failed", e);
	} finally {
		if (messagePaging[uid]) {
			try { messagePaging[uid].loading = false; } catch (e) {}
			try {
				if (!skipSuppress) {
					messagePaging[uid].openSuppressedUntil = Date.now() + 3000;
				} else {
					// when called as part of an explicit navigation (e.g. scrollToPinnedMessage)
					// avoid setting the auto-load suppression window.
					messagePaging[uid].openSuppressedUntil = 0;
				}
			} catch (e) {}
		}
	}
}

// Clear per-conversation open suppression (used by `main.js` when the
// user performs an explicit interaction so older pages can be loaded).
export function clearOpenSuppression(uid) {
	try {
		if (!uid) uid = state.contactUserId;
		if (messagePaging && messagePaging[uid]) messagePaging[uid].openSuppressedUntil = 0;
	} catch (e) {}
}

// ─── Receive incoming message (from socket) ───────────────────────────────────
export async function receiveMessage(message) {
	try { console.log('[chat] receiveMessage START', { messageId: message.id, conversationId: message.conversationId, senderId: message.senderId }); } catch (e) {}
	let contact = contacts.find(
		(c) => c.conversationId === message.conversationId,
	);
	try { console.log('[chat] receiveMessage contact resolved', contact ? { id: contact.id, conversationId: contact.conversationId } : null); } catch (e) {}

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
					const resolvedName =
						raw.nickname || raw.contact?.name || "";
					const anonUsernameRaw = raw.contact?.username || "";
					const anonEmailRaw = raw.contact?.email || "";
					const isDeletedAccount =
						resolvedName &&
						String(resolvedName).toLowerCase() ===
							"deleted account";
					const isAnonPlaceholder =
						(anonUsernameRaw &&
							String(anonUsernameRaw).startsWith(
								"deleted_user_",
							)) ||
						(anonEmailRaw &&
							String(anonEmailRaw).endsWith("@deleted.rivo"));
					const newContact = {
						...raw,
						name: resolvedName,
						username:
							isDeletedAccount || isAnonPlaceholder
								? ""
								: anonUsernameRaw,
						profilePics: raw.contact?.profilePics || [],
						isOnline: raw.contact?.isOnline || false,
						lastSeen: raw.contact?.lastSeen || null,
						bio: raw.contact?.bio || "",
						email:
							isDeletedAccount || isAnonPlaceholder
								? ""
								: anonEmailRaw,
						lastMessage:
							raw.conversation?.messages?.[0]?.text || "",
						lastMessageTime: raw.conversation?.messages?.[0]
							? new Date(
									raw.conversation.messages[0].createdAt,
								).toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
									hour12: false,
								})
							: null,
						lastMessageDate: raw.conversation?.messages?.[0]
							? new Date(raw.conversation.messages[0].createdAt)
									.toISOString()
									.slice(0, 10)
							: null,
						unreadCount: raw.unreadCount ?? 0,
						lastMessageSeen: (() => {
							const lastMsg = raw.conversation?.messages?.[0];
							if (!lastMsg) return true;
							// Treat missing/undefined isSeen as seen. Only explicit false
							// means the last message is unseen.
							return lastMsg.isSeen !== false;
						})(),
					};

					// Avoid duplicates
					if (!contacts.find((c) => c.id === newContact.id)) {
						contacts.push(newContact);

						// append DOM card to the appropriate container (use injected DOM refs)
						const contactsContainer = _dom.contactsContainer;
						const activeChatsContainer = _dom.activeChatsContainer;
						if (contactsContainer && activeChatsContainer) {
							if (
								newContact.isPinned ||
								newContact.unreadCount > 0 ||
								newContact.lastMessageSeen === false
							) {
								activeChatsContainer.appendChild(
									createActiveChatCard(newContact),
								);
							} else {
								contactsContainer.appendChild(
									createContactCard(
										{
											...newContact,
											hasMessages:
												!!newContact.lastMessage,
										},
										_dom.onContactAction,
									),
								);
							}
							updateTotalUnreadCount();
							sortActiveChats();
							sortContacts();
							// Hide the "No contacts yet" placeholder immediately
							const emptyEl =
								document.getElementById("contacts-empty");
							if (emptyEl) emptyEl.style.display = "none";
						}
					}

					contact = contacts.find(
						(c) => c.conversationId === message.conversationId,
					);
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
		isOneTime: message.isOneTime || false,
		isTimeCapsule: message.isTimeCapsule || false,
		scheduledFor: message.scheduledFor || null,
		openedAt: message.openedAt || null,
		isLocked: message.isLocked || false,
		replyTo: message.replyToId
			? {
					id: message.replyToId,
					sender: message.replyToName,
					text: message.replyToText,
				}
			: null,
		forwardedFrom: message.forwardedFrom || null,
		forwardedText: message.forwardedText || null,
		reactions: message.reactions || [],
	};

	if (!messages[contact.id]) messages[contact.id] = [];
	messages[contact.id].push(normalized);
	// debug log removed

	// Do not trim messages immediately on receive to avoid jarring the user
	// (e.g., when they're reading older history). Trimming is performed
	// when loading older messages (see `loadOlderMessages`) so that
	// history-reading is not interrupted.

	// اگه همین چت بازه نشون بده
	if (state.contactUserId === contact.id) {
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
		normalized.index = messages[contact.id].length - 1;
		// If this incoming message falls on a different day than the previous
		// message, insert a date separator before appending it so the UI
		// updates live without requiring a refresh.
		const prevMsg = messages[contact.id][normalized.index - 1] || null;
		if (!prevMsg || prevMsg.date !== normalized.date) {
			_dom.chatEl.appendChild(createDateSeparator(normalized.date));
		}
		const newEl = createMessage(normalized);
		try {
			if (normalized.reactions && normalized.reactions.length > 0) {
				const _cu = getCurrentUser();
				applyReactionsToMessage(
					newEl,
					normalized.reactions,
					_cu?.id || null,
				);
			}
		} catch (e) {
			/* ignore */
		}
		// If the user is currently scrolled to the bottom, append and mark seen.
		// Otherwise, append but do not auto-scroll; show a "scroll to bottom"
		// affordance so the user can jump to the newest messages.
					try {
					const wasAtBottom = nearBottom(_dom.chatEl);
					_dom.chatEl.appendChild(newEl);
					// debug log removed
					if (wasAtBottom) {
					scrollChatToBottom();
					emitMessageSeen(contact.conversationId);
				} else {
					try {
						const btn = _dom.scrollToBottomBtn;
						if (btn) btn.classList.add('visible');
					} catch (e) {}
				}
		} catch (e) {
			// fallback: append + scroll
			_dom.chatEl.appendChild(newEl);
			scrollChatToBottom();
			emitMessageSeen(contact.conversationId);
		}
	}

	// کارت رو آپدیت کن
	// Use centralized preview helper so locked time-capsule content is never exposed
	contact.lastMessage = getContactPreviewText(normalized);
	contact.lastMessageTime = normalized.time;
	contact.lastMessageDate = normalized.date;
	// If the chat is currently open, consider the last message seen locally
	contact.lastMessageSeen = state.contactUserId === contact.id ? true : false;
	if (state.contactUserId !== contact.id) {
		contact.unreadCount = (contact.unreadCount || 0) + 1;
		try {
			if (!normalized.user && !contact.isSaved && !contact.isMuted) {
				// Deduplicate notifications by message id using main's queue if present
				const notifQueue =
					typeof window !== "undefined" && window._notifQueue
						? window._notifQueue
						: _localNotifQueue;
				if (normalized.id) {
					if (!notifQueue.has(normalized.id)) {
						notifQueue.add(normalized.id);
						setTimeout(
							() => notifQueue.delete(normalized.id),
							5000,
						);
						showNotification(contact, normalized);
					}
				} else {
					showNotification(contact, normalized);
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

		// Remove DOM nodes if still present (safety) and re-render open conversation
		try {
			if (_dom && _dom.chatEl) {
				messageIds.forEach((id) => {
					const el = _dom.chatEl.querySelector(
						`.chat-message[data-message-id="${id}"]`,
					);
					if (el && el.parentNode) el.parentNode.removeChild(el);
				});
			}
		} catch (e) {
			/* ignore DOM cleanup errors */
		}

		// If the currently open conversation was affected, re-render and update pinned
		try {
			if (
				state.contactUserId &&
				affectedUids.has(Number(state.contactUserId))
			) {
				// Update DOM indices incrementally instead of full re-render.
				try {
					const uid = Number(state.contactUserId);
					if (_dom && _dom.chatEl) {
						const nodes = Array.from(_dom.chatEl.querySelectorAll('.chat-message'));
						nodes.forEach((node) => {
							const mid = node.dataset?.messageId;
							if (!mid) return;
							const newIndex = (messages[uid] || []).findIndex((m) => String(m.id) === String(mid));
							if (newIndex === -1) {
								// message was removed; drop node if still present
								if (node.parentNode) node.parentNode.removeChild(node);
							} else {
								node.dataset.index = newIndex;
							}
						});
						// refresh pinned banner
						updatePinnedMessage();
					}
				} catch (e) {
					/* ignore */
				}
			}
		} catch (e) {
			/* ignore */
		}

		// Update contact previews (lastMessage, unreadCount) for affected conversations
		try {
			for (const uid of affectedUids) {
				const friend = contacts.find((c) => c.id === Number(uid));
				const arr = messages[uid] || [];
				if (friend) {
					if (arr.length > 0) {
						const lastMsg = arr[arr.length - 1];
						friend.lastMessage = getContactPreviewText(lastMsg);
						friend.lastMessageTime = lastMsg.time || "";
						friend.lastMessageDate = lastMsg.date || "";
						friend.lastMessageTs = lastMsg.createdAt || 0;
						friend.lastMessageSeen = lastMsg.user
							? lastMsg.isSeen !== false
							: true;
						try {
							friend.unreadCount = arr.filter(
								(m) => !m.user && m.isSeen !== true,
							).length;
						} catch (e) {
							/* ignore */
						}
					} else {
						friend.lastMessage = "";
						friend.lastMessageTime = "";
						friend.lastMessageDate = "";
						friend.lastMessageTs = 0;
						friend.lastMessageSeen = true;
						friend.unreadCount = 0;
					}
					try {
						refreshCard(friend);
					} catch (e) {
						/* ignore */
					}
				}
			}
			try {
				sortActiveChats();
			} catch (e) {
				/* ignore */
			}
			try {
				sortContacts();
			} catch (e) {
				/* ignore */
			}
			try {
				updateTotalUnreadCount();
			} catch (e) {
				/* ignore */
			}
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
				if (state.contactUserId) scrollChatToBottomAfterPadding();
			}
		} catch (e) {
			/* ignore */
		}
	}, 300);
}

// ─── Send message ─────────────────────────────────────────────────────────────
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

export function handleCapsuleOpened({ messageId, text, openedAt, conversationId }) {
	if (!messageId) return;

	// Update in-memory messages
	try {
						for (const [_uid, msgs] of Object.entries(messages)) {
			if (!Array.isArray(msgs)) continue;
			const idx = msgs.findIndex((m) => String(m.id) === String(messageId));
			if (idx !== -1) {
				msgs[idx].text = text;
				msgs[idx].openedAt = openedAt;
				msgs[idx].isLocked = false;
				msgs[idx].isTimeCapsule = true;
				break;
			}
		}
	} catch (e) {
		console.error('handleCapsuleOpened update model failed', e);
	}

	// Update DOM if present; otherwise queue the reveal for later injection
	if (!_dom || !_dom.chatEl) {
		try { _pendingCapsuleReveals.set(String(messageId), { text, openedAt, conversationId }); } catch (e) { /* ignore */ }
		return;
	}
	const msgEl = _dom.chatEl.querySelector(`.chat-message[data-message-id="${messageId}"]`);
	if (!msgEl) {
		try { _pendingCapsuleReveals.set(String(messageId), { text, openedAt, conversationId }); } catch (e) { /* ignore */ }
		return;
	}

	try {
		// Place the real text into the element (keep hidden until revealed)
		const textEl = msgEl.querySelector('.chat-message-text');
		if (textEl) textEl.textContent = text || '';

		// Update in-memory contact preview to a placeholder so lists don't show plaintext yet
		try {
			const contact = contacts.find(c => c.conversationId === conversationId);
			if (contact) {
				contact.lastMessage = 'Time capsule unlocked';
				refreshCard(contact);
				sortActiveChats();
			}
		} catch (e) { /* ignore */ }

		// Show an in-app notification and a native notification (if permitted)
		try {
			const contact = contacts.find(c => c.conversationId === conversationId);
			if (contact) {
				const notifMsg = { text: 'A time capsule was unlocked', id: messageId };
				try { showNotification(contact, notifMsg); } catch (e) { /* ignore */ }
				if (window.Notification && Notification.permission === 'granted') {
					try {
						const n = new Notification('Time capsule unlocked', {
							body: 'A time capsule in your chat has been unlocked. Click to view.',
							data: { conversationId, messageId },
						});
						n.onclick = function () {
							try {
								window.focus();
								document.dispatchEvent(new CustomEvent('in-app-notif:open', { detail: { contactId: contact.id, messageId } }));
								n.close();
							} catch (e) { /* ignore */ }
						};
					} catch (e) { /* ignore */ }
				}
			}
		} catch (e) { /* ignore */ }

		// Schedule unlock animation to run only when the message element becomes visible
		const runReveal = () => {
			try {
				msgEl.classList.add('capsule-unlocking');

				// Update sender label if present (use a simple text label here)
				const label = msgEl.querySelector('.capsule-sender-label');
				if (label) label.textContent = 'Time Capsule — Opened';

				try {
					unlockCapsule(msgEl);
				} catch (err) {
					// fallback: quickly reveal if helper missing
					const center = msgEl.querySelector('.capsule-center');
					const lines = msgEl.querySelector('.capsule-lines');
					if (center && center.parentNode) center.parentNode.removeChild(center);
					if (lines && lines.parentNode) lines.parentNode.removeChild(lines);
					msgEl.classList.remove('capsule-locked', 'capsule-unlocking');
					msgEl.classList.add('capsule-opened');
					if (textEl) textEl.classList.add('capsule-reveal');
				}

				// Ensure classes reflect final state after animation
				setTimeout(() => {
					msgEl.classList.remove('capsule-unlocking');
					msgEl.classList.add('capsule-opened');

					// mark in-memory message as unlocked and update contact preview to real text
					try {
						for (const [_uid, msgs] of Object.entries(messages)) {
							if (!Array.isArray(msgs)) continue;
							const idx = msgs.findIndex((m) => String(m.id) === String(messageId));
							if (idx !== -1) {
								msgs[idx].isLocked = false;
								msgs[idx].openedAt = openedAt;
								break;
							}
						}
						const contact = contacts.find(c => c.conversationId === conversationId);
						if (contact) {
							contact.lastMessage = text || '';
							refreshCard(contact);
							sortActiveChats();
						}
					} catch (e) { /* ignore */ }

					// Persist that we've shown the reveal animation for this message
					try { _markCapsuleRevealed(String(messageId)); } catch (e) { /* ignore */ }
				}, 950);
			} catch (e) {
				console.error('reveal failed', e);
			}
		};

		// helper: check visibility
		const isVisible = (el) => {
			try {
				const rect = el.getBoundingClientRect();
				return rect.top >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight);
			} catch (e) { return false; }
		};

		if (isVisible(msgEl)) {
			setTimeout(runReveal, 1000);
		} else {
			const obs = new IntersectionObserver((entries) => {
				for (const ent of entries) {
					if (ent.isIntersecting) {
						setTimeout(() => {
							try { runReveal(); } catch (e) { /* ignore */ }
						}, 1000);
						try { obs.disconnect(); } catch (e) { /* ignore */ }
						break;
					}
				}
			}, { threshold: 0.2 });
			try { obs.observe(msgEl); } catch (e) { setTimeout(runReveal, 1000); }
		}
	} catch (e) {
		console.error('handleCapsuleOpened DOM update failed', e);
	}
}

// Dev helper: manually trigger capsule-open flow from the browser console.
// Usage: window.__rivo_test_unlockCapsule(messageId, "optional revealed text")
try {
	if (typeof window !== 'undefined') {
		window.__rivo_test_unlockCapsule = (messageId, text = 'Test unlock') => {
			try {
				handleCapsuleOpened({ messageId, text, openedAt: new Date().toISOString() });
			} catch (e) { console.error('test unlock failed', e); }
		};
	}
} catch (e) { /* ignore */ }

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
		isOneTime: m.isOneTime || false,
		isTimeCapsule: m.isTimeCapsule || false,
		scheduledFor: m.scheduledFor || null,
		openedAt: m.openedAt || null,
		isLocked: false,
	};
}

// Pending message helpers
function _closeFailedPanel() {
	const root = _dom && _dom.chatEl ? _dom.chatEl : document;
	const existing = root.querySelector(".msg-failed-panel");
	if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
	try {
		document.removeEventListener("click", _closeFailedPanel);
	} catch (e) {
		/* ignore */
	}
}

function _openFailedPanel(msgEl, pendingId) {
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

function _toggleFailedPanel(msgEl, pendingId) {
	const existing = msgEl.querySelector(".msg-failed-panel");
	if (existing) {
		_closeFailedPanel();
	} else {
		_openFailedPanel(msgEl, pendingId);
	}
}

function _retryPending(pendingId) {
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

function _markPendingFailed(pendingId) {
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

async function _confirmPending(pendingId, sent) {
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
function _sendOutgoingMessage(
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

// ─── Update Contact Card ────────────────────────────────────────────────────────
function _updateContactCard() {
	const userMsgs = messages[state.contactUserId];
	const lastMsg = userMsgs?.at(-1);
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (friend && lastMsg) {
		friend.lastMessage = getContactPreviewText(lastMsg);
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
		if (
			!contact.isPinned &&
			!contact.isSaved &&
			contact.unreadCount === 0
		) {
			moveToContacts(contact);
			sortContacts();
		}
	}
}
