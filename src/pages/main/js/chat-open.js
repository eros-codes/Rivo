import { getMessagesPage, getPinnedMessages } from "./api.js";
import { refreshCard, updateTotalUnreadCount } from "./chat-logic.js";
import { loadOlderMessages } from "./chat-paging.js";
import { injectMessages } from "./chat-render.js";
import { DEFAULT_PAGE_LIMIT, _currentUserId, _dom, _pendingCapsuleReveals, _seenApplyTimeoutId, _seenTimeoutId, _unreadSeparatorContactId, _unreadSeparatorIndex, basePadding, messagePaging, pendingMessages, pinnedData, setSeenApplyTimeoutId, setSeenTimeoutId, setSuppressInjectScroll, setUnreadSeparatorContactId, setUnreadSeparatorIndex } from "./chat-state.js";
import { makeMessageSkeleton } from "./skeleton.js";
import { emitMessageSeen, getSocket } from "./socket.js";
import { contacts, messages, state } from "./state.js";

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
		}

		try {
			const PAGE_LIMIT = DEFAULT_PAGE_LIMIT;
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
		} catch (err) {
			console.error("getMessagesPage failed", err);
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
		}
	} catch (e) {}

	// ثبت موقعیت separator قبل از اینکه isSeen تغییر کنه
	if (_unreadSeparatorContactId !== state.contactUserId) {
		const _loadedMsgs = messages[state.contactUserId] || [];
		setUnreadSeparatorContactId(state.contactUserId);
		setUnreadSeparatorIndex(_loadedMsgs.findIndex((m) => m.isSeen !== true && !m.user));
		if (_unreadSeparatorIndex === -1) {
			const _uc = contacts.find((c) => c.id === state.contactUserId);
			const _unread = _uc ? _uc.unreadCount || 0 : 0;
			if (_unread > 0) {
				let _cnt = 0;
				for (let i = _loadedMsgs.length - 1; i >= 0; i--) {
					if (!_loadedMsgs[i].user) {
						_cnt++;
						if (_cnt === _unread) {
							setUnreadSeparatorIndex(i);
							break;
						}
					}
				}
			}
		}
	}
	setSuppressInjectScroll(true);
	// Prevent the global scroll handler from triggering pagination while
	// we are doing the initial render and positioning.
	try {
		state.suppressScrollLoad = true;
	} catch (e) {}
	injectMessages(state.contactUserId);
	setSuppressInjectScroll(false);

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
		setSeenTimeoutId(setTimeout(() => {
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
						setUnreadSeparatorContactId(null);
						setUnreadSeparatorIndex(-1);
					} catch (e) {
						/* ignore */
					}
				})
				.catch(() => {})
				.finally(() => {
					try {
						setSeenTimeoutId(null);
					} catch (e) {
						/* ignore */
					}
				});
		}, 700));
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
			setSeenTimeoutId(null);
		}
	} catch (e) {
		/* ignore */
	}
	try {
		if (_seenApplyTimeoutId) {
			clearTimeout(_seenApplyTimeoutId);
			setSeenApplyTimeoutId(null);
		}
	} catch (e) {
		/* ignore */
	}
	setUnreadSeparatorContactId(null);
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

	setUnreadSeparatorIndex(-1);
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
