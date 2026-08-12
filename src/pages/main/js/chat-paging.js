import { applyReactionsToMessage, createMessage } from "../../../components/messages/messages.js";
import { getMessagesPage } from "./api.js";
import { scrollToPinnedMessage, updatePinnedMessage } from "./chat-pinned.js";
import { createDateSeparator, createUnreadSeparator, injectMessages } from "./chat-render.js";
import { DEFAULT_PAGE_LIMIT, MAX_CLIENT_PAGE_LIMIT, MAX_MESSAGES_PER_CONVERSATION, _currentUserId, _dom, messagePaging } from "./chat-state.js";
import { getCurrentUser } from "./currentUser.js";
import { createTopMessageSkeleton } from "./skeleton.js";
import { contacts, messages, state } from "./state.js";

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



export async function loadOlderMessages({ skipSuppress = false } = {}) {
	const uid = state.contactUserId;
	if (!uid) return;
	const contact = contacts.find((c) => c.id === uid);
	if (!contact || !contact.conversationId) return;

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

		let more = null;
			// Use prefetched page if available
			if (meta.prefetched && Array.isArray(meta.prefetched)) {
				more = meta.prefetched;
				meta.prefetched = null;
			} else {
				more = await getMessagesPage(contact.conversationId, {
					limit: PAGE_LIMIT,
					before: earliest,
					beforeId: earliestId,
				});
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
