import {
	updateContact as apiUpdateContact,
	logout as apiLogout,
	getContacts,
	getMe,
	deleteAccount,
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
	sendOneTimeMessage,
	sendTimeCapsuleMessage,
	handleCapsuleOpened,
	resetInput,
	scrollChatToBottom,
	scrollChatToBottomAfterPadding,
	nearBottom,
	nearTop,
	clearOpenSuppression,
	loadOlderMessages,
		updatePinCount,
		updatePinnedMessage,
		updatePinnedData,
		getPinnedData,
		scrollToPinnedMessage,
	basePadding,
	lineHeight,
	maxLines,
	maxHeight,
	receiveMessage,
	handleMessagesSeen,
	handleOnetimeDeleted,
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
import {
	initInAppNotification,
	showNotification,
} from "./js/in-app-notification.js";
import { initSearch, runSearch } from "./js/search.js";
import { initEditProfile, openEditProfile } from "./js/edit-profile.js";
import { initSettings, openSettings, closeSettings } from "./js/settings.js";
import { initAddContact } from "./js/add-contact.js";
import {
	initSocket,
	emitTypingStart,
	emitTypingStop,
	getSocket,
	emitReaction,
	setOnetimeDeletedHandler,
	setCapsuleOpenedHandler,
} from "./js/socket.js";
import { applyReactionsToMessage } from "../../components/messages/messages.js";
// findMessageById imported via chat/state when needed
import { loadThemeFromStorage } from "../../utils/theme.js";
import { parseSvg } from "../../utils/svg.js";
import {
	updateThemeImages,
	observeThemeChanges,
	mountAvatar,
	refreshUserAvatars,
} from "../../utils/dom.js";
import { getCurrentUser } from "./js/currentUser.js";
const _notifQueue = new Set();
// expose to other modules (e.g., chat) for notification deduplication
try {
	window._notifQueue = _notifQueue;
} catch (e) {
	/* ignore */
}

document.addEventListener("DOMContentLoaded", async function () {
	// Initialize client-side Sentry (loaded from CDN if `window.__SENTRY_DSN__` set)
	(function initClientSentry() {
		try {
			const dsn =
				window.__SENTRY_DSN__ || localStorage.getItem("sentryDsn");
			if (!dsn) return;
			const s = document.createElement("script");
			s.src = "/js/bundle.min.js";
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
		document.addEventListener("in-app-notif:open", async (e) => {
			try {
				const id = e?.detail?.contactId;
				const messageId = e?.detail?.messageId || null;
				if (!id) return;
				// Mirror contact-click flow exactly
				const prevFriend = contacts.find(
					(c) => c.id === state.contactUserId,
				);
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
						!prevFriend.isSaved &&
						prevFriend.unreadCount === 0 &&
						prevFriend.lastMessageSeen !== false
					) {
						moveToContacts(prevFriend);
						sortActiveChats();
						sortContacts();
					}
				}

				state.contactUserId = Number(id);
				const friend = contacts.find(
					(c) => c.id === state.contactUserId,
				);
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
					const card = document.querySelector(
						`[data-user-id="${friend.id}"]`,
					);
					if (card) card.remove();
					activeChatsContainer.appendChild(
						createActiveChatCard(friend),
					);
				}

				mountAvatar(chatProfilePicture, {
					name: friend.name,
					nickname: friend.nickname,
					profilePics: friend.profilePics,
					className: "chat-profile-picture",
					isOnline: friend.isOnline,
				});
				try {
					const chatProfileWrapper =
						document.querySelector(".chat-profile");
					if (chatProfileWrapper)
						chatProfileWrapper.setAttribute(
							"data-user-id",
							String(friend.id),
						);
				} catch (e) {
					/* ignore */
				}
				chatName.textContent = friend.nickname || friend.name;
				closeSettings();
				try {
					await openChat(true);
				} catch (e) { /* ignore */ }

				// If notification supplied a messageId, try to scroll to it after messages load
				if (messageId) {
					let attempts = 0;
					const tryScroll = () => {
						const el = document.querySelector(`.chat-message[data-message-id="${messageId}"]`);
						if (el) {
							el.scrollIntoView({ behavior: 'smooth', block: 'center' });
							try { highlightMessage(el); } catch (e) { /* ignore */ }
						} else if (attempts < 6) {
							attempts++;
							setTimeout(tryScroll, 500);
						}
					};
					tryScroll();
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
	let currentUser = getCurrentUser();
	if (!currentUser || !currentUser.id) {
		try {
			const me = await getMe();
			if (me && me.id) {
				// store only non-sensitive fields
				const safeUser = {
					id: me.id,
					name: me.name || "",
					username: me.username || "",
					nickname: me.nickname || me.username || "",
					profilePics: me.profilePics || [],
					isSaved: me.isSaved || false,
					isOnline: me.isOnline || false,
					conversationId: me.conversationId || null,
					bio: me.bio || "",
					email: me.email || "",
				};
				localStorage.setItem("user", JSON.stringify(safeUser));
				currentUser = safeUser;
			} else {
				window.location.href = "/auth/auth.html";
				return;
			}
		} catch (e) {
			window.location.href = "/auth/auth.html";
			return;
		}
	}

	// Theme
	const theme = localStorage.getItem("rivo-theme") || "light";
	if (theme === "dark") document.body.classList.add("dark-mode");

	loadThemeFromStorage();

	// Ensure any static/default profile images reflect the active theme
	try {
		updateThemeImages();
		observeThemeChanges();
	} catch (e) {
		/* ignore */
	}

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
	const archiveContactBtns = document.querySelectorAll(
		"#archive-contact-btn",
	);
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

	// Delete account dialog elements
	const deleteAccountDialog = document.getElementById(
		"delete-account-dialog",
	);
	const deleteAccountPassword = document.getElementById(
		"delete-account-password",
	);
	const deleteAccountError = document.getElementById("delete-account-error");
	const deleteAccountCancel = document.getElementById(
		"delete-account-cancel",
	);
	const deleteAccountConfirm = document.getElementById(
		"delete-account-confirm",
	);

	// Delete account dialog listeners
	deleteAccountCancel?.addEventListener("click", () => {
		try {
			deleteAccountDialog.close();
		} catch (e) {
			/* ignore */
		}
		if (deleteAccountPassword) deleteAccountPassword.value = "";
		if (deleteAccountError) deleteAccountError.textContent = "";
	});

	deleteAccountConfirm?.addEventListener("click", async () => {
		const password =
			(deleteAccountPassword &&
				deleteAccountPassword.value &&
				deleteAccountPassword.value.trim()) ||
			"";
		if (!password) {
			if (deleteAccountError)
				deleteAccountError.textContent = "Please enter your password.";
			return;
		}
		if (deleteAccountError) deleteAccountError.textContent = "";
		if (deleteAccountConfirm) deleteAccountConfirm.disabled = true;

		try {
			const res = await deleteAccount(password);
			if (res?.success) {
				window.location.href = "/auth/auth.html";
			} else {
				if (deleteAccountError)
					deleteAccountError.textContent =
						res?.error || "Incorrect password.";
				if (deleteAccountConfirm) deleteAccountConfirm.disabled = false;
			}
		} catch (err) {
			if (deleteAccountError)
				deleteAccountError.textContent = "Connection error.";
			if (deleteAccountConfirm) deleteAccountConfirm.disabled = false;
		}
	});

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
	// Local overlay flag for one-time long-press UI (do not store in shared state)
	let oneTimeOverlayActive = false;
	// client-side throttle for typing emits (ms)
	let _lastTypingEmit = 0;
	const TYPING_CLIENT_THROTTLE_MS = 800;
	// search debounce
	let _searchDebounce = null;
	let _lastSearchQuery = "";

	// ─── Init all modules ─────────────────────────────────────────────────────
	initToast({ toaster, messageContainer, toastMessage, toastIcon, undoBtn });

	initChat({
		chatPart,
		mainContent,
		peoplePart,
		chatEl,
		contactsContainer,
		activeChatsContainer,
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
		scrollToBottomBtn,
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
		// Do not allow actions that would move or modify the Saved Messages card
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
		onMessageClick: async (contact, msgIndex) => {
			searchbar.classList.remove("open");
			searchInput.value = "";
			runSearch("");

			state.contactUserId = contact.id;
			mountAvatar(chatProfilePicture, {
				name: contact.name,
				nickname: contact.nickname,
				profilePics: contact.profilePics,
				className: "chat-profile-picture",
				isOnline: contact.isOnline,
			});
			try {
				const chatProfileWrapper =
					document.querySelector(".chat-profile");
				if (chatProfileWrapper)
					chatProfileWrapper.setAttribute(
						"data-user-id",
						String(contact.id),
					);
			} catch (_e) {
				/* ignore */
			}
			chatName.textContent = contact.nickname || contact.name;
			try { await openChat(true); } catch (e) { /* ignore */ }

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
		async (newContact) => {
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
				className: "chat-profile-picture",
				isOnline: normalized.isOnline,
			});
			try {
				const chatProfileWrapper =
					document.querySelector(".chat-profile");
				if (chatProfileWrapper)
					chatProfileWrapper.setAttribute(
						"data-user-id",
						String(normalized.id),
					);
			} catch (e) {
				/* ignore */
			}
			chatName.textContent = normalized.nickname || normalized.name;

			state.contactUserId = normalized.id;
			try { await openChat(true); } catch (e) { /* ignore */ }

			// Ensure the send input and unblock action reflect the contact's
			// blocked state immediately after adding.
			if (normalized.isBlocked) {
				messageContainer.style.display = "none";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "flex";
			} else {
				messageContainer.style.display = "flex";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "none";
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
					// If the server anonymized this account (delete flow) it will set
					// `name` to "Deleted account" and replace username/email with
					// generated placeholders like `deleted_user_<id>_<ts>` / `@deleted.rivo`.
					// We should not display those garbled values in the UI — clear them.
					const isDeletedAccount =
						user.name &&
						String(user.name).toLowerCase() === "deleted account";
					const isAnonUsername =
						user.username &&
						String(user.username).startsWith("deleted_user_");
					const isAnonEmail =
						user.email &&
						String(user.email).endsWith("@deleted.rivo");
					if (isDeletedAccount || isAnonUsername || isAnonEmail) {
						c.username = "";
						c.email = "";
					} else {
						if (user.username) c.username = user.username;
						if (user.email) c.email = user.email;
					}
					// Do not overwrite a user's custom local `nickname` when the
					// remote user updates their profile. `nickname` is a local-only
					// field set by the current user and must not be clobbered.
				}
			}
			// Update DOM avatars immediately
			try {
				refreshUserAvatars(user);
			} catch (e) {
				/* ignore */
			}

			// If the currently open chat is with this user, update header
			if (
				state.contactUserId &&
				Number(state.contactUserId) === Number(user.id)
			) {
				const friend = contacts.find((c) => c.id === Number(user.id));
				if (friend && typeof chatName !== "undefined" && chatName) {
					chatName.textContent = friend.nickname || friend.name;
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
				const lastMsg = userMsgs.at(-1);
				friend.lastMessage =
					lastMsg &&
					lastMsg.isTimeCapsule &&
					lastMsg.isLocked &&
					!lastMsg.user
						? ""
						: lastMsg?.text || "";
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
			// Ensure pinnedData cache reflects deletions
			try { updatePinnedData(Number(foundUserId), data.messageId, removedMsg, false); } catch (e) {}

			// If the deleted message was incoming and unseen, decrement unread
			// so the contact preview reflects the deletion.
			try {
				const friend = contacts.find((c) => c.id === foundUserId);
				if (
					friend &&
					removedMsg &&
					!removedMsg.user &&
					!removedMsg.isSeen
				) {
					friend.unreadCount = Math.max(
						0,
						(friend.unreadCount || 0) - 1,
					);
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
					friend.lastMessage =
						lastMsg &&
						lastMsg.isTimeCapsule &&
						lastMsg.isLocked &&
						!lastMsg.user
							? ""
							: lastMsg.text || "";
					friend.lastMessageTime = lastMsg.time;
					friend.lastMessageDate = lastMsg.date || "";
					friend.lastMessageTs = lastMsg.createdAt;
					// Only explicit false means unseen
					friend.lastMessageSeen = lastMsg.user
						? lastMsg.isSeen !== false
						: true;
				} else {
					friend.lastMessage = "";
					friend.lastMessageTime = "";
					friend.lastMessageDate = "";
					friend.lastMessageTs = 0;
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
					try { updatePinnedData(Number(uid), messageId, msgs[idx], isPinned); } catch (e) {}
					if (state.contactUserId === Number(uid)) {
						injectMessages(Number(uid));
					}
					break;
				}
			}
		},
		_handleUserUpdated,
		// contact removed handler
		(payload) => {
			try {
				const partnerUserId =
					payload?.contactUserId ||
					payload?.userId ||
					payload?.contactId;
				if (!partnerUserId) return;
				const idx = contacts.findIndex(
					(c) => c.contactId === partnerUserId,
				);
				if (idx === -1) return;
				const removed = contacts.splice(idx, 1)[0];
				// remove DOM card if present
				const card = document.querySelector(
					`[data-user-id="${removed.id}"]`,
				);
				if (card) card.remove();
				updateContactsEmptyState();
				// if this conversation is currently open, close it
				if (state.contactUserId === removed.id) {
					try {
						closeChat();
					} catch (e) {
						/* ignore */
					}
				}
				updateTotalUnreadCount();
				sortActiveChats();
				sortContacts();
			} catch (e) {
				/* ignore handler errors */
			}
		},
		// onReactionUpdated
		({ messageId, reactions, actorId, emoji, action }) => {
			const currentUser = getCurrentUser();
			const currentUserId = currentUser?.id || null;

			// Update reactions in messages array and capture which conversation/user it belongs to
			let foundUserId = null;
			let belongsToMe = false;
			for (const [uid, msgs] of Object.entries(messages)) {
				if (!Array.isArray(msgs)) continue;
				// Compare IDs as strings to avoid type-mismatch (number vs string)
				const idx = msgs.findIndex(
					(m) => String(m.id) === String(messageId),
				);
				if (idx !== -1) {
					foundUserId = Number(uid);
					msgs[idx].reactions = reactions;
					belongsToMe = !!msgs[idx].user;
					break;
				}
			}

			// Update DOM message elements for this messageId
			document
				.querySelectorAll(
					`.chat-message[data-message-id="${messageId}"]`,
				)
				.forEach((msgEl) => {
					try {
						applyReactionsToMessage(
							msgEl,
							reactions,
							currentUserId,
						);
					} catch (e) {
						/* ignore */
					}
				});

			// Notification logic:
			// - Do NOT show a local toast for my own reaction.
			// - Show an in-app notification for others reacting to my message
			//   only when I'm NOT currently viewing that conversation.
			try {
				if (action !== "removed") {
					const actorNum = Number(actorId);
					// Skip local toast entirely for my own actions
					if (actorNum !== Number(currentUserId)) {
						// Only notify if the reaction was on one of my messages
						// and the conversation is not currently open.
						if (
							belongsToMe &&
							state.contactUserId !== foundUserId
						) {
							let reactorContact = contacts.find(
								(c) =>
									Number(c.contactId) === actorNum ||
									Number(c.id) === actorNum,
							);
							if (!reactorContact) {
								const possible =
									contacts.find(
										(c) => c.conversationId === foundUserId,
									) || {};
								reactorContact = {
									id: possible.id || actorNum,
									contactId: possible.contactId || actorNum,
									name:
										possible.nickname ||
										possible.name ||
										"Someone",
									nickname:
										possible.nickname ||
										possible.name ||
										"Someone",
									profilePics: possible.profilePics || [],
								};
							}
							try {
								showNotification(reactorContact, {
									text: `${reactorContact.nickname || reactorContact.name || "Someone"} reacted ${emoji} to your message`,
								});
							} catch (e) {
								/* ignore */
							}
						}
					}
				}
			} catch (e) {
				// Protect notification path from crashing the handler (errors suppressed)
			}
		},
	);
	// Wire one-time-deleted events from socket to chat handler
	try {
		setOnetimeDeletedHandler(handleOnetimeDeleted);
	} catch (e) {
		/* ignore */
	}
	try {
		setCapsuleOpenedHandler(handleCapsuleOpened);
	} catch (e) {
		/* ignore */
	}
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
		// Show placeholder when there are no contacts
		empty.style.display =
			Array.isArray(contacts) && contacts.length > 0 ? "none" : "flex";
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

		const allPinned = getPinnedData(state.contactUserId);
		const friend = contacts.find((c) => c.id === state.contactUserId);

		let source = [];
		if (Array.isArray(allPinned) && allPinned.length > 0) {
			source = allPinned.slice().reverse();
		} else if (Array.isArray(state.pinnedIndexes) && state.pinnedIndexes.length > 0) {
			const msgs = messages[state.contactUserId] || [];
			source = [...state.pinnedIndexes].reverse().map((idx) => msgs[idx]).filter(Boolean);
		}

		if (source.length === 0) {
			const empty = document.createElement("p");
			empty.className = "pinned-view-empty";
			empty.textContent = "No pinned messages";
			pinnedViewList.appendChild(empty);
			pinnedViewDialog.showModal();
			return;
		}

		source.forEach((msg) => {
			if (!msg) return;

			const item = document.createElement("div");
			item.className = "pinned-view-item";

			const meta = document.createElement("div");
			meta.className = "pinned-view-item-meta";
			const sender = document.createElement("span");
			sender.className = "pinned-view-item-sender";
			const senderLabel = (msg.senderId && Number(msg.senderId) === Number(getCurrentUser()?.id)) ? 'You' : (friend?.nickname || friend?.name || '');
			sender.textContent = senderLabel;
			const time = document.createElement("span");
			time.className = "pinned-view-item-time";
			time.textContent = msg.time || (msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
			meta.appendChild(sender);
			meta.appendChild(time);

			const text = document.createElement("p");
			text.className = "pinned-view-item-text";
			text.textContent = msg.text || "";

			item.appendChild(meta);
			item.appendChild(text);

			item.addEventListener("click", async () => {
				pinnedViewDialog.close();
				// If item from pinnedData has id, use scrollToPinnedMessage
				if (msg.id) {
					try {
						await scrollToPinnedMessage(msg.id);
						const msgEl = chatEl.querySelector(`[data-message-id="${msg.id}"]`);
						if (msgEl) {
							highlightMessage(msgEl);
						}
					} catch (e) {
						/* ignore */
					}
					return;
				}

				// Fallback for index-based source
				if (typeof msg.index !== 'undefined') {
					const msgEl = chatEl.querySelector(`[data-index="${msg.index}"]`);
					if (!msgEl) return;
					state.isProgrammaticScroll = true;
					msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
					setTimeout(() => {
						state.isProgrammaticScroll = false;
					}, 800);
					highlightMessage(msgEl);
				}
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
				lastMessage: (() => {
					const lastMsg = c.conversation?.messages?.[0];
					if (!lastMsg) return "";
					const isFromPartner = lastMsg.senderId !== currentUser?.id;
					if (lastMsg.isTimeCapsule) {
						// still locked for recipient -> hide preview
						if (lastMsg.isLocked && isFromPartner) return "";
						// opened on server -> if server provided plaintext show it,
						// otherwise show neutral placeholder
						if (lastMsg.openedAt && isFromPartner) {
							if (lastMsg.text) return lastMsg.text;
							return 'Time capsule unlocked';
						}
					}
					return lastMsg.text || "";
				})(),
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
				lastMessageTs: c.conversation?.messages?.[0]
					? new Date(c.conversation.messages[0].createdAt).getTime()
					: 0,
				unreadCount: c.unreadCount ?? 0,
				lastMessageSeen: (() => {
					const lastMsg = c.conversation?.messages?.[0];
					if (!lastMsg) return true;
					// Treat missing/undefined `isSeen` as already seen. Only
					// mark as unseen when `isSeen === false` explicitly.
					return lastMsg.isSeen !== false;
				})(),
				_previousContainer: "contacts",
			});
		});

		// If the service worker posts messages (push click), handle them and open the conversation
		try {
			if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
				navigator.serviceWorker.addEventListener('message', (ev) => {
					try {
						const data = ev.data || {};
						if (data && data.type === 'push:click') {
							const payload = data.payload || {};
							const convId = payload.conversationId || payload.conversationId;
							const messageId = payload.messageId || null;
							if (!convId) return;
							const contact = contacts.find((x) => String(x.conversationId) === String(convId));
							if (contact) {
								document.dispatchEvent(new CustomEvent('in-app-notif:open', { detail: { contactId: contact.id, messageId } }));
							}
						}
					} catch (e) { /* ignore */ }
				});
			}
		} catch (e) { /* ignore */ }

		// Handle deep link via query params (e.g. opened by notificationclick opening a URL)
		try {
			const params = new URLSearchParams(window.location.search);
			const convParam = params.get('conversationId');
			const midParam = params.get('messageId');
			if (convParam) {
				const contact = contacts.find((x) => String(x.conversationId) === String(convParam));
				if (contact) {
					document.dispatchEvent(new CustomEvent('in-app-notif:open', { detail: { contactId: contact.id, messageId: midParam ? Number(midParam) : null } }));
				}
			}
		} catch (e) { /* ignore */ }
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
			const q = searchInput.value.trim().toLowerCase();
			// avoid duplicate queries
			if (q === _lastSearchQuery) return;
			clearTimeout(_searchDebounce);
			_searchDebounce = setTimeout(() => {
				_lastSearchQuery = q;
				// require minimal query length to avoid expensive scans
				if (!q || q.length < 2) {
					runSearch("");
					return;
				}
				runSearch(q).catch(() => {});
			}, 250);
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
			window.location.href = "/auth/auth.html";
		});
	}

	// ─── Close chat ───────────────────────────────────────────────────────────
	if (closeChatBtn) {
		closeChatBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			chatEl.textContent = "";
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (friend) {
				if (friend.isSaved) {
					closeChat();
					return;
				}
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
		activeChatsContainer.addEventListener("click", async (e) => {
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
					!prevFriend.isSaved &&
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
				const _imgEl = chatProfilePicture.querySelector(
					"img, .contact-profile, .initial-avatar",
				);
				if (_imgEl) _imgEl.style.display = "none";
				chatProfilePicture.classList.add("saved-icon");
				const existingSavedIcon =
					chatProfilePicture.querySelector(".saved-icon-svg");
				if (existingSavedIcon) existingSavedIcon.remove();
				const _savedIcon = parseSvg(savedIconSvg);
				if (_savedIcon) {
					_savedIcon.classList.add("saved-icon-svg");
					chatProfilePicture.appendChild(_savedIcon);
				}
				if (
					_imgEl &&
					_imgEl.tagName &&
					_imgEl.tagName.toLowerCase() === "img"
				)
					_imgEl.src = "";
			} else {
				// ensure avatar container shows avatar and remove saved icon
				const _imgEl = chatProfilePicture.querySelector(
					"img, .contact-profile, .initial-avatar",
				);
				if (_imgEl) _imgEl.style.display = "";
				chatProfilePicture.classList.remove("saved-icon");
				const existingSavedIcon =
					chatProfilePicture.querySelector(".saved-icon-svg");
				if (existingSavedIcon) existingSavedIcon.remove();
				mountAvatar(chatProfilePicture, {
					name: friend.name,
					nickname: friend.nickname,
					profilePics: friend.profilePics,
					className: "chat-profile-picture",
					isOnline: friend.isOnline,
				});
				try {
					const chatProfileWrapper =
						document.querySelector(".chat-profile");
					if (chatProfileWrapper)
						chatProfileWrapper.setAttribute(
							"data-user-id",
							String(friend.id),
						);
				} catch (e) {
					/* ignore */
				}
			}
			chatName.textContent = friend.nickname || friend.name;
			try { await openChat(true); } catch (e) { /* ignore */ }

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
		contactsContainer.addEventListener("click", async (e) => {
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
					!prevFriend.isSaved &&
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
				className: "chat-profile-picture",
				isOnline: friend.isOnline,
			});
			try {
				const chatProfileWrapper =
					document.querySelector(".chat-profile");
				if (chatProfileWrapper)
					chatProfileWrapper.setAttribute(
						"data-user-id",
						String(friend.id),
					);
			} catch (e) {
				/* ignore */
			}
			chatName.textContent = friend.nickname || friend.name;
			try { await openChat(true); } catch (e) { /* ignore */ }
			if (friend.isBlocked) {
				messageContainer.style.display = "none";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "flex";
			} else {
				messageContainer.style.display = "flex";
				const _ub = unblockActionBtn[0];
				if (_ub) _ub.style.display = "none";
			}
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

			// typing emit (client-side throttled)
			const _contact = contacts.find((c) => c.id === state.contactUserId);
			if (_contact?.conversationId) {
				const now = Date.now();
				if (now - _lastTypingEmit > TYPING_CLIENT_THROTTLE_MS) {
					try {
						emitTypingStart(_contact.conversationId);
					} catch (e) {
						/* ignore */
					}
					_lastTypingEmit = now;
				}
				clearTimeout(_typingTimeout);
				_typingTimeout = setTimeout(() => {
					try {
						emitTypingStop(_contact.conversationId);
					} catch (e) {
						/* ignore */
					}
				}, 2000);
			}
		});

		messageInput.addEventListener("blur", () => {
			savedSelectionStart = messageInput.selectionStart;
			savedSelectionEnd = messageInput.selectionEnd;
		});

		// Capture original send button icon so we can swap it temporarily
		const originalSendBtnInner = sendMessageBtn
			? sendMessageBtn.innerHTML
			: null;
		const oneTimeSendIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" stroke-dasharray="47 10" stroke-linecap="round" stroke-dashoffset="-5"/><text x="12" y="16.5" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">1</text></svg>`;

		// Timestamp until which the immediate release click after activating the
		// long-press overlay should be suppressed. Shared between the long-press
		// handler and the general send action so we can allow a subsequent click
		// to send normally once this window passes.
		let oneTimeIgnoreClickUntil = 0;
		let suppressNextSendClick = false;

		function performSendActionFromUI(e) {
			if (e && typeof e.preventDefault === "function") {
				e.preventDefault();
			}
			// If we recently activated the one-time overlay, swallow the immediate
			// release click so the user doesn't accidentally send the message.
			if (suppressNextSendClick) {
				suppressNextSendClick = false;
				return;
			}
			// If long-press overlay is active, suppress the immediate release click
			if (oneTimeOverlayActive) {
				// If still inside the short suppression window, ignore click so the
				// floating action can be tapped. Otherwise, dismiss the overlay and
				// proceed to a normal send.
				if (Date.now() < oneTimeIgnoreClickUntil) {
					return;
				} else {
					try {
						document.dispatchEvent(new Event("chat:closed"));
					} catch (e) {
						/* ignore */
					}
					// continue to normal send
				}
			}
			// If user selected one-time mode, send as one-time and reset UI
			if (state.sendMode === "time-capsule") {
				const sf = window._pendingCapsuleScheduledFor || null;
				if (!sf) {
					try {
						showToast("No unlock time set for Time Capsule");
					} catch (e) {}
					state.sendMode = "normal";
					window._pendingCapsuleScheduledFor = null;
					if (sendMessageBtn && originalSendBtnInner)
						sendMessageBtn.innerHTML = originalSendBtnInner;
					return;
				}
				try {
					sendTimeCapsuleMessage(sf);
				} catch (err) {
					/* ignore */
				}
				state.sendMode = "normal";
				window._pendingCapsuleScheduledFor = null;
				if (sendMessageBtn && originalSendBtnInner)
					sendMessageBtn.innerHTML = originalSendBtnInner;
				return;
			}
			if (state.sendMode === "one-time") {
				try {
					sendOneTimeMessage();
				} catch (err) {
					/* ignore */
				}
				// reset to default mode after sending
				state.sendMode = "normal";
				if (sendMessageBtn && originalSendBtnInner)
					sendMessageBtn.innerHTML = originalSendBtnInner;
				return;
			}
			// Normal send
			try {
				sendMessage();
			} catch (err) {
				/* ignore */
			}
		}

		sendMessageBtn.addEventListener("click", (e) =>
			performSendActionFromUI(e),
		);
		// One-time message: long-press on send button
		(function initOneTimePress() {
			if (!sendMessageBtn || !messageContainer) return;

			// Slot ordering: [main, top-popup, bottom-popup]
			let sendModeSlots = ["normal", "time-capsule", "one-time"];

			const capsuleSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7.5C8 5.57 9.57 4 11.5 4H12.5C14.43 4 16 5.57 16 7.5V10" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="15" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M12 15V13.8M12 15L13 15.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
			const MODE_ICON = {
				"normal": () => originalSendBtnInner || "",
				"one-time": () => oneTimeSendIcon,
				"time-capsule": () => capsuleSvg,
			};
			const MODE_LABEL = {
				"normal": "Send normally",
				"one-time": "One-time message",
				"time-capsule": "Time Capsule",
			};

			function applyMainSlot() {
				const mode = sendModeSlots[0];
				state.sendMode = mode;
				const icon = MODE_ICON[mode];
				if (icon && sendMessageBtn) sendMessageBtn.innerHTML = icon();
			}

			function renderPopup() {
				const topMode = sendModeSlots[1];
				const botMode = sendModeSlots[2];
				if (capsuleBtn) capsuleBtn.innerHTML = MODE_ICON[topMode]?.() || "";
				if (capsuleLabel) capsuleLabel.textContent = MODE_LABEL[topMode] || "";
				if (onetimeBtn) onetimeBtn.innerHTML = MODE_ICON[botMode]?.() || "";
				if (onetimeLabel) onetimeLabel.textContent = MODE_LABEL[botMode] || "";
			}

			function swapWithMain(slotIdx) {
				// If main was time-capsule, clear its pending state
				if (sendModeSlots[0] === "time-capsule") {
					window._pendingCapsuleScheduledFor = null;
				}
				[sendModeSlots[0], sendModeSlots[slotIdx]] =
					[sendModeSlots[slotIdx], sendModeSlots[0]];
				applyMainSlot();
				try { renderPopup(); } catch (e) { /* ignore */ }
			}

			function resetSlots() {
				sendModeSlots = ["normal", "time-capsule", "one-time"];
				window._pendingCapsuleScheduledFor = null;
				state.sendMode = "normal";
				if (sendMessageBtn && originalSendBtnInner) sendMessageBtn.innerHTML = originalSendBtnInner;
			}

			// Ensure main slot reflects initial mode
			applyMainSlot();

			let pressTimer = null;
			let onetimeWrap = null;
			let onetimeBtn = null;
			let onetimeLabel = null;
			let triggerContainer = null;
			let capsuleWrap = null;
			let capsuleBtn = null;
			let capsuleLabel = null;
			let triggered = false;

			function showOneTime() {
				// Sync slots with actual state (fix out-of-sync slot state after send)
				if (sendModeSlots[0] !== state.sendMode) {
					const idx = sendModeSlots.indexOf(state.sendMode);
					if (idx > 0) {
						const tmp = sendModeSlots[0];
						sendModeSlots[0] = sendModeSlots[idx];
						sendModeSlots[idx] = tmp;
					} else {
						resetSlots();
					}
				}

				// Guard against creating multiple overlays if one already exists.
				if (
					triggerContainer ||
					messageContainer.querySelector(".send-trigger-popup")
				)
					return;
				triggered = true;
				// Mark that the one-time overlay is active so we can suppress the
				// immediate release click and allow the user to tap the floating btn.
				oneTimeOverlayActive = true;
				oneTimeIgnoreClickUntil = Date.now() + 300;
				// Also explicitly suppress the immediate next send click (the
				// pointerup/click that follows the long-press) so releasing doesn't
				// accidentally send the message.
				suppressNextSendClick = true;
				// Show overlay (reuse existing chat overlay)
				if (chatOverlay) {
					chatOverlay.style.display = "block";
					chatOverlay.style.opacity = "0.6";
					chatOverlay.style.zIndex = "498";
				}
				// Bring send area above overlay
				messageContainer.style.zIndex = "501";

				// Single parent container — holds both buttons
				triggerContainer = document.createElement("div");
				triggerContainer.className = "send-trigger-popup";
				// Create wrapper and floating button with label
				onetimeWrap = document.createElement("div");
				onetimeWrap.className = "onetime-trigger";

				onetimeLabel = document.createElement("span");
				onetimeLabel.className = "onetime-trigger-label";
				// If any special send mode is active (one-time or time-capsule),
				// offer a quick "Send normally" hint; otherwise show the one-time hint.
				onetimeLabel.textContent =
					state.sendMode !== "normal"
						? "Send normally"
						: "One-time message";

				onetimeBtn = document.createElement("button");
				onetimeBtn.type = "button";
				onetimeBtn.className = "onetime-trigger-btn";
				onetimeBtn.setAttribute(
					"aria-label",
					state.sendMode !== "normal"
						? "Send normally"
						: "Send as one-time message",
				);
				// Show floating button content. Use specific mode checks so the
				// correct floating icon swaps with the main send icon.
				if (state.sendMode === "one-time" && originalSendBtnInner) {
				    onetimeBtn.innerHTML = originalSendBtnInner;
				} else {
				    onetimeBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
					    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2"
						    stroke-dasharray="47 10" stroke-linecap="round" stroke-dashoffset="-5"/>
					    <text x="12" y="16.5" text-anchor="middle" font-size="9.5"
						    font-weight="700" fill="currentColor">1</text>
					    </svg>`;
				}

				// clicking the label should behave like clicking the one-time button
				onetimeLabel.addEventListener("click", (e) => {
					e.stopPropagation();
					onetimeBtn.click();
				});

				// Time Capsule button (sits ABOVE one-time button)
				capsuleBtn = document.createElement("button");
				capsuleBtn.type = "button";
				capsuleBtn.className =
					"onetime-trigger-btn capsule-trigger-btn";
				capsuleBtn.setAttribute("aria-label", "Send as Time Capsule");
				// Show capsule icon or swap-in the main send icon when time-capsule is active
				if (state.sendMode === "time-capsule" && originalSendBtnInner) {
					capsuleBtn.innerHTML = originalSendBtnInner;
				} else {
					capsuleBtn.innerHTML = capsuleSvg;
				}

				capsuleLabel = document.createElement("span");
				capsuleLabel.className = "onetime-trigger-label";
				capsuleLabel.textContent = "Time Capsule";

				// trigger rendering uses slot model; see renderPopup/swapWithMain

				capsuleWrap = document.createElement("div");
				capsuleWrap.className = "onetime-trigger capsule-trigger";
				capsuleWrap.appendChild(capsuleLabel);
				capsuleWrap.appendChild(capsuleBtn);


				// Capsule click: open datetime picker (attach while capsuleBtn is in scope)
				function toLocalDatetimeInputValue(d) {
					const pad = (n) => String(n).padStart(2, "0");
					return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
				}

				const openCapsulePicker = (slotIndex, e) => {
					if (e && e.stopPropagation) e.stopPropagation();
					hideOneTime();

					const pickerWrap = document.createElement("div");
					pickerWrap.className = "capsule-picker-wrap";
					pickerWrap.innerHTML = `
						<div class="capsule-picker-dialog">
							<div class="capsule-picker-title">⏳ Set unlock time</div>
							<input id="capsule-datetime-input" class="capsule-datetime-input" type="datetime-local" />
							<div class="capsule-picker-actions">
								<button type="button" id="capsule-cancel">Cancel</button>
								<button type="button" id="capsule-confirm">Set &amp; Arm 💣</button>
							</div>
						</div>
					`;

					// Set min = now +5 minutes, max = now +1 year (minute-precision: ignore seconds)
					const truncateToMinute = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0);
					const nowTrunc = truncateToMinute(new Date());
					const minDate = new Date(nowTrunc.getTime() + 5 * 60 * 1000);
					const maxDate = new Date(nowTrunc.getTime() + 365 * 24 * 60 * 60 * 1000);
					const dtInput = pickerWrap.querySelector(
						"#capsule-datetime-input",
					);
					dtInput.min = toLocalDatetimeInputValue(minDate);
					dtInput.max = toLocalDatetimeInputValue(maxDate);
					dtInput.value = toLocalDatetimeInputValue(minDate);

					document.body.appendChild(pickerWrap);

					pickerWrap
						.querySelector("#capsule-cancel")
						.addEventListener("click", () => {
							pickerWrap.remove();
						});

					pickerWrap
						.querySelector("#capsule-confirm")
						.addEventListener("click", () => {
							const val = dtInput.value;
							if (!val) return;
							const sfLocal = new Date(val);
							const truncateToMinute = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0);
							const scheduledTrunc = truncateToMinute(sfLocal);
							const nowTrunc2 = truncateToMinute(new Date());
							const minTime = new Date(nowTrunc2.getTime() + 5 * 60 * 1000);
							const maxTime = new Date(nowTrunc2.getTime() + 365 * 24 * 60 * 60 * 1000);
							if (
								isNaN(scheduledTrunc.getTime()) ||
								scheduledTrunc < minTime ||
								scheduledTrunc > maxTime
							) {
								try {
									showToast(
										"Selected time out of range (min +5 minutes, max +1 year)",
									);
								} catch (e) {}
								return;
							}
							const scheduledFor = scheduledTrunc.toISOString();
							pickerWrap.remove();

							// swap the chosen slot with main and set pending scheduled time
							const prevMain = sendModeSlots[0];
							sendModeSlots[0] = 'time-capsule';
							sendModeSlots[slotIndex] = prevMain;
							state.sendMode = 'time-capsule';
							window._pendingCapsuleScheduledFor = scheduledFor;
							if (sendMessageBtn) sendMessageBtn.innerHTML = capsuleSvg;
							try { renderPopup(); } catch (e) { /* ignore */ }
						});
				};

				capsuleBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					if (sendModeSlots[1] === 'time-capsule') {
						openCapsulePicker(1, e);
					} else {
						swapWithMain(1);
						hideOneTime();
					}
				});
				// clicking the label/area should behave same as clicking the button
				capsuleWrap.addEventListener("click", (e) => {
					// if clicked directly on the button, its handler already ran; otherwise open/swap
					if (e.target === capsuleBtn) return;
					if (sendModeSlots[1] === 'time-capsule') openCapsulePicker(1, e);
					else { swapWithMain(1); hideOneTime(); }
				});

				onetimeWrap.appendChild(onetimeLabel);
				onetimeWrap.appendChild(onetimeBtn);
				// Ensure popup icons/labels reflect current slot ordering
				try { renderPopup(); } catch (e) { /* ignore */ }
				// group both trigger buttons into a single container to simplify
				// outside-click handling and DOM management
				triggerContainer.appendChild(capsuleWrap);
				triggerContainer.appendChild(onetimeWrap);
				messageContainer.appendChild(triggerContainer);

				onetimeBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					if (sendModeSlots[2] === 'time-capsule') {
						openCapsulePicker(2, e);
					} else {
						swapWithMain(2);
						hideOneTime();
					}
				});
			}

			function hideOneTime() {
				triggered = false;
				oneTimeOverlayActive = false;
				clearTimeout(pressTimer);
				pressTimer = null;

				if (chatOverlay) {
					chatOverlay.style.display = "none";
					chatOverlay.style.opacity = "0";
					chatOverlay.style.zIndex = "";
				}
				messageContainer.style.zIndex = "";
				if (triggerContainer && triggerContainer.parentNode) {
					triggerContainer.parentNode.removeChild(triggerContainer);
				}
				triggerContainer = null;
				onetimeWrap = null;
				onetimeBtn = null;
				onetimeLabel = null;
				capsuleWrap = null;
				capsuleBtn = null;
				capsuleLabel = null;
				oneTimeIgnoreClickUntil = 0;
				suppressNextSendClick = false;

				// do not reset canonical sendMode here; chat close handler will reset slots
			}

			// Ensure overlay and one-time UI are hidden when chat is closed elsewhere
			document.addEventListener("chat:closed", () => {
				try {
					if (triggered) hideOneTime();
					oneTimeOverlayActive = false;
					// reset slot ordering and canonical send mode when chat fully closes
					try { resetSlots(); } catch (_e) { /* ignore */ }
				} catch (e) {
					/* ignore */
				}
			});

			// Pointer events (works for both mouse and touch)
			sendMessageBtn.addEventListener("pointerdown", () => {
				if (state.isMenuOpen) return;
				// Do not start another long-press while overlay is active
				if (oneTimeOverlayActive) return;
				pressTimer = setTimeout(() => {
					showOneTime();
				}, 500);
			});

			sendMessageBtn.addEventListener("pointerup", () => {
				if (!triggered) clearTimeout(pressTimer);
			});

			sendMessageBtn.addEventListener("pointerleave", () => {
				if (!triggered) clearTimeout(pressTimer);
			});

			// Dismiss when clicking overlay or anywhere outside. Ignore the
			// immediate click that often follows the long-press release so the
			// floating action remains available for the user to tap.
			document.addEventListener("click", (e) => {
				if (!triggered) return;
				// If user clicked the trigger container itself, let its handler run.
				if (triggerContainer && triggerContainer.contains(e.target)) return;
				// Ignore the synthetic/initial release click that may occur
				// right after the long-press activation.
				if (Date.now() < oneTimeIgnoreClickUntil) return;
				if (sendMessageBtn.contains(e.target)) return;
				hideOneTime();
			});

			// Capsule click handler attached inside showOneTime() where it is created

			// Also dismiss if chat overlay is tapped
			if (chatOverlay) {
				chatOverlay.addEventListener("click", () => {
					if (triggered) hideOneTime();
				});
			}
		})();
		messageInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 700) {
				e.preventDefault();
				performSendActionFromUI(e);
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

		// Delegated click handler for reaction badges
		chatEl.addEventListener("click", async (e) => {
			const badge = e.target.closest(".reaction-badge");
			if (!badge) return;
			const msgEl = badge.closest(".chat-message");
			if (!msgEl) return;
			const messageId = Number(msgEl.dataset.messageId);
			const emoji = badge.dataset.emoji;
			if (!messageId || !emoji) return;
			e.stopPropagation();
			try {
				await emitReaction(messageId, emoji);
			} catch (err) {
				console.error("reaction toggle failed", err);
			}
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

		// Track recent user interactions and the scroll position at the
		// start of interaction. This lets us require a deliberate user
		// scroll-up delta before auto-loading older messages.
		let _lastUserInteractionAt = 0;
		let _lastUserScrollTop = null;
		const _markUserInteraction = () => {
			_lastUserInteractionAt = Date.now();
			try {
				state.suppressAutoLoadUntil = 0;
			} catch (e) {}
			try {
				_lastUserScrollTop = chatEl.scrollTop;
			} catch (e) {
				_lastUserScrollTop = null;
			}
			try {
				clearOpenSuppression(state.contactUserId);
			} catch (e) {}
		};
		chatEl.addEventListener("wheel", _markUserInteraction, {
			passive: true,
		});
		chatEl.addEventListener("touchstart", _markUserInteraction, {
			passive: true,
		});
		chatEl.addEventListener("pointerdown", _markUserInteraction, {
			passive: true,
		});
		window.addEventListener(
			"keydown",
			(ev) => {
				try {
					const keys = [
						"ArrowUp",
						"PageUp",
						"Home",
						"ArrowDown",
						"PageDown",
						"End",
					];
					if (keys.includes(ev.key)) _markUserInteraction();
				} catch (e) {}
			},
			true,
		);

		chatEl.addEventListener("scroll", (e) => {
			// Ignore programmatic scrolls and non-user-initiated events
			if (state.isProgrammaticScroll) return;
			if (e && e.isTrusted === false) return;
			// load older messages when user scrolls to top area, but allow
			// temporary suppression during initial rendering. Use `nearTop`
			// to handle reversed layouts reliably.
			const recentUser = Date.now() - _lastUserInteractionAt < 1000;
			const suppressAuto =
				(state.suppressAutoLoadUntil || 0) > Date.now();
			const userScrolledUp =
				typeof _lastUserScrollTop === "number" &&
				_lastUserScrollTop - chatEl.scrollTop > 80; // px threshold

			const scrollableHeight = chatEl.scrollHeight - chatEl.clientHeight;
			if (
				chatEl.scrollTop < Math.min(200, scrollableHeight * 0.15) &&
				!state.suppressScrollLoad
			) {
				loadOlderMessages();
			} else if (nearTop(chatEl, 60) && state.initializingChat) {
			} else if (
				nearTop(chatEl, 60) &&
				suppressAuto &&
				!userScrolledUp &&
				!recentUser
			) {
			} else if (nearTop(chatEl, 60) && !userScrolledUp && !recentUser) {
				// Suppress layout-driven/top proximity triggers unless user initiated.
			}
			const distanceFromBottom =
				chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
			scrollToBottomBtn.classList.toggle(
				"visible",
				distanceFromBottom > 300,
			);

			// If server-provided pinned data exists, prefer locating by messageId
			const allPinned = getPinnedData(state.contactUserId);
			if (Array.isArray(allPinned) && allPinned.length > 0) {
				for (let i = allPinned.length - 1; i >= 0; i--) {
					const mid = allPinned[i].id;
					const msgEl = chatEl.querySelector(`[data-message-id="${mid}"]`);
					if (!msgEl) continue;
					const rect = msgEl.getBoundingClientRect();
					const chatRect = chatEl.getBoundingClientRect();
					// consider the message visible if any part overlaps the chat viewport
					if (rect.bottom >= chatRect.top && rect.top <= chatRect.bottom) {
						pinnedMessageText.dataset.messageId = String(mid);
						pinnedMessageText.textContent = allPinned[i].text || '';
						// update pin-count UI (mirror chat.js helper)
						pinnedMessageCount.textContent = '';
						const total = Math.min(allPinned.length, 3);
						if (total > 0) {
							const pos = i;
							let activeSpan;
							if (allPinned.length <= 3) {
								activeSpan = pos;
							} else {
								if (pos === 0) activeSpan = 0;
								else if (pos === allPinned.length - 1) activeSpan = 2;
								else activeSpan = 1;
							}
							for (let s = 0; s < total; s++) {
								const span = document.createElement('span');
								if (s === activeSpan) {
									span.style.height = '1.2rem';
									span.style.opacity = '1';
								} else {
									span.style.height = '0.6rem';
									span.style.opacity = '0.4';
								}
								pinnedMessageCount.appendChild(span);
							}
						}
						break;
					}
				}
			} else {
				if (state.pinnedIndexes.length === 0) return;
				for (let i = state.pinnedIndexes.length - 1; i >= 0; i--) {
					const idx = state.pinnedIndexes[i];
					const msg = chatEl.querySelector(`[data-index="${idx}"]`);
					if (!msg) continue;
					const rect = msg.getBoundingClientRect();
					const chatRect = chatEl.getBoundingClientRect();
					// consider the message visible if any part overlaps the chat viewport
					if (rect.bottom >= chatRect.top && rect.top <= chatRect.bottom) {
						pinnedMessageText.dataset.index = idx;
						const msgs = messages[state.contactUserId][idx];
						if (!msgs) return;
						pinnedMessageText.textContent = msgs.text;
						updatePinCount(idx);
						break;
					}
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
		pinnedMessageContainer.addEventListener("click", async () => {
			const allPinned = getPinnedData(state.contactUserId);

			if (Array.isArray(allPinned) && allPinned.length > 0) {
				const currentId =
					Number(pinnedMessageText.dataset.messageId) || null;
				const pos = allPinned.findIndex(
					(m) => Number(m.id) === Number(currentId),
				);
				if (pos === -1) return;

				const currentMsg = allPinned[pos]; // ← scroll میریم اینجا
				const nextPos = (pos - 1 + allPinned.length) % allPinned.length;
				const nextMsg = allPinned[nextPos]; // ← بعد از scroll اینو نشون میده

				pinnedMessageContainer.style.animation = "highlightPin 0.5s";
				setTimeout(
					() => (pinnedMessageContainer.style.animation = ""),
					500,
				);

				// اول scroll به currentMsg
				try {
					await scrollToPinnedMessage(currentMsg.id);
				} catch (e) {
					/* ignore */
				}

				// بعد banner رو advance کن به nextMsg
				pinnedMessageText.textContent = nextMsg.text || "";
				pinnedMessageText.dataset.messageId = String(nextMsg.id);

				// pin count
				pinnedMessageCount.textContent = "";
				const total = Math.min(allPinned.length, 3);
				for (let s = 0; s < total; s++) {
					const span = document.createElement("span");
					if (s === nextPos % total) {
						span.style.height = "1.2rem";
						span.style.opacity = "1";
					} else {
						span.style.height = "0.6rem";
						span.style.opacity = "0.4";
					}
					pinnedMessageCount.appendChild(span);
				}
			} else {
				// fallback index-based (قدیمی)
				if (state.pinnedIndexes.length === 0) return;
				const currentIdx = Number(pinnedMessageText.dataset.index);
				const pos = state.pinnedIndexes.indexOf(currentIdx);
				if (pos === -1) return;
				const prevPos =
					(pos - 1 + state.pinnedIndexes.length) %
					state.pinnedIndexes.length;
				const prevIdx = state.pinnedIndexes[prevPos];

				const targetMsg = chatEl.querySelector(
					`[data-index="${currentIdx}"]`,
				);
				if (targetMsg) {
					state.isProgrammaticScroll = true;
					targetMsg.scrollIntoView({
						behavior: "smooth",
						block: "center",
					});
					highlightMessage(targetMsg);
					setTimeout(() => {
						state.isProgrammaticScroll = false;
						const msgs = messages[state.contactUserId][prevIdx];
						if (!msgs) return;
						pinnedMessageText.textContent = msgs.text;
						pinnedMessageText.dataset.index = prevIdx;
						updatePinCount(prevIdx);
					}, 800);
				}
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

		forwardDialog.addEventListener("click", async (e) => {
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
				className: "chat-profile-picture",
				isOnline: friend.isOnline,
			});
			try {
				const chatProfileWrapper =
					document.querySelector(".chat-profile");
				if (chatProfileWrapper)
					chatProfileWrapper.setAttribute(
						"data-user-id",
						String(friend.id),
					);
			} catch (_e) {
				/* ignore */
			}
			chatName.textContent = friend.nickname || friend.name;
			try { await openChat(true); } catch (e) { /* ignore */ }
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
			// Wait for padding/layout changes (msgAction) then scroll.
			scrollChatToBottomAfterPadding();

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
					friend.lastMessage =
						lastMsg &&
						lastMsg.isTimeCapsule &&
						lastMsg.isLocked &&
						!lastMsg.user
							? ""
							: lastMsg.text || "";
					friend.lastMessageTime = lastMsg.time;
					friend.lastMessageDate = lastMsg.date || "";
					// Only explicit false means unseen
					friend.lastMessageSeen = lastMsg.user
						? lastMsg.isSeen !== false
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
					!friend.isSaved &&
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

		// clear list via DOM APIs to avoid direct innerHTML usage
		while (archivedDialogList && archivedDialogList.firstChild) {
			archivedDialogList.removeChild(archivedDialogList.firstChild);
		}

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
						async (id) => {
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
						async (id) => {
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
								className: "chat-profile-picture",
								isOnline: friend.isOnline,
							});
							try {
								const chatProfileWrapper =
									document.querySelector(".chat-profile");
								if (chatProfileWrapper)
									chatProfileWrapper.setAttribute(
										"data-user-id",
										String(friend.id),
									);
							} catch (e) {
								/* ignore */
							}
							chatName.textContent =
								friend.nickname || friend.name;
							try { await openChat(true); } catch (e) { /* ignore */ }

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
