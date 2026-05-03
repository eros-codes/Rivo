import { state, contacts, messages } from "./state.js";
import { showToast } from "./ui.js";
import { closeChat } from "./chat.js";
import {
	updateTotalUnreadCount,
	refreshCard,
	sortActiveChats,
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
	if (_dom.editNameDoneBtn[0]) _dom.editNameDoneBtn[0].style.display = "none";
	if (_dom.cancelEditNameBtn[0])
		_dom.cancelEditNameBtn[0].style.display = "none";
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
	if (!contact) return;
	// Close profile view (desktop dialog or mobile panel)
	// Prevent profile.closeProfile() from forcing the chat panel visible again on mobile
	state.skipShowChatOnProfileClose = true;
	closeProfile();

	_dom.chatEl.textContent = "";
	closeChat();

	const innerCard =
		_dom.activeChatsContainer.querySelector(
			`[data-user-id="${state.contactUserId}"]`,
		) ||
		_dom.contactsContainer.querySelector(
			`[data-user-id="${state.contactUserId}"]`,
		);
	const card = innerCard?.closest(".active-chat-wrapper") ?? innerCard;
	if (card) card.style.display = "none";

	showToast("Chat deleted", _dom.deleteIcon, true);

	const deletingContactId = state.contactUserId;

	const timer = setTimeout(() => {
		messages[deletingContactId] = [];
		const contact = contacts.find((c) => c.id === deletingContactId);
		if (contact?.conversationId) {
			apiDeleteChat(contact.conversationId);
		}
		contact.lastMessage = "";
		contact.lastMessageTime = "";
		contact.lastMessageDate = "";
		contact.lastMessageSeen = true;
		contact.unreadCount = 0;
		contact.isPinned = false;
		contact.isInChat = false;
		if (card) card.remove();

		_dom.contactsContainer.appendChild(
			createContactCard(
				{ ...contact, hasMessages: false },
				_dom.onContactAction,
			),
		);

		updateTotalUnreadCount();
		sortContacts();
	}, 3000);

	state.currentUndoAction = () => {
		clearTimeout(timer);
		if (card) {
			card.style.display = "";
			card.style.pointerEvents = "";
		}
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
	if (_dom.editNameDoneBtn[0])
		_dom.editNameDoneBtn[0].style.display = "block";
	if (_dom.cancelEditNameBtn[0])
		_dom.cancelEditNameBtn[0].style.display = "block";
}

export function handleEditNicknameDone() {
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (!friend) return;
	const newName = _dom.detailNames[0].textContent.trim();
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
		unblockActionBtn[0].style.display = "flex";
	} else {
		document
			.querySelectorAll("#block-contact-btn")
			.forEach((btn) => (btn.textContent = "Block contact"));
		messageContainer.style.display = "flex";
		unblockActionBtn[0].style.display = "none";
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
