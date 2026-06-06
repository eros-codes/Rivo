import { contacts } from "./state.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../../components/active-chats/active-chats.js";

let _dom = {};
let _onContactAction = null;

/**

- @param {{ activeChatsContainer, contactsContainer, unreadMessageCount }} dom
  */
export function initChatLogic(dom) {
	_dom = dom;
	_onContactAction = dom.onContactAction;
}

// ─── Unread count ─────────────────────────────────────────────────────────────
export function updateTotalUnreadCount() {
	const total = contacts.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
	_dom.unreadMessageCount.textContent = String(total);
	_dom.unreadMessageCount.style.opacity = total === 0 ? "0" : "1";
}

// ─── Card movement ────────────────────────────────────────────────────────────
/** Move a contact’s card from active-chats to contacts list. */
export function moveToContacts(friend) {
	const activeCard = _dom.activeChatsContainer.querySelector(
		`[data-user-id="${friend.id}"]`,
	);
	const wrapper = activeCard?.closest(".active-chat-wrapper") ?? activeCard;
	if (wrapper) {
		// record that this friend was in active chats before moving
		friend._previousContainer = "active";
		wrapper.remove();
		_dom.contactsContainer.appendChild(
			createContactCard(
				{ ...friend, hasMessages: !!friend.lastMessage },
				_onContactAction,
			),
		);
	}
}

/** Move a contact’s card from contacts list to active-chats. */
export function moveToActiveChats(friend) {
	const contactCard = _dom.contactsContainer.querySelector(
		`[data-user-id="${friend.id}"]`,
	);
	if (contactCard) {
		// record that this friend was in contacts before moving
		friend._previousContainer = "contacts";
		contactCard.remove();
		_dom.activeChatsContainer.appendChild(createActiveChatCard(friend));
	} else {
		refreshCard(friend);
	}
}

/** Replace whichever card exists with a freshly built one (e.g. after nickname change). */
export function refreshCard(friend) {
	const activeCard = _dom.activeChatsContainer.querySelector(
		`[data-user-id="${friend.id}"]`,
	);
	const wrapper = activeCard?.closest(".active-chat-wrapper") ?? activeCard;
	if (wrapper) wrapper.replaceWith(createActiveChatCard(friend));

	const contactCard = _dom.contactsContainer.querySelector(
		`[data-user-id="${friend.id}"]`,
	);
	if (contactCard)
		contactCard.replaceWith(
			createContactCard(
				{ ...friend, hasMessages: !!friend.lastMessage },
				_onContactAction,
			),
		);
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
		return (b.friend.lastMessageTs || 0) - (a.friend.lastMessageTs || 0);
	});

	unpinned.sort((a, b) => {
		const cmp =
			(b.friend.lastMessageTs || 0) - (a.friend.lastMessageTs || 0);
		if (cmp !== 0) return cmp;
		const na = (a.friend.nickname || a.friend.name || "").toLowerCase();
		const nb = (b.friend.nickname || b.friend.name || "").toLowerCase();
		return na.localeCompare(nb);
	});

	[...saved, ...pinned, ...unpinned].forEach(({ el }) =>
		_dom.activeChatsContainer.appendChild(el),
	);
}

export function sortContacts() {
	const withMsg = [];
	const withoutMsg = [];
	const blocked = [];

	_dom.contactsContainer
		.querySelectorAll(".contacts-card")
		.forEach((card) => {
			const friend = contacts.find(
				(c) => c.id === Number(card.dataset.userId),
			);
			if (!friend) return;
			if (friend.isBlocked) blocked.push({ card, friend });
			else if (friend.lastMessage) withMsg.push({ card, friend });
			else withoutMsg.push({ card, friend });
		});

	withMsg.sort((a, b) => {
		const cmp =
			(b.friend.lastMessageTs || 0) - (a.friend.lastMessageTs || 0);
		if (cmp !== 0) return cmp;
		const na = (a.friend.nickname || a.friend.name || "").toLowerCase();
		const nb = (b.friend.nickname || b.friend.name || "").toLowerCase();
		return na.localeCompare(nb);
	});

	[...withMsg, ...withoutMsg, ...blocked].forEach(({ card }) =>
		_dom.contactsContainer.appendChild(card),
	);
}