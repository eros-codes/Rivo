import { applyReactionsToMessage, createMessage } from "../../../components/messages/messages.js";
import { getMessagesPage } from "./api.js";
import { updatePinnedMessage } from "./chat-pinned.js";
import { createDateSeparator, createUnreadSeparator, injectMessages, messageForDisplay } from "./chat-render.js";
import { DEFAULT_PAGE_LIMIT, MAX_CLIENT_PAGE_LIMIT, _dom, _unreadSeparatorContactId, _unreadSeparatorIndex, messagePaging, normalizeServerMessage, setUnreadSeparatorIndex } from "./chat-state.js";
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

		// The user switched to another chat while this page was loading
		if (state.contactUserId !== uid) {
			if (topSkel && topSkel.parentNode) topSkel.remove();
			if (_dom.chatEl) _dom.chatEl.removeAttribute("aria-busy");
			return;
		}

		// skip anything already loaded (e.g. a message that arrived meanwhile)
		const oldMsgs = messages[uid] || [];
		const knownIds = new Set(oldMsgs.map((m) => String(m.id)));
		const normalized = more.filter((m) => !knownIds.has(String(m.id))).map(normalizeServerMessage);

		// update hasMore
		meta.hasMore = more.length === PAGE_LIMIT;
		if (normalized.length === 0) {
			if (topSkel && topSkel.parentNode) topSkel.remove();
			if (_dom.chatEl) _dom.chatEl.removeAttribute("aria-busy");
			return;
		}

		// prepend into model (history the user asked for is never trimmed: that
		// used to drop exactly the page that was just loaded)
		messages[uid] = [...normalized, ...oldMsgs];

		// the unread separator position is an index into this array
		if (_unreadSeparatorContactId === uid && _unreadSeparatorIndex !== -1) {
			setUnreadSeparatorIndex(_unreadSeparatorIndex + normalized.length);
		}

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
				// at most one "Unread messages" line, and only if the open chat
				// does not show one already
				const hasUnreadLine = !!_dom.chatEl.querySelector(".unread-separator");
				const firstUnseenIndex = messages[uid].findIndex((m) => m.isSeen !== true && !m.user);
				normalized.forEach((message) => {
					// message.index should already be 0..L-1
					if (message.date && message.date !== lastDate) {
						frag.appendChild(createDateSeparator(message.date));
						lastDate = message.date;
					}
					if (!hasUnreadLine && message.index === firstUnseenIndex && firstUnseenIndex !== -1) {
						frag.appendChild(createUnreadSeparator());
					}
					const node = createMessage(messageForDisplay(message, uid));
					if (message.reactions && message.reactions.length > 0) {
						try {
							const _cu = getCurrentUser();
							applyReactionsToMessage(node, message.reactions, _cu?.id || null);
						} catch (e) {}
					}
					frag.appendChild(node);
				});

				// remove the loading skeleton first, so the old content's first
				// element (its date line) can be compared with the new page
				if (topSkel && topSkel.parentNode) topSkel.remove();
				const originalFirst = _dom.chatEl.firstElementChild;
				_dom.chatEl.prepend(frag);

				// The old first day line repeats the new page's last day: keep one
				try {
					if (
						originalFirst &&
						originalFirst.classList.contains("date-separator") &&
						originalFirst.dataset.date &&
						originalFirst.dataset.date === lastDate
					) {
						originalFirst.remove();
					}
				} catch (e) {}

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
