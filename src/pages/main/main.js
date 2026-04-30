import { updateContact as apiUpdateContact, logout as apiLogout, getContacts } from "./js/api.js";
import { createContactCard } from "../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../components/active-chats/active-chats.js";
import { createForwardedContactCard } from "../../components/contact-cards/contacts-forward.js";
import { state, contacts, messages } from "./js/state.js";
import { escapeHtml } from "../../components/messages/messages.js";
import {
	initToast,
	showToast,
	highlightMessage,
	createEmptyStateEl,
} from "./js/ui.js";
import {
	initChat,
	openChat,
	closeChat,
	injectMessages,
	sendMessage,
	resetInput,
	scrollChatToBottom,
	updatePinCount,
	basePadding,
	lineHeight,
	maxLines,
	maxHeight,
	receiveMessage,
	handleMessagesSeen,
} from "./js/chat.js";
import {
	initChatLogic,
	updateTotalUnreadCount,
	moveToContacts,
	refreshCard,
	moveToActiveChats,
	sortActiveChats,
	sortContacts,
} from "./js/chat-logic.js";
import {
	initContextMenu,
	openContextMenu,
	closeContextMenu,
	deleteMessage,
	undoDeleteMessage,
	buildForwardedMsg,
	pinMessage,
	editMessage,
	replyMessage,
} from "./js/context-menu.js";
import {
	initSelection,
	enterSelectionMode,
	cancelSelection,
	updateSelectionCount,
	handleBulkDelete,
	prepareBulkForward,
	executeBulkForward,
} from "./js/selection.js";
import {
	initProfile,
	openProfile,
	closeProfile,
	handleDeleteChat,
	handleEditNickname,
	handleEditNicknameDone,
	handleEditNicknameCancel,
	handleBlockContact,
	handleDeleteContact,
} from "./js/profile.js";
import { initCardContextMenu } from "./js/card-context-menu.js";
import { initSearch, runSearch } from "./js/search.js";
import { initEditProfile, openEditProfile } from "./js/edit-profile.js";
import { initSettings, openSettings, closeSettings } from "./js/settings.js";
import { initAddContact, openAddContact } from "./js/add-contact.js";
import { initSocket, emitTypingStart, emitTypingStop, emitPinMessage, getSocket } from "./js/socket.js";

document.addEventListener("DOMContentLoaded", async function () {
	const token = localStorage.getItem("token");
	if (!token) {
		window.location.href = "../auth/auth.html";
		return;
	}

	const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
	// ─── DOM references ───────────────────────────────────────────────────────
	const logoutBtn = document.getElementById("logout");
	const chatPart = document.getElementById("chat-part");
	const mainContent = document.getElementById("main-content");
	const peoplePart = document.getElementById("people-part");
	const chatEl = document.querySelector(".chat");
	const contactsContainer = document.querySelector(".contacts-container");
	const activeChatsContainer = document.querySelector(
		".active-chats-container",
	);
	const chatProfilePic = document.querySelector(".chat-profile-picture");
	const chatName = document.querySelector(".chat-name");
	const closeChatBtn = document.getElementById("close-chat");
	const settingsBtn = document.querySelector(".settings");
	const settingsList = document.querySelector(".settings-list");
	const searchbar = document.querySelector(".search-bar");
	const searchInput = document.querySelector(".search-input");
	const messageInput = document.querySelector(".message-input");
	const sendMessageBtn = document.querySelector(".send-btn");
	const cancelEditBtn = document.querySelector(".cancel-edit-btn");
	const messageContainer = document.querySelector(".chat-send-message");
	const messageMenu = document.querySelector(".message-menu");
	const chatOverlay = document.querySelector(".chat-overlay");
	const deleteMsg = document.querySelectorAll(".delete-message");
	const replyMsg = document.querySelectorAll(".reply-message");
	const forwardMsg = document.querySelectorAll(".forward-message");
	const copyMsg = document.querySelectorAll(".copy-message");
	const editMsg = document.querySelectorAll(".edit-message");
	const selectMsg = document.querySelectorAll(".select-message");
	const pinMsg = document.querySelectorAll(".pin-message");
	const msgAction = document.querySelector(".message-action-preview");
	const msgActionText = document.querySelector(
		".message-action-preview .action-name",
	);
	const msgActionmsg = document.querySelector(
		".message-action-preview .action-message-preview",
	);
	const toaster = document.querySelector(".toaster");
	const toastMessage = document.querySelector(".toast-message");
	const toastIcon = document.querySelector(".toast-icon");
	const undoBtn = document.querySelector(".undo-btn");
	const forwardDialog = document.querySelector(".forward-dialog");
	const forwardDialogCloseBtn = document.getElementById(
		"close-forward-dialog",
	);
	const pinnedMessageContainer = document.querySelector(
		".pinned-message-container",
	);
	const pinnedMessageCount = document.querySelector(".pinned-message-count");
	const pinnedMessageText = document.querySelector(".pinned-message-text");
	const chatHeader = document.querySelector(".chat-header");
	const scrollToBottomBtn = document.querySelector(".scroll-to-bottom-btn");
	const selectionToolbar = document.querySelector(".selection-toolbar");
	const selectionCount = document.querySelector(".selection-count");
	const selectionForwardBtn = document.querySelector(
		".selection-forward-btn",
	);
	const selectionDeleteBtn = document.querySelector(".selection-delete-btn");
	const cancelSelectionBtn = document.querySelector(".cancel-selection-btn");
	const unreadMessageCount = document.querySelector(".unread-message-count");
	const contactProfileDetails = document.querySelector(
		".contact-profile-details",
	);
	const profileDialog = document.querySelector(".profile-dialog");
	const detailsCloseBtn = document.querySelector(
		".parts > .contact-profile-details .contact-detail-pic button",
	);
	const detailPictures = document.querySelectorAll(".detail-picture img");
	const detailNames = document.querySelectorAll(".contact-detail-name h3");
	const detailBios = document.querySelectorAll(".contact-detail-name h6");
	const detailLastSeens = document.querySelectorAll(".contact-detail-name p");
	const detailUsernames = document.querySelectorAll("#contact-username h3");
	const detailEmails = document.querySelectorAll("#contact-email h3");
	const deleteChatBtns = document.querySelectorAll("#delete-chat-btn");
	const editNameBtns = document.querySelectorAll("#edit-name-btn");
	const editNameDoneBtn = document.querySelectorAll(
		".contact-detail-name #edit-name-done-btn",
	);
	const cancelEditNameBtn = document.querySelectorAll(
		".contact-detail-name #cancel-edit-name-btn",
	);
	const blockContactBtns = document.querySelectorAll("#block-contact-btn");
	const deleteContactBtns = document.querySelectorAll("#delete-contact-btn");
	const unblockActionBtn = document.querySelectorAll("#unblock-action-btn");
	const emojiBtn = document.querySelector(".emoji-btn");
	const emojiPicker = document.querySelector("emoji-picker");
	let savedSelectionStart = 0;
	let savedSelectionEnd = 0;
	const searchResults = document.getElementById("search-results");
	const searchContactsList = searchResults.querySelector(
		".search-contacts-list",
	);
	const searchMessagesList = searchResults.querySelector(
		".search-messages-list",
	);
	const pinnedViewDialog = document.querySelector(".pinned-view-dialog");
	const pinnedViewList = document.querySelector(".pinned-view-list");
	const pinnedViewClose = document.querySelector(".pinned-view-close");
	const pinnedMessageIcon = document.querySelector(".pinned-message-icon");
	const editProfileDialog = document.querySelector(".edit-profile-dialog");
	const editProfileClose = document.getElementById("edit-profile-close");
	const editProfileSave = document.getElementById("edit-profile-save");
	const editNameInput = document.getElementById("edit-name-input");
	const editUsernameInput = document.getElementById("edit-username-input");
	const editBioInput = document.getElementById("edit-bio-input");
	const editProfileAvatar = document.querySelector(".edit-profile-avatar");
	const editSection = document.querySelector(".edit-section");
	const editProfilePanel = document.querySelector(".edit-profile-panel");
	const settingsPanel = document.querySelector(".settings-panel");
	const settingsDialog = document.querySelector(".settings-dialog");
	const settingsPanelClose = document.querySelector(".settings-panel-close");
	const settingsThemeRow = document.getElementById("settings-theme-row");
	const settingsThemeValue = document.getElementById("settings-theme-value");
	const settingsDeleteAccount = document.getElementById("settings-delete-account");
	const settingsChangePassword = document.getElementById("settings-change-password");
	const settingsChangePasswordForm = document.getElementById("settings-change-password-form");
	const settingsCurrentPassword = document.getElementById("settings-current-password");
	const settingsNewPassword = document.getElementById("settings-new-password");
	const settingsConfirmPassword = document.getElementById("settings-confirm-password");
	const settingsChangePasswordSubmit = document.getElementById("settings-change-password-submit");
	const settingsSendResetEmail = document.getElementById("settings-send-reset-email");
	const settingsPrivacyOnline = document.getElementById("settings-privacy-online");
	const settingsPrivacyEmail = document.getElementById("settings-privacy-email");
	const settingsPrivacyProfile = document.getElementById("settings-privacy-profile");
	const pickerOnline = document.getElementById("picker-online");
	const pickerEmail = document.getElementById("picker-email");
	const pickerProfile = document.getElementById("picker-profile");
	const settingsArchived = document.getElementById("settings-archived");
	const addContactDialog = document.getElementById("add-contact-dialog");
	const addContactName = document.getElementById("add-contact-name");
	const addContactUsername = document.getElementById("add-contact-username");
	const addContactError = document.getElementById("add-contact-error");
	const addContactCancel = document.getElementById("add-contact-cancel");
	const addContactSubmit = document.getElementById("add-contact-submit");
	const addFriendsBtn = document.querySelector(".add-friends");
	const chatProfilePicture = document.querySelector(".chat-profile");
	const chatTypingStatus = document.querySelector(".chat-typing-status");
	const avatarBtn = document.querySelector(".edit-profile-avatar-btn");
	const avatarFileInput = document.getElementById("avatar-file-input");
	const avatarCropDialog = document.querySelector(".avatar-crop-dialog");
	const avatarCropImage = document.getElementById("avatar-crop-image");
	const avatarCropCancel = document.getElementById("avatar-crop-cancel");
	const avatarCropConfirm = document.getElementById("avatar-crop-confirm");
	const deleteAvatarBtn = document.getElementById(
		"edit-profile-delete-avatar",
	);
	const settingsSectionLi = document.querySelector(
		".settings-list .settings-section",
	);


	// ─── SVG icons ────────────────────────────────────────────────────────────
	const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></g></svg>`;
	const deleteIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8 9h8v10H8zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
	const pinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="currentColor" d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"/></svg>`;
	const replyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M10 9V5l-7 7l7 7v-4.1c5 0 8.5 1.6 11 5.1c-1-5-4-10-11-10"/></svg>`;
	// ─── Empty state element ──────────────────────────────────────────────────
	const emptyStateEl = createEmptyStateEl();

	// ─── Sweep to reply ───────────────────────────────────────────────────────
	let swipeStartX = 0;
	let swipeStartY = 0;
	let swipeMsg = null;
	let swipeIcon = null;
	let didSwipe = false;
	let swipeBounced = false;
	const SWIPE_THRESHOLD = 100;

	// ─── Typing indicator ─────────────────────────────────────────────────────
	let _typingTimeout = null;

	// ─── Init all modules ─────────────────────────────────────────────────────
	initToast({ toaster, messageContainer, toastMessage, toastIcon, undoBtn });

	initChat({
		chatPart,
		mainContent,
		peoplePart,
		chatEl,
		contactProfileDetails,
		messageInput,
		sendMessageBtn,
		msgAction,
		cancelEditBtn,
		pinnedMessageContainer,
		pinnedMessageText,
		pinnedMessageCount,
		chatHeader,
		emptyStateEl,
		chatProfilePicture,
	});

	initChatLogic({
		activeChatsContainer,
		contactsContainer,
		unreadMessageCount,
		onContactAction: _onContactAction,
	});

	initContextMenu({
		messageMenu,
		chatOverlay,
		editMsg,
		chatEl,
		emptyStateEl,
		messageInput,
		sendMessageBtn,
		msgAction,
		msgActionText,
		msgActionmsg,
		cancelEditBtn,
	});

	initSelection({
		chatEl,
		messageContainer,
		selectionToolbar,
		selectionCount,
		forwardDialog,
		deleteIcon,
		emptyStateEl,
		chatProfilePic,
		chatName,
		msgAction,
		msgActionText,
		msgActionmsg,
		messageInput,
		sendMessageBtn,
	});

	initProfile({
		contactProfileDetails,
		profileDialog,
		chatPart,
		peoplePart,
		detailPictures,
		detailNames,
		detailBios,
		detailLastSeens,
		detailUsernames,
		detailEmails,
		editNameDoneBtn,
		cancelEditNameBtn,
		chatEl,
		chatName,
		chatProfilePic,
		activeChatsContainer,
		contactsContainer,
		deleteIcon,
		onContactAction: _onContactAction,
	});

	initCardContextMenu(activeChatsContainer, (action, userId) => {
		state.contactUserId = userId;
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;

		if (action === "pin") {
			friend.isPinned = !friend.isPinned;
			apiUpdateContact(friend.id, { isPinned: friend.isPinned });
			if (friend.isPinned) {
				moveToActiveChats(friend);
			} else {
				if (
					friend.unreadCount === 0 &&
					friend.lastMessageSeen !== false
				) {
					moveToContacts(friend);
				} else {
					refreshCard(friend);
				}
			}
			sortActiveChats();
			sortContacts();
		}
		if (action === "mute") {
			friend.isMuted = !friend.isMuted;
			apiUpdateContact(friend.id, { isMuted: friend.isMuted });
			refreshCard(friend);
		}
		if (action === "delete") {
			handleDeleteChat();
		}
	});

	initSearch({
		mainContent,
		searchResults,
		searchContactsList,
		searchMessagesList,
		onContactAction: _onContactAction,
		onMessageClick: (contact, msgIndex) => {
			searchbar.classList.remove("open");
			searchInput.value = "";
			runSearch("");

			state.contactUserId = contact.id;
			chatProfilePic.src =
				contact.profilePics[0] ||
				"../../../public/assets/images/profile.jpeg";
			chatName.textContent = contact.nickname || contact.name;
			openChat(true);
			scrollChatToBottom();

			if (msgIndex === null) return;

			setTimeout(() => {
				const msgEl = chatEl.querySelector(
					`[data-index="${msgIndex}"]`,
				);
				if (msgEl) {
					msgEl.scrollIntoView({
						behavior: "smooth",
						block: "center",
					});
					highlightMessage(msgEl);
				}
			}, 500);
		},
	});

		initEditProfile({
		editProfilePanel,
		editProfileDialog,
		editProfileClose,
		editProfileSave,
		editNameInput,
		editUsernameInput,
		editBioInput,
		editProfileAvatar,
		avatarBtn,
		avatarFileInput,
		avatarCropDialog,
		avatarCropImage,
		avatarCropCancel,
		avatarCropConfirm,
		deleteAvatarBtn,
		chatPart,
		peoplePart,
	});

	initSettings({
		settingsPanel,
		settingsDialog,
		settingsPanelClose,
		settingsThemeRow,
		settingsThemeValue,
		settingsDeleteAccount,
		settingsChangePassword,
		settingsChangePasswordForm,
		settingsCurrentPassword,
		settingsNewPassword,
		settingsConfirmPassword,
		settingsChangePasswordSubmit,
		settingsSendResetEmail,
		settingsPrivacyOnline,
		settingsPrivacyEmail,
		settingsPrivacyProfile,
		pickerOnline,
		pickerEmail,
		pickerProfile,
		settingsArchived,
		chatPart,
		peoplePart,
	}, currentUser);

	initAddContact(
		{
			addContactDialog,
			addContactName,
			addContactUsername,
			addContactError,
			addContactCancel,
			addContactSubmit,
			addFriendsBtn,
		},
		(newContact) => {
			contacts.push({
				...newContact,
				contactId: newContact.contact?.id,
				conversationId: newContact.conversationId,
				profilePics: newContact.contact?.profilePics || [],
				name: newContact.nickname || newContact.contact?.name || "",
				username: newContact.contact?.username || "",
				isOnline: false,
				lastSeen: null,
				bio: newContact.contact?.bio || "",
				email: newContact.contact?.email || "",
				lastMessage: "",
				lastMessageTime: null,
				lastMessageDate: null,
				unreadCount: 0,
				lastMessageSeen: true,
			});
			const _sock = getSocket();
			if (_sock && newContact.conversationId) {
				_sock.emit("conversation:join", { conversationId: newContact.conversationId });
			}

			updateContactsEmptyState();
			
			const card = createContactCard(
				{ ...newContact, hasMessages: false },
				_onContactAction,
			);
			contactsContainer.appendChild(card);
			state.contactUserId = newContact.id;
			openChat(true);
		},

	);

	initSocket(
		// new message
		(msg) => receiveMessage(msg),
		// edit
		(data) => {
			const userMsgs = messages[state.contactUserId];
			if (!userMsgs) return;
			const index = userMsgs.findIndex((m) => m.id === data.messageId);
			if (index === -1) return;
			userMsgs[index].text = data.text;
			userMsgs[index].isEdited = true;
			const msgEl = document.querySelector(
				`.chat-message[data-index="${index}"]`,
			);
			if (!msgEl) return;
			const textEl = msgEl.querySelector(".chat-message-text");
			if (textEl) textEl.textContent = data.text;
			if (!msgEl.querySelector(".chat-edited-label")) {
				const label = document.createElement("span");
				label.className = "chat-edited-label";
				label.textContent = "edited";
				msgEl.querySelector(".chat-message-meta")?.prepend(label);
			}
		},
		// delete
		(data) => {
			// Find which conversation contains this messageId
			let foundUserId = null;
			let foundIndex = -1;
			for (const [uid, msgs] of Object.entries(messages)) {
				if (!Array.isArray(msgs)) continue;
				const idx = msgs.findIndex((m) => m.id === data.messageId);
				if (idx !== -1) {
					foundUserId = Number(uid);
					foundIndex = idx;
					break;
				}
			}
			if (foundUserId === null) return;
			const userMsgs = messages[foundUserId];
			userMsgs.splice(foundIndex, 1);

			// If this conversation is open, re-render messages so indexes stay correct
			if (state.contactUserId === foundUserId) {
				injectMessages(foundUserId);
			}

			// Update contact card last-message preview
			const friend = contacts.find((c) => c.id === foundUserId);
			if (friend) {
				if (userMsgs.length > 0) {
					const lastMsg = userMsgs.at(-1);
					friend.lastMessage = lastMsg.text;
					friend.lastMessageTime = lastMsg.time;
					friend.lastMessageDate = lastMsg.date || "";
					friend.lastMessageSeen = lastMsg.user ? lastMsg.isSeen === true : true;
				} else {
					friend.lastMessage = "";
					friend.lastMessageTime = "";
					friend.lastMessageDate = "";
					friend.lastMessageSeen = true;
				}
				refreshCard(friend);
				sortActiveChats();
				sortContacts();
			}
		},
		// online
		(userId) => {
			const contact = contacts.find((c) => c.contactId === userId);
			if (!contact) return;
			contact.isOnline = true;
			if (state.contactUserId === contact.id) {
				chatProfilePicture.classList.add("online");
			}
			refreshCard(contact);
		},
		// offline
		(userId, lastSeen) => {
			const contact = contacts.find((c) => c.contactId === userId);
			if (!contact) return;
			contact.isOnline = false;
			contact.lastSeen = lastSeen;
			if (state.contactUserId === contact.id) {
				chatProfilePicture.classList.remove("online");
			}
			refreshCard(contact);
		},
		// payload: { conversationId, messageIds, seenBy }
		(payload) => {
			handleMessagesSeen(
				payload.conversationId,
				payload.messageIds,
				payload.seenBy,
			);
		},
		// start typing
		(userId) => {
			const contact = contacts.find((c) => c.contactId === userId);
			if (!contact || state.contactUserId !== contact.id) return;
			chatTypingStatus.textContent = "typing...";
		},
		// stop typing
		(userId) => {
			const contact = contacts.find((c) => c.contactId === userId);
			if (!contact || state.contactUserId !== contact.id) return;
			chatTypingStatus.textContent = "";
		},
		// message pinned
		({ messageId, isPinned }) => {
			for (const [uid, msgs] of Object.entries(messages)) {
				if (!Array.isArray(msgs)) continue;
				const idx = msgs.findIndex((m) => m.id === messageId);
				if (idx !== -1) {
					msgs[idx].isPinned = isPinned;
					if (state.contactUserId === Number(uid)) {
						injectMessages(Number(uid));
					}
					break;
				}
			}
		}
	);

	function updateContactsEmptyState() {
		const empty = document.getElementById("contacts-empty");
		if (!empty) return;
		empty.style.display = contacts.length === 0 ? "flex" : "none";
	}

	function _onContactAction(action, userId) {
		state.contactUserId = userId;
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;
		if (action === "pin") {
			friend.isPinned = !friend.isPinned;
			apiUpdateContact(friend.id, { isPinned: friend.isPinned });
			if (friend.isPinned) {
				moveToActiveChats(friend);
			} else {
				if (
					friend.unreadCount === 0 &&
					friend.lastMessageSeen !== false
				) {
					moveToContacts(friend);
				} else {
					refreshCard(friend);
				}
			}
			sortActiveChats();
			sortContacts();
		}
		if (action === "mute") {
			friend.isMuted = !friend.isMuted;
			apiUpdateContact(friend.id, { isMuted: friend.isMuted });
			refreshCard(friend);
		}
		if (action === "delete") {
			handleDeleteChat();
		}
		if (action === "block") {
			handleBlockContact();
			refreshCard(friend);
		}
	}

	function openPinnedView() {
		pinnedViewList.innerHTML = "";

		if (state.pinnedIndexes.length === 0) {
			pinnedViewList.innerHTML = `<p class="pinned-view-empty">No pinned messages</p>`;
			pinnedViewDialog.showModal();
			return;
		}

		const msgs = messages[state.contactUserId];
		const friend = contacts.find((c) => c.id === state.contactUserId);

		[...state.pinnedIndexes].reverse().forEach((idx) => {
			const msg = msgs[idx];
			if (!msg) return;

			const item = document.createElement("div");
			item.className = "pinned-view-item";
			item.innerHTML = `
            <div class="pinned-view-item-meta">
                <span class="pinned-view-item-sender">${msg.user ? "You" : friend?.nickname || friend?.name || ""}</span>
                <span class="pinned-view-item-time">${msg.time}</span>
            </div>
            <p class="pinned-view-item-text">${escapeHtml(msg.text)}</p>
        `;

			item.addEventListener("click", () => {
				pinnedViewDialog.close();
				const msgEl = chatEl.querySelector(`[data-index="${idx}"]`);
				if (!msgEl) return;
				state.isProgrammaticScroll = true;
				msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
				setTimeout(() => {
					state.isProgrammaticScroll = false;
				}, 800);
				highlightMessage(msgEl);
			});

			pinnedViewList.appendChild(item);
		});

		pinnedViewDialog.showModal();
	}

	// ─── Inject initial cards ─────────────────────────────────────────────────
	try {
		const serverContacts = await getContacts();
		serverContacts.forEach((c) => {
			contacts.push({
				...c,
				name: c.nickname || c.contact?.name || "",
				username: c.contact?.username || "",
				profilePics: c.contact?.profilePics || [],
				isOnline: c.contact?.isOnline || false,
				lastSeen: c.contact?.lastSeen || null,
				bio: c.contact?.bio || "",
				email: c.contact?.email || "",
				lastMessage: c.conversation?.messages?.[0]?.text || "",
				lastMessageTime: c.conversation?.messages?.[0]
					? new Date(
							c.conversation.messages[0].createdAt,
						).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
							hour12: false,
						})
					: null,
				lastMessageDate: c.conversation?.messages?.[0]
					? new Date(c.conversation.messages[0].createdAt)
							.toISOString()
							.slice(0, 10)
					: null,
				unreadCount: c.unreadCount ?? 0,
				lastMessageSeen: (() => {
					const lastMsg = c.conversation?.messages?.[0];
					if (!lastMsg) return true;
					return lastMsg.isSeen === true;
				})(),
			});
		});
	} catch {
		console.error("Failed to load contacts");
	}
	contacts.forEach((contact) => {
		if (
			contact.isPinned ||
			contact.unreadCount > 0 ||
			contact.lastMessageSeen === false
		) {
			activeChatsContainer.appendChild(createActiveChatCard(contact));
		} else {
			contactsContainer.appendChild(
				createContactCard(
					{ ...contact, hasMessages: !!contact.lastMessage },
					_onContactAction,
				),
			);
		}
	});
	updateTotalUnreadCount();
	sortActiveChats();
	sortContacts();
	updateContactsEmptyState();

	// ─── Settings ─────────────────────────────────────────────────────────────
	if (settingsSectionLi && settingsList) {
		settingsSectionLi.addEventListener("click", (e) => {
			e.stopPropagation();
			if (!settingsList.classList.contains("open")) {
				settingsList.classList.add("open");
			} else {
				settingsList.classList.remove("open");
				openSettings(currentUser);
			}
		});
	}

	if (searchInput) {
		searchbar.addEventListener("click", () => {
			searchbar.classList.toggle("open");
			if (searchbar.classList.contains("open")) searchInput.focus();
		});
		searchInput.addEventListener("input", () => {
			runSearch(searchInput.value.trim().toLowerCase());
		});
	}

	if (logoutBtn) {
		logoutBtn.addEventListener("click", async () => {
			await apiLogout();
			window.location.href = "../auth/auth.html";
		});
	}

	// ─── Close chat ───────────────────────────────────────────────────────────
	if (closeChatBtn) {
		closeChatBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			chatEl.innerHTML = "";
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (friend) {
				friend.isInChat = false;
				// persist isInChat to server
				apiUpdateContact(friend.id, { isInChat: false }).catch(() => {});
				if (
					!friend.isPinned &&
					friend.unreadCount === 0 &&
					friend.lastMessageSeen !== false
				) {
					moveToContacts(friend);
					sortActiveChats();
					sortContacts();
				}
			}
			closeChat();
		});
	}

	// ─── Open chat — active-chats ─────────────────────────────────────────────
	if (activeChatsContainer) {
		activeChatsContainer.addEventListener("click", (e) => {
			const active = e.target.closest(".active-chat");
			if (!active) return;

			const prevFriend = contacts.find(
				(c) => c.id === state.contactUserId,
			);
			if (prevFriend && prevFriend.id !== Number(active.dataset.userId)) {
				prevFriend.isInChat = false;
				apiUpdateContact(prevFriend.id, { isInChat: false }).catch(() => {});
				if (
					!prevFriend.isPinned &&
					prevFriend.unreadCount === 0 &&
					prevFriend.lastMessageSeen !== false
				) {
					moveToContacts(prevFriend);
					sortActiveChats();
					sortContacts();
				}
			}

			state.contactUserId = Number(active.dataset.userId);
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (!friend) return;

			if (friend.unreadCount > 0) {
				friend.lastMessageSeen = true;
			}
			friend.unreadCount = 0;
			friend.isInChat = true;
			apiUpdateContact(friend.id, { unreadCount: 0, isInChat: true }).catch(() => {});
			const unreadEl = active.querySelector(
				".active-chat-unread-messages",
			);
			if (unreadEl) unreadEl.style.opacity = "0";
			updateTotalUnreadCount();

			chatProfilePic.src =
				friend.profilePics[0] ||
				"../../../public/assets/images/profile.jpeg";
			chatName.textContent = friend.nickname || friend.name;
			openChat(true);
			scrollChatToBottom();

			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				unblockActionBtn[0].style.display = "flex";
			} else {
				messageContainer.style.display = "flex";
				unblockActionBtn[0].style.display = "none";
			}

			const existingCard = activeChatsContainer.querySelector(
				`[data-user-id="${friend.id}"]`,
			);
			if (existingCard) {
				const wrapper =
					existingCard.closest(".active-chat-wrapper") ??
					existingCard;
				wrapper.replaceWith(createActiveChatCard(friend));
			}
		});
	}

	// ─── Open chat — contacts ─────────────────────────────────────────────────
	if (contactsContainer) {
		contactsContainer.addEventListener("click", (e) => {
			const card = e.target.closest(".contacts-card");
			if (!card) return;

			const prevFriend = contacts.find(
				(c) => c.id === state.contactUserId,
			);
			if (prevFriend && prevFriend.id !== Number(card.dataset.userId)) {
				prevFriend.isInChat = false;
				apiUpdateContact(prevFriend.id, { isInChat: false }).catch(() => {});
				if (
					!prevFriend.isPinned &&
					prevFriend.unreadCount === 0 &&
					prevFriend.lastMessageSeen !== false
				) {
					moveToContacts(prevFriend);
					sortActiveChats();
					sortContacts();
				}
			}

			state.contactUserId = Number(card.dataset.userId);
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (!friend) return;

			if (friend.unreadCount > 0) {
				friend.lastMessageSeen = true;
			}
			friend.unreadCount = 0;
			friend.isInChat = true;
			apiUpdateContact(friend.id, { unreadCount: 0, isInChat: true }).catch(() => {});
			updateTotalUnreadCount();

			card.remove();
			activeChatsContainer.appendChild(createActiveChatCard(friend));

			chatProfilePic.src =
				friend.profilePics[0] ||
				"../../../public/assets/images/profile.jpeg";
			chatName.textContent = friend.nickname || friend.name;
			openChat(true);
			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				unblockActionBtn[0].style.display = "flex";
			} else {
				messageContainer.style.display = "flex";
				unblockActionBtn[0].style.display = "none";
			}
			scrollChatToBottom();
		});
	}

	// ─── Message input ────────────────────────────────────────────────────────
	if (messageInput && sendMessageBtn && chatEl && messageContainer) {
		messageInput.addEventListener("input", () => {
			const nearBottom =
				chatEl.scrollTop + chatEl.clientHeight >=
				chatEl.scrollHeight - 20;
			if (nearBottom) scrollChatToBottom();

			const firstChar = messageInput.value.trim()[0];
			if (firstChar)
				messageInput.dir = /[\u0600-\u06FF]/.test(firstChar)
					? "rtl"
					: "ltr";

			if (messageInput.value.trim().length > 0) {
				sendMessageBtn.style.display = "block";
				if (cancelEditBtn.style.display === "block")
					cancelEditBtn.style.display = "none";
			} else {
				sendMessageBtn.style.display = "none";
			}

			messageInput.style.height = "auto";
			let newHeight = messageInput.scrollHeight;
			if (newHeight > maxHeight) {
				newHeight = maxHeight;
				messageInput.style.overflowY = "auto";
			} else {
				messageInput.style.overflowY = "hidden";
			}
			messageInput.style.height = newHeight + "px";

			let lines = Math.floor(messageInput.scrollHeight / lineHeight);
			if (lines < 1) lines = 1;
			if (lines > maxLines) lines = maxLines;

			if (lines < maxLines) {
				chatEl.style.paddingBottom =
					basePadding +
					2 * (lines - 1) * 0.75 +
					state.actionPreviewHeight +
					"rem";
			} else {
				chatEl.style.paddingBottom =
					basePadding +
					2 * ((maxLines - 2) * 0.75 + 0.2) +
					state.actionPreviewHeight +
					"rem";
			}

			// typing emit
			const _contact = contacts.find((c) => c.id === state.contactUserId);
			if (_contact?.conversationId) {
				emitTypingStart(_contact.conversationId);
				clearTimeout(_typingTimeout);
				_typingTimeout = setTimeout(() => {
					emitTypingStop(_contact.conversationId);
				}, 2000);
			}
		});

		messageInput.addEventListener("blur", () => {
			savedSelectionStart = messageInput.selectionStart;
			savedSelectionEnd = messageInput.selectionEnd;
		});

		sendMessageBtn.addEventListener("click", sendMessage);
		messageInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 700) {
				e.preventDefault();
				sendMessage();
			}
		});
	}

	// ─── Chat area events ─────────────────────────────────────────────────────
	if (
		chatEl &&
		messageMenu &&
		chatOverlay &&
		pinnedMessageContainer &&
		scrollToBottomBtn
	) {
		chatEl.addEventListener("touchstart", (e) => {
			// Disable swipe interactions while a context menu is open
			if (state.isMenuOpen) return;

			const msg = e.target.closest(".chat-message");
			swipeMsg = msg || null;
			swipeStartX = e.touches[0].clientX;
			swipeStartY = e.touches[0].clientY;
			didSwipe = false;
			swipeBounced = false;

			if (msg) {
				// Create reply icon if missing
				if (!msg.querySelector(".swipe-reply-icon")) {
					const icon = document.createElement("div");
					icon.className = "swipe-reply-icon";
					icon.innerHTML = replyIcon;
					msg.appendChild(icon);
				}
				swipeIcon = msg.querySelector(".swipe-reply-icon");
			}

			// long press for context menu
			state.touchTimeout = setTimeout(() => {
				if (!msg || didSwipe) return;
				openContextMenu(msg, e);
			}, 500);
		});

		chatEl.addEventListener(
			"touchmove",
			(e) => {
				if (!swipeMsg) return;
				// Do not allow swiping while context menu is open
				if (state.isMenuOpen) return;

				const dx = e.touches[0].clientX - swipeStartX;
				const dy = e.touches[0].clientY - swipeStartY;

				// if its more likely verticle, its not swipe
				if (Math.abs(dy) > Math.abs(dx)) return;

				// right swipe only
				if (dx <= 0) return;

				didSwipe = true;
				clearTimeout(state.touchTimeout);
				if (e.cancelable) e.preventDefault();

				const progress = Math.min(dx / SWIPE_THRESHOLD, 1);
				const translate = Math.min(dx * 0.4, SWIPE_THRESHOLD * 0.4);

				swipeMsg.style.translate = `${translate}px 0`;

				if (swipeIcon) {
					swipeIcon.style.opacity = progress;
					// trigger bounce while swiping when threshold is reached
					if (progress >= 1 && !swipeBounced) {
						swipeBounced = true;
						const icon = swipeIcon;
						if (icon) {
							icon.classList.add('visible');
							icon.classList.add('bounce');
							const onEnd = () => {
								if (icon) icon.classList.remove('bounce');
								icon.removeEventListener('animationend', onEnd);
							};
							icon.addEventListener('animationend', onEnd);
						}
					} else if (progress < 1 && swipeBounced) {
						// allow re-bounce if user moves back and re-crosses threshold
						swipeBounced = false;
						if (swipeIcon) swipeIcon.classList.remove('bounce');
					}
				}
			},
			{ passive: false },
		);

		chatEl.addEventListener("touchend", (e) => {
			// if context menu is open, ignore swipe end
			if (state.isMenuOpen) {
				if (e.cancelable) e.preventDefault();
				clearTimeout(state.touchTimeout);
				swipeMsg = null;
				didSwipe = false;
				return;
			}
			clearTimeout(state.touchTimeout);

			if (swipeMsg) {
				const dx = e.changedTouches[0].clientX - swipeStartX;

				swipeMsg.style.translate = "";

				if (dx >= SWIPE_THRESHOLD && didSwipe) {
					// trigger reply immediately; do not add bounce on touchend
					const idx = Number(swipeMsg.dataset.index);
					state.msgIndex = idx;
					state.selectedMsg = swipeMsg;
					replyMessage();

					if (swipeIcon) {
						// remove icon without animating (bounce already handled during touchmove)
						swipeIcon.remove();
						swipeIcon = null;
					}

				} else if (swipeIcon) {
					swipeIcon.remove();
					swipeIcon = null;
				}
			}

			swipeMsg = null;
			didSwipe = false;
		});

		chatEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const msg = e.target.closest(".chat-message");
			if (!msg) return;
			openContextMenu(msg, e);
		});

		chatEl.addEventListener("click", (e) => {
			if (state.isSelecting) {
				const msg = e.target.closest(".chat-message");
				if (!msg) return;
				const idx = Number(msg.dataset.index);
				msg.classList.toggle("selected");
				if (state.selectedMessages.includes(idx)) {
					state.selectedMessages = state.selectedMessages.filter(
						(i) => i !== idx,
					);
				} else {
					state.selectedMessages.push(idx);
				}
				if (state.selectedMessages.length === 0) cancelSelection();
				else updateSelectionCount();
				return;
			}

			const reply = e.target.closest(".chat-reply");
			if (!reply) return;
			const targetMsg = chatEl.querySelector(
				`[data-index="${reply.dataset.replyTo}"]`,
			);
			if (targetMsg) {
				targetMsg.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				highlightMessage(targetMsg);
			}
		});

		chatEl.addEventListener("scroll", () => {
			if (state.isProgrammaticScroll) return;
			const distanceFromBottom =
				chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
			scrollToBottomBtn.classList.toggle(
				"visible",
				distanceFromBottom > 300,
			);

			if (state.pinnedIndexes.length === 0) return;
			for (let i = state.pinnedIndexes.length - 1; i >= 0; i--) {
				const idx = state.pinnedIndexes[i];
				const msg = chatEl.querySelector(`[data-index="${idx}"]`);
				if (!msg) continue;
				const rect = msg.getBoundingClientRect();
				const chatRect = chatEl.getBoundingClientRect();
				if (rect.top >= chatRect.top && rect.top <= chatRect.bottom) {
					pinnedMessageText.dataset.index = idx;
					const msgs = messages[state.contactUserId][idx];
					if (!msgs) return;
					pinnedMessageText.textContent = msgs.text;
					updatePinCount(idx);
					break;
				}
			}
		});
	}

	// ─── Cancel edit / reply / forward ───────────────────────────────────────
	if (cancelEditBtn && msgAction) {
		cancelEditBtn.addEventListener("click", () => {
			state.isEditing = false;
			state.replyTo = null;
			state.isForwarding = false;
			state.forwardingMsg = null;
			state.forwardingMsgs = [];
			resetInput();
		});
	}

	// ─── Pinned message bar ───────────────────────────────────────────────────
	if (pinnedMessageContainer) {
		pinnedMessageContainer.addEventListener("click", () => {
			if (state.pinnedIndexes.length === 0) return;

			const currentIdx = Number(pinnedMessageText.dataset.index);
			const pos = state.pinnedIndexes.indexOf(currentIdx);
			if (pos === -1) return;
			const prevPos =
				(pos - 1 + state.pinnedIndexes.length) %
				state.pinnedIndexes.length;
			const prevIdx = state.pinnedIndexes[prevPos];

			const targetMsg = chatEl.querySelector(
				`[data-index=${currentIdx}]`,
			);
			if (targetMsg) {
				state.isProgrammaticScroll = true;
				targetMsg.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				highlightMessage(targetMsg);

				// when reached to pinned message, show next pinned message in the bar after short delay
				setTimeout(() => {
					state.isProgrammaticScroll = false;
					const msgs = messages[state.contactUserId][prevIdx];
					if (!msgs) return;
					pinnedMessageText.textContent = msgs.text;
					pinnedMessageText.dataset.index = prevIdx;
					pinnedMessageContainer.style.animation = "highlightPin 0.5s";
					setTimeout(
						() => (pinnedMessageContainer.style.animation = ""),
						500,
					);
					updatePinCount(prevIdx);
				}, 800);
			}
		});
	}

	if (pinnedMessageIcon) {
		pinnedMessageIcon.addEventListener("click", (e) => {
			e.stopPropagation();
			openPinnedView();
		});
	}

	if (pinnedViewClose) {
		pinnedViewClose.addEventListener("click", () => {
			pinnedViewDialog.close();
		});
	}

	if (pinnedViewDialog) {
		pinnedViewDialog.addEventListener("click", (e) => {
			if (e.target === pinnedViewDialog) pinnedViewDialog.close();
		});
	}

	// ─── Forward dialog ───────────────────────────────────────────────────────
	if (forwardDialogCloseBtn && forwardDialog) {
		forwardDialogCloseBtn.addEventListener("click", () =>
			forwardDialog.close(),
		);

		forwardDialog.addEventListener("click", (e) => {
			const card = e.target.closest(".forwarded-contact-card");
			if (!card) return;

			const friend = contacts.find(
				(c) => c.id === Number(card.dataset.userId),
			);
			if (!friend) return;

			if (state.isSelectionForwarding) {
				const sourceName =
					contacts.find((c) => c.id === state.contactUserId)?.name ??
					"Unknown";
				executeBulkForward(friend, sourceName);
				return;
			}

			// Single message forward
			const senderName = messages[state.contactUserId][
				Number(state.msgIndex)
			].user
				? "You"
				: contacts.find((c) => c.id === state.contactUserId)?.name;

			chatProfilePic.src =
				friend.profilePics[0] ||
				"../../../public/assets/images/profile.jpeg";
			chatName.textContent = friend.nickname || friend.name;
			openChat(true);
			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				unblockActionBtn[0].style.display = "flex";
				return;
			} else {
				messageContainer.style.display = "flex";
				unblockActionBtn[0].style.display = "none";
			}
			injectMessages(friend.id);

			msgAction.style.display = "flex";
			state.actionPreviewHeight =
				msgAction.getBoundingClientRect().height / 14;
			chatEl.style.paddingBottom =
				basePadding + state.actionPreviewHeight + "rem";
			msgActionText.textContent = "Forwarding message from " + senderName;
			const msgs =
				messages[state.contactUserId][Number(state.msgIndex)];
			if (!msgs) return;
			msgActionmsg.textContent = msgs.text;
			messageInput.style.borderRadius = "0 0 2rem 2rem";
			sendMessageBtn.style.display = "block";
			scrollChatToBottom();

			state.isForwarding = true;
			state.forwardingMsg = buildForwardedMsg(
				msgs,
				friend.id,
			);
			forwardDialog.close();
			state.contactUserId = friend.id;
		});
	}

	// ─── Scroll to bottom ─────────────────────────────────────────────────────
	if (scrollToBottomBtn) {
		scrollToBottomBtn.addEventListener("click", scrollChatToBottom);
	}

	// ─── Undo ─────────────────────────────────────────────────────────────────
	if (undoBtn) {
		undoBtn.addEventListener("click", () => {
			if (state.currentUndoAction) {
				state.currentUndoAction();
				state.currentUndoAction = null;
			}
			toaster.style.opacity = 0;
		});
	}

	// ─── Context menu actions ─────────────────────────────────────────────────
	if (copyMsg[0]) {
		copyMsg[0].addEventListener("click", () => {
			navigator.clipboard.writeText(
				messages[state.contactUserId][Number(state.msgIndex)].text,
			);
			showToast("Message copied", copyIcon);
			closeContextMenu();
		});
	}

	if (editMsg[0]) editMsg[0].addEventListener("click", editMessage);
	if (replyMsg[0]) replyMsg[0].addEventListener("click", replyMessage);
	if (pinMsg[0])
		pinMsg[0].addEventListener("click", () => pinMessage(pinIcon));

	if (deleteMsg[0]) {
		deleteMsg[0].addEventListener("click", () => {
			closeContextMenu();

			const friend = contacts.find((c) => c.id === state.contactUserId);
			const prevLastMessage = friend?.lastMessage;
			const prevLastMessageTime = friend?.lastMessageTime;
			const prevLastMessageSeen = friend?.lastMessageSeen;
			const prevLastMessageDate = friend?.lastMessageDate;

			const { timeout, deletedMsg, idx: deletedIdx } = deleteMessage(state.selectedMsg, state.msgIndex);
			state.deleting = timeout;

			if (friend) {
				const remaining = messages[state.contactUserId].filter(
					(_, i) => i !== Number(state.msgIndex),
				);
				if (remaining.length > 0) {
					const lastMsg = remaining.at(-1);
					friend.lastMessage = lastMsg.text;
					friend.lastMessageTime = lastMsg.time;
					friend.lastMessageDate = lastMsg.date || "";
					friend.lastMessageSeen = lastMsg.user ? lastMsg.isSeen === true : true;
				} else {
					friend.lastMessage = "";
					friend.lastMessageTime = "";
					friend.lastMessageDate = "";
					friend.lastMessageSeen = true;
				}
				refreshCard(friend);
				sortActiveChats();
				sortContacts();
				if (
					!friend.isPinned &&
					friend.unreadCount === 0 &&
					friend.lastMessageSeen === true
				) {
					moveToContacts(friend);
					sortActiveChats();
					sortContacts();
				}
			}

			state.currentUndoAction = () => {
				undoDeleteMessage(state.selectedMsg);

				if (deletedMsg !== undefined) {
					const arr = messages[state.contactUserId];
					arr.splice(deletedIdx, 0, deletedMsg);
					arr.forEach((m, i) => {
						m.index = i;
					});
					state.pinnedIndexes = arr
						.map((m, i) => (m.isPinned ? i : -1))
						.filter((i) => i !== -1);
				}

				if (friend) {
					friend.lastMessage = prevLastMessage;
					friend.lastMessageTime = prevLastMessageTime;
					friend.lastMessageSeen = prevLastMessageSeen;
					friend.lastMessageDate = prevLastMessageDate;

					const isInContacts = contactsContainer.querySelector(
						`[data-user-id="${friend.id}"]`,
					);
					if (isInContacts) {
						moveToActiveChats(friend);
					} else {
						refreshCard(friend);
					}
					sortActiveChats();
					sortContacts();
				}
			};

			showToast("Message deleted", deleteIcon, true);
		});
	}

	if (forwardMsg[0]) {
		forwardMsg[0].addEventListener("click", () => {
			closeContextMenu();
			forwardDialog.querySelector(".forwarded-contact-dialog").innerHTML =
				"";
			contacts.forEach((contact) => {
				forwardDialog
					.querySelector(".forwarded-contact-dialog")
					.appendChild(createForwardedContactCard({ ...contact }));
			});
			forwardDialog.showModal();
		});
	}

	if (selectMsg[0]) {
		selectMsg[0].addEventListener("click", () => {
			enterSelectionMode(Number(state.msgIndex));
			closeContextMenu();
		});
	}

	// ─── Selection toolbar ────────────────────────────────────────────────────
	if (cancelSelectionBtn)
		cancelSelectionBtn.addEventListener("click", cancelSelection);
	if (selectionDeleteBtn)
		selectionDeleteBtn.addEventListener("click", handleBulkDelete);
	if (selectionForwardBtn)
		selectionForwardBtn.addEventListener("click", prepareBulkForward);

	// ─── Chat header → profile ────────────────────────────────────────────────
	if (chatHeader) {
		chatHeader.addEventListener("click", () => {
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (!friend) return;
			openProfile(friend);
		});
	}

	// ─── Profile actions ──────────────────────────────────────────────────────
	if (detailsCloseBtn)
		detailsCloseBtn.addEventListener("click", closeProfile);
	if (deleteChatBtns.length > 0)
		deleteChatBtns.forEach((b) =>
			b.addEventListener("click", handleDeleteChat),
		);
	if (editNameBtns.length > 0)
		editNameBtns.forEach((b) =>
			b.addEventListener("click", handleEditNickname),
		);
	if (editNameDoneBtn.length > 0)
		editNameDoneBtn.forEach((b) =>
			b.addEventListener("click", handleEditNicknameDone),
		);
	if (cancelEditNameBtn.length > 0)
		cancelEditNameBtn.forEach((b) =>
			b.addEventListener("click", handleEditNicknameCancel),
		);
	if (blockContactBtns.length > 0)
		blockContactBtns.forEach((b) =>
			b.addEventListener("click", handleBlockContact),
		);
	if (unblockActionBtn.length > 0)
		unblockActionBtn.forEach((b) =>
			b.addEventListener("click", handleBlockContact),
		);
	if (deleteContactBtns.length > 0)
		deleteContactBtns.forEach((b) =>
			b.addEventListener("click", () => {
				handleDeleteContact();
				updateContactsEmptyState();
			}),
		);

	//  ─── Emoji Picker ───────────────────────────────────────────────────────
	if (emojiBtn && emojiPicker && sendMessageBtn) {
		emojiBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen = emojiPicker.style.display === "block";
			emojiPicker.style.display = isOpen ? "none" : "block";
		});

		emojiPicker.addEventListener("emoji-click", (e) => {
			const emoji = e.detail.unicode;
			const start = savedSelectionStart;
			const end = savedSelectionEnd;
			messageInput.value =
				messageInput.value.slice(0, start) +
				emoji +
				messageInput.value.slice(end);
			savedSelectionStart = savedSelectionEnd = start + emoji.length;
			messageInput.selectionStart = messageInput.selectionEnd =
				savedSelectionStart;
			messageInput.dispatchEvent(new Event("input"));
			emojiPicker.style.display = "none";
			messageInput.focus();

			if (messageInput.value.trim().length > 0) {
				sendMessageBtn.style.display = "block";
			}
		});
	}

	//  ─── Edit profile ───────────────────────────────────────────────────────
	if (editSection) {
		editSection.addEventListener("click", () => {
			settingsList.classList.remove("open");
			openEditProfile(currentUser);
		});
	}

	// ─── Empty state click to send message ─────────────────────────────────────
	if (emptyStateEl) {
		emptyStateEl.addEventListener("click", () => {
			if (!state.contactUserId) return;
			messageInput.value = "hi";
			messageInput.dispatchEvent(new Event("input"));
			sendMessage();
		});
	}

	// ─── Global click ─────────────────────────────────────────────────────────
	document.addEventListener("click", (e) => {
		if (settingsList && (!settingsList.contains(e.target) && (!settingsBtn || !settingsBtn.contains(e.target)))) {
			settingsList.classList.remove("open");
			}
		if (!searchbar.contains(e.target)) {
			searchbar.classList.remove("open");
			searchInput.value = "";
			activeChatsContainer
				.querySelectorAll(".active-chat-wrapper")
				.forEach((w) => (w.style.display = ""));
			contactsContainer
				.querySelectorAll(".contacts-card")
				.forEach((c) => (c.style.display = ""));
		}
		if (
			messageMenu.style.display === "block" &&
			!messageMenu.contains(e.target)
		) {
			closeContextMenu();
		}
		if (
			emojiPicker &&
			!emojiPicker.contains(e.target) &&
			emojiBtn &&
			!emojiBtn.contains(e.target)
		) {
			emojiPicker.style.display = "none";
		}
		activeChatsContainer
			.querySelectorAll(".active-chat-wrapper")
			.forEach((wrapper) => {
				const card = wrapper.querySelector(".active-chat");
				if (!card) return;
				const transform = card.style.transform;
				if (
					transform &&
					transform !== "translateX(0px)" &&
					transform !== ""
				) {
					card.style.transition = "all 0.25s ease";
					card.style.transform = "translateX(0)";
				}
			});
	});
});
