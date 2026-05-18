import {
	updateContact as apiUpdateContact,
	logout as apiLogout,
	getContacts,
	getMe,
} from "./js/api.js";
import { createContactCard } from "../../components/contact-cards/contact-card.js";
import { createActiveChatCard } from "../../components/active-chats/active-chats.js";
import { createArchivedCard } from "../../components/archived/archived-card.js";
import { createForwardedContactCard } from "../../components/contact-cards/contacts-forward.js";
import { state, contacts, messages } from "./js/state.js";
import {
	initToast,
	showToast,
	highlightMessage,
	createEmptyStateEl,
} from "./js/ui.js";
import { makeContactSkeleton, makeActiveChatSkeleton } from "./js/skeleton.js";
import {
	initChat,
	openChat,
	closeChat,
	injectMessages,
	sendMessage,
	resetInput,
	scrollChatToBottom,
	scrollChatToBottomAfterPadding,
	nearBottom,
	loadOlderMessages,
	updatePinCount,
	updatePinnedMessage,
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
import { initCardContextMenu, closeAllSwipes } from "./js/card-context-menu.js";
import { initInAppNotification } from "./js/in-app-notification.js";
import { initSearch, runSearch } from "./js/search.js";
import { initEditProfile, openEditProfile } from "./js/edit-profile.js";
import { initSettings, openSettings, closeSettings } from "./js/settings.js";
import { initAddContact } from "./js/add-contact.js";
import {
	initSocket,
	emitTypingStart,
	emitTypingStop,
	emitMessageSeen,
	getSocket,
} from "./js/socket.js";
import { loadThemeFromStorage } from "../../utils/theme.js";
import { parseSvg } from "../../utils/svg.js";
import { safeSrc, updateThemeImages, observeThemeChanges, createAvatarElement, mountAvatar, refreshUserAvatars } from "../../utils/dom.js";
const _notifQueue = new Set();
// expose to other modules (e.g., chat) for notification deduplication
try { window._notifQueue = _notifQueue; } catch (e) { /* ignore */ }

document.addEventListener("DOMContentLoaded", async function () {
	// Initialize client-side Sentry (loaded from CDN if `window.__SENTRY_DSN__` set)
	(function initClientSentry() {
		try {
			const dsn =
				window.__SENTRY_DSN__ || localStorage.getItem("sentryDsn");
			if (!dsn) return;
			const s = document.createElement("script");
			s.src = "https://browser.sentry-cdn.com/7.66.0/bundle.min.js";
			s.crossOrigin = "anonymous";
			s.onload = () => {
				try {
					if (window.Sentry) {
						window.Sentry.init({ dsn, tracesSampleRate: 0.0 });
						window.Sentry.setTag("app", "rivo-client");
					}
				} catch (e) {
					void e;
				}
			};
			document.head.appendChild(s);

			window.addEventListener("error", (ev) => {
				try {
					if (window.Sentry)
						window.Sentry.captureException(ev.error || ev);
				} catch (e) {
					void e;
				}
			});
			window.addEventListener("unhandledrejection", (ev) => {
				try {
					if (window.Sentry)
						window.Sentry.captureException(ev.reason || ev);
				} catch (e) {
					void e;
				}
			});
		} catch (e) {
			void e;
		}
	})();

	try {
		initInAppNotification();
		// open chat when in-app notification is clicked — use same flow as archived dialog
		document.addEventListener("in-app-notif:open", (e) => {
			try {
				const id = e?.detail?.contactId;
				if (!id) return;
				// Mirror contact-click flow exactly
				const prevFriend = contacts.find((c) => c.id === state.contactUserId);
				if (prevFriend && prevFriend.id !== Number(id)) {
					try {
						const sock = getSocket();
						if (sock && prevFriend.conversationId) {
							sock.emit("conversation:leave", {
								conversationId: prevFriend.conversationId,
							});
						}
					} catch (err) {
						/* ignore */
					}

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

				state.contactUserId = Number(id);
				const friend = contacts.find((c) => c.id === state.contactUserId);
				if (!friend) return;

				// join the new conversation room so server considers us present
				try {
					const sock = getSocket();
					if (sock && friend.conversationId)
						sock.emit("conversation:join", {
							conversationId: friend.conversationId,
						});
				} catch (e) {
					/* ignore */
				}

				if (friend.unreadCount > 0) {
					friend.lastMessageSeen = true;
				}
				friend.unreadCount = 0;
				updateTotalUnreadCount();

				// remember where this card came from so undo/delete logic can restore correctly
				friend._previousContainer = "contacts";
				const existingCard = activeChatsContainer.querySelector(
					`[data-user-id="${friend.id}"]`,
				);
				if (existingCard) {
					const wrapper =
						existingCard.closest(".active-chat-wrapper") ??
						existingCard;
					wrapper.replaceWith(createActiveChatCard(friend));
				} else {
					// remove from contacts list if present and append to active
					const card = document.querySelector(`[data-user-id="${friend.id}"]`);
					if (card) card.remove();
					activeChatsContainer.appendChild(createActiveChatCard(friend));
				}

				mountAvatar(chatProfilePicture, {
					name: friend.name,
					nickname: friend.nickname,
					profilePics: friend.profilePics,
					className: 'chat-profile-picture',
					isOnline: friend.isOnline,
				});
				chatName.textContent = friend.nickname || friend.name;
				closeSettings();
				openChat(true);
				if (friend.conversationId) {
					emitMessageSeen(friend.conversationId);
				}
				scrollChatToBottom();

				if (friend.isBlocked) {
					messageContainer.style.display = "none";
					const _ub = unblockActionBtn[0];
					if (_ub) _ub.style.display = "flex";
				} else {
					messageContainer.style.display = "flex";
					const _ub = unblockActionBtn[0];
					if (_ub) _ub.style.display = "none";
				}
				if (window.innerWidth <= 700) {
					chatPart.style.display = "flex";
					peoplePart.style.display = "none";
				}
			} catch (err) {
				// ignore
			}
		});
	} catch (e) {
		// ignore init errors
	}

	// Rely on HttpOnly cookie for auth; if user info not present, ask server for current user.
	let currentUser = null;
	try {
		const stored = localStorage.getItem("user");
		currentUser = stored ? JSON.parse(stored) : null;
	} catch (e) {
		currentUser = null;
	}
	if (!currentUser || !currentUser.id) {
		try {
			const me = await getMe();
			if (me && me.id) {
				localStorage.setItem("user", JSON.stringify(me));
				currentUser = me;
			} else {
				window.location.href = "../auth/auth.html";
				return;
			}
		} catch (e) {
			window.location.href = "../auth/auth.html";
			return;
		}
	}

	// Theme
	const theme = localStorage.getItem("rivo-theme") || "light";
	if (theme === "dark") document.body.classList.add("dark-mode");

	loadThemeFromStorage();

	// Ensure any static/default profile images reflect the active theme
	try { updateThemeImages(); observeThemeChanges(); } catch (e) { /* ignore */ }

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
	const archiveContactBtns = document.querySelectorAll("#archive-contact-btn")
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
	const settingsDeleteAccount = document.getElementById(
		"settings-delete-account",
	);
	const settingsChangePassword = document.getElementById(
		"settings-change-password",
	);
	const settingsChangePasswordForm = document.getElementById(
		"settings-change-password-form",
	);
	const settingsCurrentPassword = document.getElementById(
		"settings-current-password",
	);
	const settingsNewPassword = document.getElementById(
		"settings-new-password",
	);
	const settingsConfirmPassword = document.getElementById(
		"settings-confirm-password",
	);
	const settingsChangePasswordSubmit = document.getElementById(
		"settings-change-password-submit",
	);
	const settingsSendResetEmail = document.getElementById(
		"settings-send-reset-email",
	);
	const settingsPrivacyOnline = document.getElementById(
		"settings-privacy-online",
	);
	const settingsPrivacyEmail = document.getElementById(
		"settings-privacy-email",
	);
	const settingsPrivacyProfile = document.getElementById(
		"settings-privacy-profile",
	);
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
	const settingsAccentRow = document.getElementById("settings-accent-row");
	const settingsAccentPanel = document.getElementById(
		"settings-accent-panel",
	);
	const settingsAccentPicker = document.getElementById(
		"settings-accent-picker",
	);
	const settingsAccentValue = document.getElementById(
		"settings-accent-value",
	);
	const settingsWallpaperRow = document.getElementById(
		"settings-wallpaper-row",
	);
	const settingsWallpaperPanel = document.getElementById(
		"settings-wallpaper-panel",
	);
	const settingsWallpaperInput = document.getElementById(
		"settings-wallpaper-input",
	);
	const settingsWallpaperUpload = document.getElementById(
		"settings-wallpaper-upload",
	);
	const settingsWallpaperRemove = document.getElementById(
		"settings-wallpaper-remove",
	);
	const settingsWallpaperValue = document.getElementById(
		"settings-wallpaper-value",
	);
	const archivedDialog = document.getElementById("archived-dialog");
	const archivedDialogClose = document.getElementById(
		"archived-dialog-close",
	);
	const archivedDialogList = document.getElementById("archived-dialog-list");

	// ─── SVG icons ────────────────────────────────────────────────────────────
	const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></g></svg>`;
	const deleteIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8 9h8v10H8zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
	const pinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="currentColor" d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"/></svg>`;
	const replyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M10 9V5l-7 7l7 7v-4.1c5 0 8.5 1.6 11 5.1c-1-5-4-10-11-10"/></svg>`;
	const archiveIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M20.54 5.23L19.13 3.81A2 2 0 0 0 17.72 3H6.28A2 2 0 0 0 4.87 3.81L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 17l-5-5h3V9h4v3h3z"/></svg>`;
	const savedIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3l7 3V5c0-1.1-.9-2-2-2z"/></svg>`;

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

	// ─── other variables ─────────────────────────────────────────────────────
	let _typingTimeout = null;
	let _suppressNextClick = false;

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
		onContactAction: _onContactAction,
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

	// Robust overlay handlers: immediate close on single tap/click
	if (chatOverlay) {
		chatOverlay.addEventListener("click", (e) => {
			if (state.isMenuOpen) {
				_suppressNextClick = false;
				closeContextMenu();
				if (e && typeof e.stopPropagation === "function")
					e.stopPropagation();
			}
		});

		chatOverlay.addEventListener(
			"touchend",
			(e) => {
				if (state.isMenuOpen) {
					_suppressNextClick = false;
					closeContextMenu();
					if (e && e.cancelable) e.preventDefault();
				}
			},
			{ passive: false },
		);
	}

	initSelection({
		chatEl,
		messageContainer,
		selectionToolbar,
		selectionCount,
		forwardDialog,
		selectionDeleteBtn,
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
		if (action === "archive") {
			_archiveContact(userId);
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
			mountAvatar(chatProfilePicture, {
				name: contact.name,
				nickname: contact.nickname,
				profilePics: contact.profilePics,
				className: 'chat-profile-picture',
				isOnline: contact.isOnline,
			});
			chatName.textContent = contact.nickname || contact.name;
			openChat(true);
			if (contact.conversationId) {
				emitMessageSeen(contact.conversationId);
			}
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
	initSettings(
		{
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
			settingsAccentRow,
			settingsAccentPanel,
			settingsAccentPicker,
			settingsAccentValue,
			settingsWallpaperRow,
			settingsWallpaperPanel,
			settingsWallpaperInput,
			settingsWallpaperUpload,
			settingsWallpaperRemove,
			settingsWallpaperValue,
			onOpenArchived: _openArchivedDialog,
		},
		currentUser,
	);
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
			const normalized = {
				...newContact,
				contactId: newContact.contact?.id,
				conversationId: newContact.conversationId,
				profilePics: newContact.contact?.profilePics || [],
				name: newContact.nickname || newContact.contact?.name || "",
				username: newContact.contact?.username || "",
				isOnline: newContact.contact?.isOnline || false,
				lastSeen: newContact.contact?.lastSeen || null,
				bio: newContact.contact?.bio || "",
				email: newContact.contact?.email || "",
				lastMessage: "",
				lastMessageTime: null,
				lastMessageDate: null,
				unreadCount: 0,
				lastMessageSeen: true,
				_previousContainer: "contacts",
			};

			// keep in-memory list in sync
			contacts.push(normalized);

			const _sock = getSocket();
			if (_sock && normalized.conversationId) {
				_sock.emit("conversation:join", {
					conversationId: normalized.conversationId,
				});
			}

			updateContactsEmptyState();

			// build card from the normalized object so it has profile/name/bio filled
			const card = createContactCard(
				{ ...normalized, hasMessages: false },
				_onContactAction,
			);
			contactsContainer.appendChild(card);

			// set chat header immediately so opening the chat shows correct info
			mountAvatar(chatProfilePicture, {
				name: normalized.name,
				nickname: normalized.nickname,
				profilePics: normalized.profilePics,
				className: 'chat-profile-picture',
				isOnline: normalized.isOnline,
			});
			chatName.textContent = normalized.nickname || normalized.name;

			state.contactUserId = normalized.id;
			openChat(true);
			if (normalized.conversationId) {
				emitMessageSeen(normalized.conversationId);
			}
		},
	);

	// Handler invoked when server notifies that a user's profile changed
	function _handleUserUpdated(user) {
		try {
			// Keep in-memory contact objects in sync
			for (const c of contacts) {
				if (c.id === user.id) {
					c.profilePics = user.profilePics || [];
					if (user.name) c.name = user.name;
					if (user.username) c.username = user.username;
					if (user.username) c.nickname = user.username;
				}
			}
			// Update DOM avatars immediately
			try { refreshUserAvatars(user); } catch (e) { /* ignore */ }

			// If the currently open chat is with this user, update header
			if (state.contactUserId && Number(state.contactUserId) === Number(user.id)) {
				const friend = contacts.find((c) => c.id === Number(user.id));
				if (friend && typeof chatName !== 'undefined' && chatName) {
					chatName.textContent = friend.nickname || friend.name || "";
				}
			}
		} catch (e) {
			/* ignore handler failures */
		}
	}

	initSocket(
		// new message
		(msg) => receiveMessage(msg),
		// edit
		(data) => {
			// Locate the message across all conversations to keep in-memory state consistent
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
			userMsgs[foundIndex].text = data.text;
			userMsgs[foundIndex].isEdited = true;
			// If this edited message is the conversation's last message, update contact preview
			const friend = contacts.find((c) => c.id === foundUserId);
			if (friend && foundIndex === userMsgs.length - 1) {
				friend.lastMessage = data.text;
				refreshCard(friend);
				sortActiveChats();
				sortContacts();
			}
			if (state.contactUserId === foundUserId) {
				const msgEl = document.querySelector(
					`.chat-message[data-index="${foundIndex}"]`,
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
			// preserve the removed message so we can adjust unread counters
			const removedMsg = userMsgs[foundIndex];
			userMsgs.splice(foundIndex, 1);

			// If the deleted message was incoming and unseen, decrement unread
			// so the contact preview reflects the deletion.
			try {
				const friend = contacts.find((c) => c.id === foundUserId);
				if (friend && removedMsg && !removedMsg.user && !removedMsg.isSeen) {
					friend.unreadCount = Math.max(0, (friend.unreadCount || 0) - 1);
					updateTotalUnreadCount();
				}
			} catch (e) {
				// ignore
			}

			// If this conversation is open, re-render messages so indexes stay correct
			if (state.contactUserId === foundUserId) {
				injectMessages(foundUserId);
				// Refresh pinned banner after messages re-rendered
				try {
					updatePinnedMessage();
				} catch (e) {
					/* ignore */
				}
			}

			// Update contact card last-message preview
			const friend = contacts.find((c) => c.id === foundUserId);
			if (friend) {
				if (userMsgs.length > 0) {
					const lastMsg = userMsgs.at(-1);
					friend.lastMessage = lastMsg.text;
					friend.lastMessageTime = lastMsg.time;
					friend.lastMessageDate = lastMsg.date || "";
					friend.lastMessageSeen = lastMsg.user
						? lastMsg.isSeen === true
						: true;
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
				if (contact.isSaved) return; // saved messages don't show online status
				chatProfilePicture.classList.add("online");
			}
			refreshCard(contact);
		},
		// offline
		(userId, lastSeen) => {
			const contact = contacts.find((c) => c.contactId === userId);
			if (!contact) return;
			if (contact.isSaved) return; // saved messages don't show online status
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
		},
		_handleUserUpdated
	);

	// Rejoin active conversation after socket reconnect and emit leave on unload
	try {
		const sock = getSocket();
		if (sock) {
			sock.on("connect", () => {
				try {
					const friend = contacts.find(
						(c) => c.id === state.contactUserId,
					);
					if (friend && friend.conversationId) {
						sock.emit("conversation:join", {
							conversationId: friend.conversationId,
						});
					}
				} catch (e) {
					// ignore
				}
			});
		}
		window.addEventListener("beforeunload", () => {
			try {
				const friend = contacts.find(
					(c) => c.id === state.contactUserId,
				);
				if (friend && friend.conversationId) {
					const s = getSocket();
					if (s)
						s.emit("conversation:leave", {
							conversationId: friend.conversationId,
						});
				}
			} catch (e) {
				/* ignore */
			}
		});
	} catch (e) {
		/* ignore */
	}

	function updateContactsEmptyState() {
		const empty = document.getElementById("contacts-empty");
		if (!empty) return;
		empty.style.display = contacts.length === 0 ? "flex" : "none";
	}

	function _onContactAction(action, userId) {
		state.contactUserId = userId;
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;
		if (friend.isSaved) return;
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
		if (action === "archive") {
			if (friend.isArchived) {
				_unarchiveContact(userId);
			} else {
				_archiveContact(userId);
			}
		}
	}

	function openPinnedView() {
		pinnedViewList.textContent = "";

		if (state.pinnedIndexes.length === 0) {
			const empty = document.createElement("p");
			empty.className = "pinned-view-empty";
			empty.textContent = "No pinned messages";
			pinnedViewList.appendChild(empty);
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

			const meta = document.createElement("div");
			meta.className = "pinned-view-item-meta";
			const sender = document.createElement("span");
			sender.className = "pinned-view-item-sender";
			sender.textContent = msg.user
				? "You"
				: friend?.nickname || friend?.name || "";
			const time = document.createElement("span");
			time.className = "pinned-view-item-time";
			time.textContent = msg.time;
			meta.appendChild(sender);
			meta.appendChild(time);

			const text = document.createElement("p");
			text.className = "pinned-view-item-text";
			text.textContent = msg.text || "";

			item.appendChild(meta);
			item.appendChild(text);

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

	// ─── Inject initial cards (show skeletons while loading) ────────────────
	try {
		// show skeleton placeholders
		if (contactsContainer) {
			contactsContainer
				.querySelectorAll(".skeleton-placeholder")
				.forEach((n) => n.remove());
			contactsContainer.appendChild(makeContactSkeleton(6));
			contactsContainer.setAttribute("aria-busy", "true");
		}
		if (activeChatsContainer) {
			activeChatsContainer
				.querySelectorAll(".skeleton-placeholder")
				.forEach((n) => n.remove());
			activeChatsContainer.appendChild(makeActiveChatSkeleton(4));
			activeChatsContainer.setAttribute("aria-busy", "true");
		}

		const serverContacts = await getContacts();
		serverContacts.forEach((c) => {
			contacts.push({
				...c,
				name: c.isSaved
					? "Saved Messages"
					: c.nickname || c.contact?.name || "",
				username: c.isSaved ? "" : c.contact?.username || "",
				profilePics: c.isSaved ? [] : c.contact?.profilePics || [],
				isOnline: c.isSaved ? false : c.contact?.isOnline || false,
				lastSeen: c.isSaved ? null : c.contact?.lastSeen || null,
				bio: c.isSaved ? "" : c.contact?.bio || "",
				email: c.isSaved ? "" : c.contact?.email || "",
				contactId: c.isSaved ? c.ownerId : c.contact?.id || null,
				isSaved: c.isSaved ?? false,
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
				_previousContainer: "contacts",
			});
		});
	} catch (err) {
		console.error("Failed to load contacts", err);
	}

	// remove skeleton placeholders before rendering real cards
	if (contactsContainer) {
		contactsContainer
			.querySelectorAll(".skeleton-placeholder")
			.forEach((n) => n.remove());
		contactsContainer.removeAttribute("aria-busy");
	}
	if (activeChatsContainer) {
		activeChatsContainer
			.querySelectorAll(".skeleton-placeholder")
			.forEach((n) => n.remove());
		activeChatsContainer.removeAttribute("aria-busy");
	}
	contacts.forEach((contact) => {
		if (contact.isArchived) return;
		if (contact.isSaved) {
			// saved message is always in active chat
			const card = createActiveChatCard(contact);
			card.dataset.saved = "true";
			activeChatsContainer.prepend(card); // first in list
			return;
		}
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
			try {
				getSocket()?.disconnect();
			} catch (e) {
				// ignore
			}
			// Try to unsubscribe from push before logging out
			try {
				if (window.pushUnsubscribe) await window.pushUnsubscribe();
			} catch (e) {
				// push unsubscribe failed (suppressed)
			}
			await apiLogout();
			window.location.href = "../auth/auth.html";
		});
	}

	// ─── Close chat ───────────────────────────────────────────────────────────
	if (closeChatBtn) {
		closeChatBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			chatEl.textContent = "";
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (friend) {
				if (friend.isSaved) { closeChat(); return; }
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
				// leave previous conversation room if any
				try {
					const sock = getSocket();
					if (sock && prevFriend.conversationId) {
						sock.emit("conversation:leave", {
							conversationId: prevFriend.conversationId,
						});
					}
				} catch (e) {
					/* ignore */
				}
				// local-only `isInChat` removed; nothing to persist
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

			// join the new conversation room so server considers us present
			try {
				const sock = getSocket();
				if (sock && friend.conversationId)
					sock.emit("conversation:join", {
						conversationId: friend.conversationId,
					});
			} catch (e) {
				/* ignore */
			}

			if (friend.unreadCount > 0) {
				friend.lastMessageSeen = true;
			}
			friend.unreadCount = 0;
			// local-only `isInChat` removed; no state to set here
			const unreadEl = active.querySelector(
				".active-chat-unread-messages",
			);
			if (unreadEl) unreadEl.style.opacity = "0";
			updateTotalUnreadCount();

			if (friend.isSaved) {
				// hide any current avatar element and show saved-icon
				const _imgEl = chatProfilePicture.querySelector('img, .contact-profile, .initial-avatar');
				if (_imgEl) _imgEl.style.display = "none";
				chatProfilePicture.classList.add("saved-icon");
				const existingSavedIcon = chatProfilePicture.querySelector(
					".saved-icon-svg",
				);
				if (existingSavedIcon) existingSavedIcon.remove();
				const _savedIcon = parseSvg(savedIconSvg);
				if (_savedIcon) {
					_savedIcon.classList.add("saved-icon-svg");
					chatProfilePicture.appendChild(_savedIcon);
				}
				if (_imgEl && _imgEl.tagName && _imgEl.tagName.toLowerCase() === 'img') _imgEl.src = "";
			} else {
				// ensure avatar container shows avatar and remove saved icon
				const _imgEl = chatProfilePicture.querySelector('img, .contact-profile, .initial-avatar');
				if (_imgEl) _imgEl.style.display = "";
				chatProfilePicture.classList.remove("saved-icon");
				const existingSavedIcon = chatProfilePicture.querySelector(
					".saved-icon-svg",
				);
				if (existingSavedIcon) existingSavedIcon.remove();
				mountAvatar(chatProfilePicture, {
					name: friend.name,
					nickname: friend.nickname,
					profilePics: friend.profilePics,
					className: 'chat-profile-picture',
					isOnline: friend.isOnline,
				});
			}
			chatName.textContent = friend.nickname || friend.name;
			openChat(true);
			if (friend.conversationId) {
				emitMessageSeen(friend.conversationId);
			}
			scrollChatToBottom();

			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "flex";
			} else {
				messageContainer.style.display = "flex";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "none";
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
				// leave previous conversation room if any
				try {
					const sock = getSocket();
					if (sock && prevFriend.conversationId) {
						sock.emit("conversation:leave", {
							conversationId: prevFriend.conversationId,
						});
					}
				} catch (e) {
					/* ignore */
				}
				// local-only `isInChat` removed
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

			// join the new conversation room so server considers us present
			try {
				const sock = getSocket();
				if (sock && friend.conversationId)
					sock.emit("conversation:join", {
						conversationId: friend.conversationId,
					});
			} catch (e) {
				/* ignore */
			}

			if (friend.unreadCount > 0) {
				friend.lastMessageSeen = true;
			}
			friend.unreadCount = 0;
			// local-only `isInChat` removed; no-op
			updateTotalUnreadCount();

			// remember where this card came from so undo/delete logic can restore correctly
			friend._previousContainer = "contacts";
			card.remove();
			activeChatsContainer.appendChild(createActiveChatCard(friend));

						mountAvatar(chatProfilePicture, {
							name: friend.name,
							nickname: friend.nickname,
							profilePics: friend.profilePics,
							className: 'chat-profile-picture',
							isOnline: friend.isOnline,
						});
			chatName.textContent = friend.nickname || friend.name;
			openChat(true);

			if (friend.conversationId) {
				emitMessageSeen(friend.conversationId);
			}
			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "flex";
			} else {
				messageContainer.style.display = "flex";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "none";
			}
			scrollChatToBottom();
		});
	}

	// ─── Message input ────────────────────────────────────────────────────────
	if (messageInput && sendMessageBtn && chatEl && messageContainer) {
		messageInput.addEventListener("input", () => {
			const wasNearBottom = nearBottom(chatEl);

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

			// If the user was near the bottom before input changed, keep the
			// view pinned after padding updates. Wait for the padding
			// transition to finish so scrollHeight reflects the final value.
			if (wasNearBottom) scrollChatToBottomAfterPadding();

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
					// insert svg safely
					const s = parseSvg(replyIcon);
					if (s) icon.appendChild(s.cloneNode(true));
					msg.appendChild(icon);
				}
				swipeIcon = msg.querySelector(".swipe-reply-icon");
			}

			// long press for context menu
			state.touchTimeout = setTimeout(() => {
				if (!msg || didSwipe) return;
				openContextMenu(msg, e);
				_suppressNextClick = true;
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
							icon.classList.add("visible");
							icon.classList.add("bounce");
							const onEnd = () => {
								if (icon) icon.classList.remove("bounce");
								icon.removeEventListener("animationend", onEnd);
							};
							icon.addEventListener("animationend", onEnd);
						}
					} else if (progress < 1 && swipeBounced) {
						// allow re-bounce if user moves back and re-crosses threshold
						swipeBounced = false;
						if (swipeIcon) swipeIcon.classList.remove("bounce");
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
			if (_suppressNextClick) {
				_suppressNextClick = false;
				return;
			}
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
			// Try to locate by message id first (new format), fallback to index (legacy)
			const targetMsg =
				chatEl.querySelector(
					`[data-message-id="${reply.dataset.replyTo}"]`,
				) ||
				chatEl.querySelector(`[data-index="${reply.dataset.replyTo}"]`);
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
			// load older messages when user scrolls to top area
			if (chatEl.scrollTop <= 60) {
				loadOlderMessages();
			}
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
					pinnedMessageContainer.style.animation =
						"highlightPin 0.5s";
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
						mountAvatar(chatProfilePicture, {
							name: friend.name,
							nickname: friend.nickname,
							profilePics: friend.profilePics,
							className: 'chat-profile-picture',
							isOnline: friend.isOnline,
						});
			chatName.textContent = friend.nickname || friend.name;
			openChat(true);
			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "flex";
				return;
			} else {
				messageContainer.style.display = "flex";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "none";
			}
			injectMessages(friend.id);

			msgAction.style.display = "flex";
			state.actionPreviewHeight =
				msgAction.getBoundingClientRect().height / 14;
			chatEl.style.paddingBottom =
				basePadding + state.actionPreviewHeight + "rem";
			msgActionText.textContent = "Forwarding message from " + senderName;
			const msgs = messages[state.contactUserId][Number(state.msgIndex)];
			if (!msgs) return;
			msgActionmsg.textContent = msgs.text;
			messageInput.style.borderRadius = "0 0 2rem 2rem";
			sendMessageBtn.style.display = "block";
			scrollChatToBottom();

			state.isForwarding = true;
			state.forwardingMsg = buildForwardedMsg(msgs, friend.id);
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

			const {
				timeout,
				deletedMsg,
				idx: deletedIdx,
			} = deleteMessage(state.selectedMsg, state.msgIndex);
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
					friend.lastMessageSeen = lastMsg.user
						? lastMsg.isSeen === true
						: true;
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
			forwardDialog.querySelector(
				".forwarded-contact-dialog",
			).textContent = "";
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
			if (friend.isSaved) return; // saved messages has no profile
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

	if (archiveContactBtns.length > 0)
		archiveContactBtns.forEach((btn) =>
			btn.addEventListener("click", () => {
				const friend = contacts.find(
					(c) => c.id === state.contactUserId,
				);
				if (!friend) return;
				_onContactAction("archive", friend.id);
				state.skipShowChatOnProfileClose = true;
				closeProfile();
				setTimeout(() => closeChat(), 350);
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

	// ─── Archived ──────────────────────────────────────────────────
	async function _archiveContact(userId) {
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;

		try {
			await apiUpdateContact(friend.id, { isArchived: true });
			friend.isArchived = true;

			// حذف از DOM
			const card =
				activeChatsContainer.querySelector(
					`[data-wrapper-user-id="${userId}"]`,
				) ||
				activeChatsContainer
					.querySelector(`[data-user-id="${userId}"]`)
					?.closest(".active-chat-wrapper") ||
				contactsContainer.querySelector(`[data-user-id="${userId}"]`);
			card?.remove();

			updateContactsEmptyState();
			showToast("Chat archived", archiveIcon);
		} catch (err) {
			console.error("Failed to archive contact", err);
			showToast("Failed to archive chat");
		}
	}

	async function _unarchiveContact(userId) {
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;

		try {
			await apiUpdateContact(friend.id, { isArchived: false });
			friend.isArchived = false;

			if (
				friend.isPinned ||
				friend.unreadCount > 0 ||
				friend.lastMessageSeen === false
			) {
				activeChatsContainer.appendChild(createActiveChatCard(friend));
				sortActiveChats();
			} else {
				contactsContainer.appendChild(
					createContactCard(
						{ ...friend, hasMessages: !!friend.lastMessage },
						_onContactAction,
					),
				);
				sortContacts();
			}

			updateContactsEmptyState();
			showToast("Chat unarchived", archiveIcon);
		} catch (err) {
			console.error("Failed to unarchive contact", err);
			showToast("Failed to unarchive chat");
		}
	}

	function _openArchivedDialog() {
		if (!archivedDialog) return;

		archivedDialogList.innerHTML = "";

		const archivedContacts = contacts.filter((c) => c.isArchived);

		if (archivedContacts.length === 0) {
			const empty = document.createElement("p");
			empty.className = "archived-dialog-empty";
			empty.textContent = "No archived chats";
			archivedDialogList.appendChild(empty);
		} else {
			archivedContacts.forEach((contact) => {
				archivedDialogList.appendChild(
					createArchivedCard(
						contact,
						(id) => {
							// Unarchive
							_unarchiveContact(id);
							const card = archivedDialogList.querySelector(
								`[data-user-id="${id}"]`,
							);
							card?.remove();
							if (
								!archivedDialogList.querySelector(
									".archived-card",
								)
							) {
								const empty = document.createElement("p");
								empty.className = "archived-dialog-empty";
								empty.textContent = "No archived chats";
								archivedDialogList.appendChild(empty);
							}
						},
						(id) => {
							// Open chat
							archivedDialog.close();
							closeSettings();
							const friend = contacts.find((c) => c.id === id);
							if (!friend) return;
							state.contactUserId = id;
							mountAvatar(chatProfilePicture, {
								name: friend.name,
								nickname: friend.nickname,
								profilePics: friend.profilePics,
								className: 'chat-profile-picture',
								isOnline: friend.isOnline,
							});
							chatName.textContent =
								friend.nickname || friend.name;
							openChat(true);
							if (friend.conversationId) {
								emitMessageSeen(friend.conversationId);
							}
							scrollChatToBottom();

							if (friend.isBlocked) {
								messageContainer.style.display = "none";
								const _ub = unblockActionBtn[0];
								if (_ub) _ub.style.display = "flex";
							} else {
								messageContainer.style.display = "flex";
								const _ub = unblockActionBtn[0];
								if (_ub) _ub.style.display = "none";
							}
							if (window.innerWidth <= 700) {
								chatPart.style.display = "flex";
								peoplePart.style.display = "none";
							}
						},
					),
				);
			});
		}

		archivedDialog.showModal();
	}

	if (archivedDialogClose) {
		archivedDialogClose.addEventListener("click", () => {
			archivedDialog?.close();
		});
	}

	archivedDialog?.addEventListener("click", (e) => {
		if (e.target === archivedDialog) archivedDialog.close();
	});

	document.addEventListener("contact:unarchived", (e) => {
		_unarchiveContact(e.detail.id);
	});

	// ─── Global click ─────────────────────────────────────────────────────────
	document.addEventListener("click", (e) => {
		if (
			settingsList &&
			!settingsList.contains(e.target) &&
			(!settingsBtn || !settingsBtn.contains(e.target))
		) {
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
			// If the user tapped the overlay, close immediately even if we are
			// suppressing the next click (this happens after long-press).
			if (
				chatOverlay &&
				(e.target === chatOverlay || chatOverlay.contains(e.target))
			) {
				_suppressNextClick = false;
				closeContextMenu();
				return;
			}
			if (_suppressNextClick) {
				_suppressNextClick = false;
				return;
			}
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
		closeAllSwipes();
	});

	// prevent pinch zoom and double tap zoom on mobile devices for better UX
	document.addEventListener(
		"touchmove",
		function (e) {
			if (e.touches.length > 1) e.preventDefault();
		},
		{ passive: false },
	);
	document.addEventListener(
		"gesturestart",
		function (e) {
			e.preventDefault();
		},
		{ passive: false },
	);
	document.addEventListener(
		"gesturechange",
		function (e) {
			e.preventDefault();
		},
		{ passive: false },
	);

	document.addEventListener(
		"gestureend",
		function (e) {
			e.preventDefault();
		},
		{ passive: false },
	);
	let lastTap = 0;

	document.addEventListener(
		"touchend",
		function (e) {
			const now = Date.now();
			if (now - lastTap < 300) {
				e.preventDefault();
			}
			lastTap = now;
		},
		{ passive: false },
	);
});
