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
	const total = contacts.reduce((sum, c) => sum + c.unreadCount, 0);
	_dom.unreadMessageCount.textContent = total;
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
	if (contactCard) contactCard.replaceWith(
		createContactCard(
			{ ...friend, hasMessages: !!friend.lastMessage },
			_onContactAction,
		),
	);
}

/** Sorting the cards in the way that should be **/
export function sortActiveChats() {
	const pinned = [];
	const unpinned = [];

	_dom.activeChatsContainer
		.querySelectorAll(".active-chat-wrapper")
		.forEach((el) => {
			const card = el.classList.contains("active-chat-wrapper")
				? el.querySelector(".active-chat")
				: el;
			if (!card) return;
			const friend = contacts.find(
				(c) => c.id === Number(card.dataset.userId),
			);
			if (!friend) return;
			friend.isPinned
				? pinned.push({ el, friend })
				: unpinned.push({ el, friend });
		});

	// Pin order
	pinned.sort((a, b) => (b.friend.pinOrder ?? 0) - (a.friend.pinOrder ?? 0));

	// Sortfrom last message
	unpinned.sort((a, b) => {
		const ta = (a.friend.lastMessageDate || "") + (a.friend.lastMessageTime || "");
		const tb = (b.friend.lastMessageDate || "") + (b.friend.lastMessageTime || "");
		return tb.localeCompare(ta);
	});

	[...pinned, ...unpinned].forEach(({ el }) =>
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
			
			if (friend.isBlocked) {
				blocked.push({ card, friend })
			} else if (friend.lastMessage) {
				withMsg.push({ card, friend })
			} else {
				withoutMsg.push({ card, friend })
			}
		});

	withMsg.sort((a, b) =>
		((b.friend.lastMessageDate || "") + (b.friend.lastMessageTime || "")).localeCompare(
			(a.friend.lastMessageDate || "") + (a.friend.lastMessageTime || ""),
		),
	);

	[...withMsg, ...withoutMsg, ...blocked].forEach(({ card }) =>
		_dom.contactsContainer.appendChild(card),
	);
}