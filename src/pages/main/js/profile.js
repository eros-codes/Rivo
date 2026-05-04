import { state, contacts, messages } from "./state.js";
import { showToast } from "./ui.js";
import { closeChat } from "./chat.js";
import {
	updateTotalUnreadCount,
	refreshCard,
	sortContacts,
} from "./chat-logic.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { updateContact, deleteContact as apiDeleteContact, deleteChat as apiDeleteChat } from "./api.js";

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

	_dom.detailUsernames.forEach((el) => {
		el.style.cursor = "pointer";
		el.onclick = () => {
			navigator.clipboard.writeText(`@${friend.username}`);
			el.textContent = "Copied!";
			setTimeout(() => {
				el.textContent = "@" + friend.username;
			}, 1500);
		};
	});

	_dom.detailEmails.forEach((el) => {
		if (!friend.email) return;
		el.style.cursor = "pointer";
		el.onclick = () => {
			navigator.clipboard.writeText(friend.email);
			el.textContent = "Copied!";
			setTimeout(() => {
				el.textContent = friend.email;
			}, 1500);
		};
	});

	if (window.innerWidth > 700) {
		if (_dom.profileDialog) {
			_dom.profileDialog.appendChild(_dom.contactProfileDetails);
			_dom.profileDialog.showModal();
		}
	} else {
		_dom.contactProfileDetails.style.display = "flex";
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
		el.style.border = "none";
	});
	const editNameDoneBtn0 = _dom.editNameDoneBtn?.[0];
	if (editNameDoneBtn0) editNameDoneBtn0.style.display = "none";
	const cancelEditNameBtn0 = _dom.cancelEditNameBtn?.[0];
	if (cancelEditNameBtn0) cancelEditNameBtn0.style.display = "none";
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
				_dom.contactProfileDetails.style.display = "none";
				if (!state.skipShowChatOnProfileClose) {
					_dom.chatPart.style.display = "flex";
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
				wrapper.style.transition = "opacity 3s ease";
				wrapper.style.opacity = "0";
				wrapper.style.pointerEvents = "none";
				fadedNodes.push(wrapper);
			}
		});
	} catch (e) { /* ignore */ }

	showToast("Chat deleted", _dom.deleteIcon, true);

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
		// Restore any faded nodes
		try {
			fadedNodes.forEach((n) => {
				n.style.transition = "opacity 0.2s ease";
				n.style.opacity = "1";
				n.style.pointerEvents = "";
			});
		} catch (e) { /* ignore */ }
	};
}

// ─── Edit nickname ────────────────────────────────────────────────────────────
export function handleEditNickname() {
	_dom.detailNames.forEach((el) => {
		el.setAttribute("contenteditable", "true");
		el.style.border = "1px solid var(--chat-time)";
		el.focus();
		const range = document.createRange();
		const sel = window.getSelection();
		range.selectNodeContents(el);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	});
	const editNameDoneBtn1 = _dom.editNameDoneBtn?.[0];
	if (editNameDoneBtn1) editNameDoneBtn1.style.display = "block";
	const cancelEditNameBtn1 = _dom.cancelEditNameBtn?.[0];
	if (cancelEditNameBtn1) cancelEditNameBtn1.style.display = "block";
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
		el.style.border = "none";
	});
	_dom.editNameDoneBtn.forEach((el) => (el.style.display = "none"));
	_dom.cancelEditNameBtn.forEach((el) => (el.style.display = "none"));
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
		messageContainer.style.display = "none";
		const _ub = unblockActionBtn[0];
		if (_ub) _ub.style.display = "flex";
	} else {
		document
			.querySelectorAll("#block-contact-btn")
			.forEach((btn) => (btn.textContent = "Block contact"));
		messageContainer.style.display = "flex";
		const _ub = unblockActionBtn[0];
		if (_ub) _ub.style.display = "none";
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

	// Hide it first
	if (card) {
		card.style.transition = "opacity 3s ease";
		card.style.opacity = "0";
		card.style.pointerEvents = "none";
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
		if (card) {
			card.style.transition = "opacity 0.2s ease";
			card.style.opacity = "1";
			card.style.pointerEvents = "";
		}
	};
}
