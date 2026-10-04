import { contacts } from "./state.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../../components/active-chats/active-chats.js";
import { CONTACTS_PREVIEW_COUNT, setAllContacts } from "./all-contacts.js";

let _dom = {};
let _onContactAction = null;
let _observer = null;
let _syncQueued = false;

/**

- @param {{ activeChatsContainer, contactsContainer, unreadMessageCount }} dom
  */
export function initChatLogic(dom) {
	_dom = dom;
	_onContactAction = dom.onContactAction;
	_observeContainers();
}

// ─── Unread count ─────────────────────────────────────────────────────────────
export function updateTotalUnreadCount() {
	const total = contacts.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
	_dom.unreadMessageCount.textContent = String(total);
	_dom.unreadMessageCount.style.opacity = total === 0 ? "0" : "1";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Time of the contact's latest message in ms (0 when unknown).
 * `lastMessageTs` is a number in most places but some code paths store the
 * raw ISO `createdAt` string; subtracting strings gives NaN and breaks sort().
 */
function _ts(friend) {
	const v = friend?.lastMessageTs;
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (v) {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : 0;
	}
	return 0;
}

function _activeWrapper(id) {
	const card = _dom.activeChatsContainer?.querySelector(
		`[data-user-id="${id}"]`,
	);
	return card ? (card.closest(".active-chat-wrapper") ?? card) : null;
}

function _byRecentMessage(a, b) {
	const cmp = _ts(b) - _ts(a);
	if (cmp !== 0) return cmp;
	return (b.id || 0) - (a.id || 0);
}

// Contacts without messages: newest added first (stable between reloads)
function _byNewestContact(a, b) {
	return (b.id || 0) - (a.id || 0);
}

function _byBlockedOrder(a, b) {
	const am = a.lastMessage ? 1 : 0;
	const bm = b.lastMessage ? 1 : 0;
	if (am !== bm) return bm - am;
	return am ? _byRecentMessage(a, b) : _byNewestContact(a, b);
}

// ─── Card movement ────────────────────────────────────────────────────────────
/** Move a contact’s card from active-chats to contacts list. */
export function moveToContacts(friend) {
	if (!friend) return;
	const wrapper = _activeWrapper(friend.id);
	if (wrapper) {
		// record that this friend was in active chats before moving
		friend._previousContainer = "active";
		wrapper.remove();
	}
	// The contacts section is rendered from data, so this places the card in
	// the right spot (or behind "Show more" when it is not in the top 8).
	syncContactsView();
}

/** Move a contact’s card from contacts list to active-chats. */
export function moveToActiveChats(friend) {
	if (!friend) return;
	if (friend.isArchived || friend.isSaved || _activeWrapper(friend.id)) {
		refreshCard(friend);
		return;
	}
	// record that this friend was in contacts before moving. The contact may
	// not have a card on the page (it can sit behind "Show more"), so the
	// active card is created either way.
	friend._previousContainer = "contacts";
	_dom.contactsContainer
		?.querySelectorAll(`.contacts-card[data-user-id="${friend.id}"]`)
		.forEach((el) => el.remove());
	_dom.activeChatsContainer.appendChild(createActiveChatCard(friend));
	syncContactsView();
}

/** Replace whichever card exists with a freshly built one (e.g. after nickname change). */
export function refreshCard(friend) {
	if (!friend) return;
	const wrapper = _activeWrapper(friend.id);
	if (wrapper) wrapper.replaceWith(createActiveChatCard(friend));

	const contactCard = _dom.contactsContainer?.querySelector(
		`[data-user-id="${friend.id}"]`,
	);
	if (contactCard)
		contactCard.replaceWith(
			createContactCard(
				{ ...friend, hasMessages: !!friend.lastMessage },
				_onContactAction,
			),
		);
	// keep the order and the "All contacts" page in step with the new data
	_queueSync();
}

/** Sorting the cards in the way that should be **/
export function sortActiveChats() {
	const pinned = [];
	const saved = [];
	const unpinned = [];

	_dom.activeChatsContainer
		.querySelectorAll(".active-chat-wrapper")
		.forEach((el) => {
			const card = el.querySelector(".active-chat");
			if (!card) return;
			const friend = contacts.find(
				(c) => c.id === Number(card.dataset.userId),
			);
			if (!friend) return;
			if (friend.isSaved) saved.push({ el, friend });
			else if (friend.isPinned) pinned.push({ el, friend });
			else unpinned.push({ el, friend });
		});

	pinned.sort((a, b) => {
		const pa = a.friend.pinOrder ?? Number.MAX_SAFE_INTEGER;
		const pb = b.friend.pinOrder ?? Number.MAX_SAFE_INTEGER;
		if (pa !== pb) return pa - pb;
		return _ts(b.friend) - _ts(a.friend);
	});

	unpinned.sort((a, b) => {
		const cmp = _ts(b.friend) - _ts(a.friend);
		if (cmp !== 0) return cmp;
		const na = (a.friend.nickname || a.friend.name || "").toLowerCase();
		const nb = (b.friend.nickname || b.friend.name || "").toLowerCase();
		return na.localeCompare(nb);
	});

	[...saved, ...pinned, ...unpinned].forEach(({ el }) =>
		_dom.activeChatsContainer.appendChild(el),
	);
}

/**
 * Re-render the contacts section from data. Kept under its old name because
 * many modules call it after changing a contact.
 */
export function sortContacts() {
	syncContactsView();
}

/**
 * Single source of truth for the "Contacts" section:
 *  1. contacts with messages, most recent first
 *  2. contacts without messages
 *  3. blocked contacts
 * Only the first CONTACTS_PREVIEW_COUNT are rendered on the main page; the
 * complete, identically ordered list goes to the "All contacts" page.
 * A contact belongs here when it is not saved, not archived and has no card
 * in Active Chats.
 */
export function syncContactsView() {
	const container = _dom.contactsContainer;
	if (!container) return;

	const activeIds = new Set();
	_dom.activeChatsContainer
		?.querySelectorAll(".active-chat[data-user-id]")
		.forEach((el) => activeIds.add(Number(el.dataset.userId)));

	const withMsg = [];
	const withoutMsg = [];
	const blocked = [];
	for (const c of contacts) {
		if (!c || c.isSaved || c.isArchived || activeIds.has(c.id)) continue;
		if (c.isBlocked) blocked.push(c);
		else if (c.lastMessage) withMsg.push(c);
		else withoutMsg.push(c);
	}
	withMsg.sort(_byRecentMessage);
	withoutMsg.sort(_byNewestContact);
	blocked.sort(_byBlockedOrder);
	const ordered = [...withMsg, ...withoutMsg, ...blocked];

	const preview = ordered.slice(0, CONTACTS_PREVIEW_COUNT);
	const previewIds = new Set(preview.map((c) => c.id));

	// Loading skeletons look like cards but belong to the start-up code,
	// which removes them itself once the contacts have arrived.
	const CARD = ":scope > .contacts-card:not(.skeleton-placeholder)";

	// Reuse cards that are already on the page: other modules keep references
	// to them or animate them (e.g. delete fade-outs).
	const existing = new Map();
	container.querySelectorAll(CARD).forEach((card) => {
		const id = Number(card.dataset.userId);
		if (!previewIds.has(id) || existing.has(id)) card.remove();
		else existing.set(id, card);
	});

	const cards = preview.map(
		(c) =>
			existing.get(c.id) ||
			createContactCard(
				{ ...c, hasMessages: !!c.lastMessage },
				_onContactAction,
			),
	);

	// "Show more" must always come after the cards
	const fade = container.querySelector(":scope > .contacts-fade");
	if (fade && container.lastElementChild !== fade) container.appendChild(fade);

	const current = Array.from(container.querySelectorAll(CARD));
	const inOrder =
		current.length === cards.length &&
		current.every((el, i) => el === cards[i]);
	if (!inOrder) {
		cards.forEach((el) => container.insertBefore(el, fade || null));
	}

	setAllContacts(ordered);

	// our own DOM changes must not trigger another sync
	_observer?.takeRecords();
}

function _queueSync() {
	if (_syncQueued) return;
	_syncQueued = true;
	queueMicrotask(() => {
		_syncQueued = false;
		syncContactsView();
	});
}

// Several flows add or remove cards directly (archive, delete contact, add
// contact, socket events). Watching both containers keeps the section
// correct no matter which path changed the page.
function _observeContainers() {
	if (_observer || typeof MutationObserver === "undefined") return;
	_observer = new MutationObserver(() => _queueSync());
	[_dom.activeChatsContainer, _dom.contactsContainer].forEach((el) => {
		if (el) _observer.observe(el, { childList: true });
	});
}