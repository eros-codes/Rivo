import { state, contacts, messages } from "./state.js";
import { showToast } from "./ui.js";
import { closeChat } from "./chat.js";
import {
	updateTotalUnreadCount,
	refreshCard,
	sortContacts,
	sortActiveChats,
} from "./chat-logic.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../../components/active-chats/active-chats.js";
import { updateContact, deleteContact as apiDeleteContact, deleteChat as apiDeleteChat, searchUsers } from "./api.js";
import { safeSrc } from "../../../utils/dom.js";

let _dom = {};

/**

- @param {{
- contactProfileDetails, profileDialog, chatPart, peoplePart,
- detailPictures, detailNames, detailBios, detailLastSeens,
- detailUsernames, detailEmails,
- editNameDoneBtn, cancelEditNameBtn,
- chatEl, chatName, chatProfilePic,
- activeChatsContainer, contactsContainer,
- deleteIcon
- }} dom
  */
export function initProfile(dom) {
	_dom = dom;
}

// last seen format
function formatLastSeen(isoString) {
	const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
	if (diff < 172800) return "yesterday";
	if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
	if (diff < 1209600) return "last week";
	if (diff < 2592000) return `${Math.floor(diff / 604800)} weeks ago`;
	if (diff < 5184000) return "last month";
	return `${Math.floor(diff / 2592000)} months ago`;
}

// ─── Open profile ─────────────────────────────────────────────────────────────
export function openProfile(friend) {
	_dom.detailPictures.forEach(
		(el) =>
			(el.src =
				friend.profilePics[0] ||
				"/assets/images/profile.jpeg"),
	);
	_dom.detailNames.forEach(
		(el) => (el.textContent = friend.nickname || friend.name),
	);
	_dom.detailBios.forEach((el) => (el.textContent = friend.bio || ""));
	_dom.detailLastSeens.forEach(
		(el) =>
			(el.textContent = friend.isOnline
				? "Online"
				: friend.lastSeen
					? `Last seen ${formatLastSeen(friend.lastSeen)}`
					: ""),
	);
	_dom.detailUsernames.forEach(
		(el) => (el.textContent = "@" + friend.username),
	);
	_dom.detailEmails.forEach((el) => (el.textContent = friend.email || ""));

	// If bio is missing, try to resolve via username lookup
	if ((!friend.bio || friend.bio === "") && friend.username) {
		try {
			const users = await searchUsers(friend.username);
			if (Array.isArray(users) && users.length > 0) {
				const found = users.find((u) => String(u.username).toLowerCase() === String(friend.username).toLowerCase());
				if (found) {
					friend.bio = found.bio || "";
					_dom.detailBios.forEach((el) => (el.textContent = friend.bio || ""));
					// also refresh picture/name if they were missing
					if ((!friend.profilePics || friend.profilePics.length === 0) && found.profilePics) {
						friend.profilePics = found.profilePics;
						_dom.detailPictures.forEach((el) => (el.src = safeSrc(friend.profilePics[0] || "/assets/images/profile.jpeg")));
					}
					if (!friend.name && found.name) {
						friend.name = found.name;
						_dom.detailNames.forEach((el) => (el.textContent = friend.nickname || friend.name));
					}
				}
			}
		} catch (e) {
			/* ignore lookup errors */
		}
	}

	_dom.detailUsernames.forEach((el) => {
		el.classList.add('cursor-pointer');
		const _handler = () => {
			navigator.clipboard.writeText(`@${friend.username}`);
			const prev = el.textContent;
			el.textContent = "Copied!";
			setTimeout(() => {
				el.textContent = prev || "@" + friend.username;
			}, 1500);
		};
		if (el._rivoClickInstalled) el.removeEventListener("click", el._rivoClickInstalled);
		el._rivoClickInstalled = _handler;
		el.addEventListener("click", _handler);
	});

	_dom.detailEmails.forEach((el) => {
		if (!friend.email) return;
		el.classList.add('cursor-pointer');
		const _handlerEmail = () => {
			navigator.clipboard.writeText(friend.email);
			const prev = el.textContent;
			el.textContent = "Copied!";
			setTimeout(() => {
				el.textContent = prev || friend.email;
			}, 1500);
		};
		if (el._rivoEmailClickInstalled) el.removeEventListener("click", el._rivoEmailClickInstalled);
		el._rivoEmailClickInstalled = _handlerEmail;
		el.addEventListener("click", _handlerEmail);
	});

	if (window.innerWidth > 700) {
		if (_dom.profileDialog) {
			_dom.profileDialog.appendChild(_dom.contactProfileDetails);
			_dom.profileDialog.showModal();
		}
	} else {
		_dom.contactProfileDetails.classList.remove('d-none');
		_dom.contactProfileDetails.classList.add('d-flex');
		_dom.contactProfileDetails.classList.remove("slide-out");
		_dom.contactProfileDetails.classList.add("slide-in");
		_dom.contactProfileDetails.addEventListener(
			"animationend",
			() => {
				_dom.contactProfileDetails.classList.remove("slide-in");
			},
			{ once: true },
		);
	}

	document
		.querySelectorAll("#block-contact-btn")
		.forEach(
			(btn) =>
				(btn.textContent = friend.isBlocked
					? "Unblock contact"
					: "Block contact"),
		);

	state.isProfileDialogOpen = true;
}

// ─── Close profile ────────────────────────────────────────────────────────────
export function closeProfile() {
	// Reset any open nickname edit
	_dom.detailNames.forEach((el) => {
		el.setAttribute("contenteditable", "false");
		el.classList.add('no-border');
	});
	const editNameDoneBtn0 = _dom.editNameDoneBtn?.[0];
	if (editNameDoneBtn0) editNameDoneBtn0.classList.add('d-none');
	const cancelEditNameBtn0 = _dom.cancelEditNameBtn?.[0];
	if (cancelEditNameBtn0) cancelEditNameBtn0.classList.add('d-none');
	if (state.contactUserId !== null && window.innerWidth >= 700) {
		_dom.profileDialog.close();
		_dom.profileDialog.textContent = "";
	} else {		
		_dom.contactProfileDetails.classList.remove("slide-in");
		_dom.contactProfileDetails.classList.add("slide-out");
		_dom.contactProfileDetails.addEventListener(
			"animationend",
			() => {
				_dom.contactProfileDetails.classList.remove("slide-out");
				_dom.contactProfileDetails.classList.add('d-none');
				if (!state.skipShowChatOnProfileClose) {
					_dom.chatPart.classList.remove('d-none');
					_dom.chatPart.classList.add('d-flex');
				} else {
					state.skipShowChatOnProfileClose = false;
				}
			},
			{ once: true },
		);
	}
	state.isProfileDialogOpen = false;
}

// ─── Delete chat ──────────────────────────────────────────────────────────────
export function handleDeleteChat() {
	const contact = contacts.find((c) => c.id === state.contactUserId);
	const deletingContactId = state.contactUserId;
	if (!contact) return;
	// Close profile view (desktop dialog or mobile panel)
	// Prevent profile.closeProfile() from forcing the chat panel visible again on mobile
	state.skipShowChatOnProfileClose = true;
	closeProfile();

	_dom.chatEl.textContent = "";
	closeChat();

		// Immediately clear in-memory messages for this conversation so UI won't show stale messages
		try {
			messages[deletingContactId] = [];
		} catch (e) { /* ignore */ }

	// Fade any matching cards in both lists (active and contacts)
	const fadedNodes = [];
	try {
		const selector = `[data-user-id="${deletingContactId}"], [data-wrapper-user-id="${deletingContactId}"]`;
		let matches = [];
		if (_dom.activeChatsContainer)
			matches.push(..._dom.activeChatsContainer.querySelectorAll(selector));
		if (_dom.contactsContainer)
			matches.push(..._dom.contactsContainer.querySelectorAll(selector));
		// fallback to document if nothing found (dynamic containers may differ)
		if (matches.length === 0) {
			matches = Array.from(document.querySelectorAll(selector));
		}
		
		matches.forEach((el) => {
			const wrapper = el.closest(".active-chat-wrapper") ?? el;
			if (!wrapper) return;
				if (!fadedNodes.includes(wrapper)) {
					wrapper.classList.add('fading-slow','opacity-0','pointer-none');
					fadedNodes.push(wrapper);
				}
		});
	} catch (e) { /* ignore */ }

	showToast("Chat deleted", _dom.deleteIcon, true);

	// record original desired container so undo can restore correctly
	const originalContainer = (contact && contact._previousContainer) ? contact._previousContainer : (_dom.activeChatsContainer?.querySelector(`[data-user-id="${deletingContactId}"]`) ? 'active' : 'contacts');

	const timer = setTimeout(() => {
		messages[deletingContactId] = [];

		// Remove any lingering active-chat wrappers or contact cards for this user
		try {
			const selector = `[data-user-id="${deletingContactId}"], [data-wrapper-user-id="${deletingContactId}"]`;
			if (_dom.activeChatsContainer) {
				_dom.activeChatsContainer.querySelectorAll(selector).forEach((el) => {
					const wrapper = el.closest(".active-chat-wrapper") ?? el;
					if (wrapper) wrapper.remove();
				});
			}
		} catch (e) { /* ignore */ }
		try {
			const selector = `[data-user-id="${deletingContactId}"], [data-wrapper-user-id="${deletingContactId}"]`;
			if (_dom.contactsContainer) {
				_dom.contactsContainer.querySelectorAll(selector).forEach((el) => el.remove());
			}
		} catch (e) { /* ignore */ }

		const contact = contacts.find((c) => c.id === deletingContactId);

		if (contact) {
			if (contact.conversationId) {
				apiDeleteChat(contact.conversationId);
			}
			contact.lastMessage = "";
			contact.lastMessageTime = "";
			contact.lastMessageDate = "";
			contact.lastMessageSeen = true;
			contact.unreadCount = 0;
			contact.isPinned = false;
			contact.isInChat = false;

			// Final state after delete should be a plain contact card
			_dom.contactsContainer.appendChild(
				createContactCard(
					{ ...contact, hasMessages: false },
					_dom.onContactAction,
				),
			);
		}

		updateTotalUnreadCount();
		sortContacts();
	}, 3000);

	state.currentUndoAction = () => {
		clearTimeout(timer);
		try {
			const contactObj = contacts.find((c) => c.id === deletingContactId);
			if (!contactObj) return;
			const existingActive = _dom.activeChatsContainer?.querySelector(`[data-user-id="${contactObj.id}"]`);
			const existingContact = _dom.contactsContainer?.querySelector(`[data-user-id="${contactObj.id}"]`);

			if (originalContainer === 'contacts') {
				// ensure not duplicated in active list
				if (existingActive) {
					const wrapper = existingActive.closest('.active-chat-wrapper') ?? existingActive;
					if (wrapper) wrapper.remove();
				}
				if (!existingContact) {
					_dom.contactsContainer.appendChild(
						createContactCard({ ...contactObj, hasMessages: !!contactObj.lastMessage }, _dom.onContactAction),
					);
				} else {
						existingContact.classList.add('fading');
						existingContact.classList.remove('opacity-0');
						existingContact.classList.add('opacity-1');
						existingContact.classList.remove('pointer-none');
						existingContact.classList.add('pointer-auto');
				}
				} else {
					// restore to active chats
					if (existingContact) existingContact.remove();
					if (!existingActive) {
						_dom.activeChatsContainer.appendChild(createActiveChatCard(contactObj));
					} else {
						const wrapper = existingActive.closest('.active-chat-wrapper') ?? existingActive;
						if (wrapper) {
							wrapper.classList.add('fading');
							wrapper.classList.remove('opacity-0');
							wrapper.classList.add('opacity-1');
							wrapper.classList.remove('pointer-none');
							wrapper.classList.add('pointer-auto');
						}
					}
			}

			updateTotalUnreadCount();
			sortActiveChats();
			sortContacts();
		} catch (e) { /* ignore */ }
	};
}

// ─── Edit nickname ────────────────────────────────────────────────────────────
export function handleEditNickname() {
	_dom.detailNames.forEach((el) => {
		el.setAttribute("contenteditable", "true");
		el.classList.add('border-chat-time');
		el.focus();
		const range = document.createRange();
		const sel = window.getSelection();
		range.selectNodeContents(el);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	});
	const editNameDoneBtn1 = _dom.editNameDoneBtn?.[0];
	if (editNameDoneBtn1) editNameDoneBtn1.classList.remove('d-none');
	const cancelEditNameBtn1 = _dom.cancelEditNameBtn?.[0];
	if (cancelEditNameBtn1) cancelEditNameBtn1.classList.remove('d-none');
}

export function handleEditNicknameDone() {
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (!friend) return;
	const firstDetailName = _dom.detailNames?.[0];
	const newName = (firstDetailName && firstDetailName.textContent
		? firstDetailName.textContent.trim()
		: "");
	if (newName) {
		friend.nickname = newName;
		updateContact(friend.id, { nickname: newName });
		_dom.detailNames.forEach((el) => (el.textContent = newName));
		_dom.chatName.textContent = newName;
		refreshCard(friend);
	}

	_dom.detailNames.forEach((el) => {
		el.setAttribute("contenteditable", "false");
		el.classList.add('no-border');
	});
	_dom.editNameDoneBtn.forEach((el) => el.classList.add('d-none'));
	_dom.cancelEditNameBtn.forEach((el) => el.classList.add('d-none'));
}

export function handleEditNicknameCancel() {
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (!friend) return;

	_dom.detailNames.forEach((el) => {
		el.textContent = friend.nickname || friend.name;
		el.setAttribute("contenteditable", "false");
		el.style.border = "none";
	});
	_dom.editNameDoneBtn.forEach((el) => (el.style.display = "none"));
	_dom.cancelEditNameBtn.forEach((el) => (el.style.display = "none"));
}

// ─── Block / Unblock contact ──────────────────────────────────────────────────
export function handleBlockContact() {
	const contact = contacts.find((c) => c.id === state.contactUserId);
	if (!contact) return;
	contact.isBlocked = !contact.isBlocked;
	updateContact(contact.id, { isBlocked: contact.isBlocked });

	const messageContainer = document.querySelector(".chat-send-message");
	const unblockActionBtn = document.querySelectorAll("#unblock-action-btn");

	if (contact.isBlocked) {
		document
			.querySelectorAll("#block-contact-btn")
			.forEach((btn) => (btn.textContent = "Unblock contact"));
	messageContainer.classList.add('d-none');
	const _ub = unblockActionBtn[0];
	if (_ub) {
		_ub.classList.remove('d-none');
		_ub.classList.add('d-flex');
	}
	} else {
		document
			.querySelectorAll("#block-contact-btn")
			.forEach((btn) => (btn.textContent = "Block contact"));
	messageContainer.classList.remove('d-none');
	messageContainer.classList.add('d-flex');
	const _ub = unblockActionBtn[0];
	if (_ub) _ub.classList.add('d-none');
	}
}

// ─── Delete contact ───────────────────────────────────────────────────────────
export function handleDeleteContact() {
	const idx = contacts.findIndex((c) => c.id === state.contactUserId);
	if (idx === -1) return;

	const innerCard =
		_dom.activeChatsContainer.querySelector(
			`[data-user-id="${state.contactUserId}"]`,
		) ||
		_dom.contactsContainer.querySelector(
			`[data-user-id="${state.contactUserId}"]`,
		);
	const card = innerCard?.closest(".active-chat-wrapper") ?? innerCard;

	const deletingContactId = state.contactUserId;

	// Determine where this contact originated so undo can restore correctly
	const contactObj = contacts.find((c) => c.id === deletingContactId);
	const originalContainer = contactObj && contactObj._previousContainer
		? contactObj._previousContainer
		: (_dom.activeChatsContainer?.querySelector(`[data-user-id="${deletingContactId}"]`) ? 'active' : 'contacts');

	// Hide it first
	if (card) {
		card.classList.add('fading-slow','opacity-0','pointer-none');
	}

	closeProfile();
	closeChat();
	showToast("Contact deleted", _dom.deleteIcon, true);

	const timer = setTimeout(() => {
		if (card) card.remove();
		contacts.splice(idx, 1);
		apiDeleteContact(deletingContactId);
		delete messages[deletingContactId];
		updateTotalUnreadCount();
	}, 3000);

	state.currentUndoAction = () => {
		clearTimeout(timer);
		try {
			// restore the visual card in the original container
			const existingActive = _dom.activeChatsContainer?.querySelector(`[data-user-id="${deletingContactId}"]`);
			const existingContact = _dom.contactsContainer?.querySelector(`[data-user-id="${deletingContactId}"]`);

			if (originalContainer === 'contacts') {
				if (existingActive) {
					const w = existingActive.closest('.active-chat-wrapper') ?? existingActive;
					if (w) w.remove();
				}
				if (!existingContact) {
					_dom.contactsContainer.appendChild(
						createContactCard({ ...contactObj, hasMessages: !!contactObj.lastMessage }, _dom.onContactAction),
					);
				} else {
					existingContact.classList.add('fading');
					existingContact.classList.remove('opacity-0');
					existingContact.classList.add('opacity-1');
					existingContact.classList.remove('pointer-none');
					existingContact.classList.add('pointer-auto');
				}
			} else {
				if (existingContact) existingContact.remove();
				if (!existingActive) {
					_dom.activeChatsContainer.appendChild(createActiveChatCard(contactObj));
				} else {
					const wrapper = existingActive.closest('.active-chat-wrapper') ?? existingActive;
					if (wrapper) {
						wrapper.classList.add('fading');
						wrapper.classList.remove('opacity-0');
						wrapper.classList.add('opacity-1');
						wrapper.classList.remove('pointer-none');
						wrapper.classList.add('pointer-auto');
					}
				}
			}

			updateTotalUnreadCount();
			sortActiveChats();
			sortContacts();
		} catch (e) { /* ignore */ }
	};
}
