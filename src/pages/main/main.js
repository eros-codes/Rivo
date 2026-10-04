import "emoji-picker-element";
import {
	updateContact as apiUpdateContact,
	logout as apiLogout,
	getMe,
	getMessagesPage,
	getPinnedMessages,
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
	getContactPreviewText,
	DEFAULT_PAGE_LIMIT,
} from "./js/chat.js";
import { markOpenChatSeen } from "./js/chat-open.js";
import { messageForDisplay } from "./js/chat-render.js";
import { setContactsSync } from "./js/chat-receive.js";
import { normalizeServerMessage, displayName, pinnedData } from "./js/chat-state.js";
import {
	normalizeServerContact,
	fetchAllContacts,
	syncContactsWithServer,
} from "./js/contact-model.js";
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
	toggleSelectedMessage,
	cancelSelection,
	handleBulkDelete,
	prepareBulkForward,
	executeBulkForward,
} from "./js/selection.js";
import {
	initProfile,
	openProfile,
	closeProfile,
	applyComposerState,
	handleDeleteChat,
	handleEditNickname,
	handleEditNicknameDone,
	handleEditNicknameCancel,
	handleBlockContact,
	handleDeleteContact,
	refreshProfile,
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
import { initAllContacts } from "./js/all-contacts.js";
import {
	initSocket,
	emitTypingStart,
	emitTypingStop,
	getSocket,
	setActiveConversation,
	emitReaction,
	setOnetimeDeletedHandler,
	setCapsuleOpenedHandler,
} from "./js/socket.js";
import { applyReactionsToMessage, createMessage } from "../../components/messages/messages.js";
import { loadThemeFromStorage } from "../../utils/theme.js";
import { parseSvg } from "../../utils/svg.js";
import {
	updateThemeImages,
	observeThemeChanges,
	mountAvatar,
	refreshUserAvatars,
} from "../../utils/dom.js";
import { formatClock, localDateKey } from "../../utils/date.js";
import { getCurrentUser } from "./js/currentUser.js";
import { copyIcon, deleteIcon, pinIcon, replyIcon, archiveIcon, savedIconSvg } from "./js/icons.js";

document.addEventListener("DOMContentLoaded", async function () {
	// Initialize client-side Sentry when a server-provided DSN is configured.
	(function initClientSentry() {
		try {
			const dsn = window.__SENTRY_DSN__;
			if (!dsn || typeof dsn !== "string") return;
			const s = document.createElement("script");
			s.src = "/js/sentry.min.js";
			s.crossOrigin = "anonymous";
			s.onload = () => {
				try {
					if (!window.Sentry) return;
					window.Sentry.init({ dsn, tracesSampleRate: 0.0 });
					window.Sentry.setTag("app", "rivo-client");
					window.addEventListener("error", (ev) => {
						try {
							window.Sentry.captureException(ev.error || ev);
						} catch (e) {
							void e;
						}
					});
					window.addEventListener("unhandledrejection", (ev) => {
						try {
							window.Sentry.captureException(ev.reason || ev);
						} catch (e) {
							void e;
						}
					});
				} catch (e) {
					void e;
				}
			};
			s.onerror = () => console.warn("Sentry failed to load");
			document.head.appendChild(s);
		} catch (e) {
			void e;
		}
	})();

	try {
		initInAppNotification();
		// a tap on an in-app notification (or a push) opens that chat, at the
		// message when one is given
		document.addEventListener("in-app-notif:open", (e) => {
			const id = Number(e?.detail?.contactId);
			if (!Number.isFinite(id) || !id) return;
			const messageId = e?.detail?.messageId || null;
			try {
				closeSettings();
			} catch (err) {
				/* ignore */
			}
			openChatWithContact(id, { focusMessageId: messageId }).catch(() => {});
		});
	} catch (e) {
		// ignore init errors
	}

	// Rely on HttpOnly cookie for auth; the stored copy only has display data.
	const _storeMe = (me) => {
		const safeUser = {
			id: me.id,
			name: me.name || "",
			username: me.username || "",
			nickname: me.username || "",
			profilePics: Array.isArray(me.profilePics) ? me.profilePics : [],
			bio: me.bio || "",
			email: me.email || "",
		};
		try {
			localStorage.setItem("user", JSON.stringify(safeUser));
		} catch (e) {
			/* storage blocked: the page still works with the in-memory copy */
		}
		return safeUser;
	};
	let currentUser = getCurrentUser();
	if (!currentUser || !currentUser.id) {
		try {
			const me = await getMe();
			if (me && me.id) {
				currentUser = _storeMe(me);
			} else {
				window.location.replace("/auth/auth.html");
				return;
			}
		} catch (e) {
			window.location.replace("/auth/auth.html");
			return;
		}
	} else {
		// The stored copy may be old (changed on another device) or even belong
		// to another account (signed in as someone else in another tab).
		getMe()
			.then((me) => {
				if (!me || !me.id) return;
				if (Number(me.id) !== Number(currentUser.id)) {
					_storeMe(me);
					window.location.reload();
					return;
				}
				const fresh = _storeMe(me);
				Object.assign(currentUser, fresh);
				try {
					refreshUserAvatars(currentUser);
				} catch (err) {
					/* ignore */
				}
			})
			.catch(() => {
				/* offline: keep the stored copy (an ended session redirects) */
			});
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
	const chatUnavailableNotice = document.getElementById("chat-unavailable-notice");
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
	const _resetDeleteAccountDialog = () => {
		if (deleteAccountPassword) deleteAccountPassword.value = "";
		if (deleteAccountError) deleteAccountError.textContent = "";
		if (deleteAccountConfirm) deleteAccountConfirm.disabled = false;
	};
	deleteAccountCancel?.addEventListener("click", () => {
		try {
			deleteAccountDialog.close();
		} catch (e) {
			/* ignore */
		}
	});
	// however it closes (button or Esc), the password is not kept
	deleteAccountDialog?.addEventListener("close", _resetDeleteAccountDialog);

	let _deletingAccount = false;
	deleteAccountConfirm?.addEventListener("click", async () => {
		if (_deletingAccount) return;
		// passwords are compared exactly as typed
		const password = (deleteAccountPassword && deleteAccountPassword.value) || "";
		if (!password) {
			if (deleteAccountError)
				deleteAccountError.textContent = "Please enter your password.";
			return;
		}
		if (deleteAccountError) deleteAccountError.textContent = "";
		_deletingAccount = true;
		if (deleteAccountConfirm) deleteAccountConfirm.disabled = true;

		try {
			const res = await deleteAccount(password);
			if (res?.success) {
				try {
					getSocket()?.disconnect();
				} catch (e) {
					/* ignore */
				}
				try {
					if (window.pushUnsubscribe)
						await Promise.race([
							window.pushUnsubscribe(),
							new Promise((resolve) => setTimeout(resolve, 2000)),
						]);
				} catch (e) {
					/* ignore */
				}
				try {
					localStorage.removeItem("user");
				} catch (e) {
					/* ignore */
				}
				window.location.replace("/auth/auth.html");
				return;
			}
			if (deleteAccountError)
				deleteAccountError.textContent = res?.error || "Incorrect password.";
		} catch (err) {
			if (deleteAccountError)
				deleteAccountError.textContent =
					err?.status === 403
						? "Incorrect password."
						: err?.message || "Connection error.";
		}
		_deletingAccount = false;
		if (deleteAccountConfirm) deleteAccountConfirm.disabled = false;
	});

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

	// Counts chat openings: a slow opening must not finish over a newer one
	// (declared before anything below can open a chat)
	let _openSeq = 0;

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
		// forwarding opens the target chat exactly like tapping it
		openChatWithContact: (id) => openChatWithContact(id),
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
		messageContainer,
		unblockActionBtn,
		unavailableNotice: chatUnavailableNotice,
		deleteIcon,
		onContactAction: _onContactAction,
	});
	// Esc closes the desktop profile dialog natively: tidy up the same way
	profileDialog?.addEventListener("close", () => {
		if (state.isProfileDialogOpen) closeProfile();
	});
	// A closed chat leaves no menu or selection behind
	document.addEventListener("chat:closed", () => {
		if (state.isMenuOpen) closeContextMenu();
		if (state.isSelecting) cancelSelection();
	});

	initAllContacts({
		onContactAction: _onContactAction,
		// exactly the same flow as tapping a card on the main page
		onOpenChat: (userId) => openChatWithContact(userId),
	});

	// Swipe actions on Active Chats cards: the same actions as the card menu
	initCardContextMenu(activeChatsContainer, (action, userId) =>
		_onContactAction(action, userId),
	);

	initSearch({
		mainContent,
		searchResults,
		searchContactsList,
		searchMessagesList,
		onContactAction: _onContactAction,
		// a contact (messageId = null) or a message result
		onMessageClick: (contact, messageId) => {
			searchbar.classList.remove("open");
			searchInput.value = "";
			_lastSearchQuery = "";
			runSearch("");
			if (!contact) return;
			openChatWithContact(contact.id, { focusMessageId: messageId || null }).catch(() => {});
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
			if (!newContact || newContact.id == null) return;
			const normalized = normalizeServerContact(newContact, currentUser.id);
			normalized._previousContainer = "contacts";
			const existing = contacts.find((c) => c.id === normalized.id);
			if (existing) Object.assign(existing, normalized);
			else contacts.push(normalized);
			updateContactsEmptyState();
			sortContacts();
			// the same flow as tapping the new contact's card
			await openChatWithContact(normalized.id);
		},
	);

	// ─── Chat header ──────────────────────────────────────────────────────────
	// Picture (or the Saved Messages icon), name and online dot of the chat on
	// screen.
	function setChatHeader(friend) {
		if (!friend || !chatProfilePicture) return;
		if (friend.isSaved) {
			const avatarEl = chatProfilePicture.querySelector(
				"img, .contact-profile, .initial-avatar, .chat-profile-picture",
			);
			if (avatarEl) avatarEl.style.display = "none";
			chatProfilePicture.classList.add("saved-icon");
			chatProfilePicture.querySelector(".saved-icon-svg")?.remove();
			const icon = parseSvg(savedIconSvg);
			if (icon) {
				icon.classList.add("saved-icon-svg");
				chatProfilePicture.appendChild(icon);
			}
			chatProfilePicture.classList.remove("online");
		} else {
			mountAvatar(chatProfilePicture, {
				name: friend.name,
				nickname: friend.nickname,
				profilePics: friend.profilePics,
				className: "chat-profile-picture",
				isOnline: friend.isOnline,
				isDeleted: !!friend.isDeleted,
			});
			chatProfilePicture.classList.toggle(
				"online",
				!!friend.isOnline && !friend.isDeleted,
			);
		}
		chatProfilePicture.setAttribute("data-user-id", String(friend.id));
		if (chatName) chatName.textContent = displayName(friend);
	}

	// ─── Profile changes ──────────────────────────────────────────────────────
	// `user.id` is the ACCOUNT id. Cards and state use the Contact row id
	// (contact.id), so contacts are matched by `contact.contactId`.
	function _handleUserUpdated(user) {
		try {
			if (!user || user.id == null) return;
			const accountId = Number(user.id);
			const pics = Array.isArray(user.profilePics) ? user.profilePics : null;
			const isDeleted = user.isDeleted === true;

			// Our own profile (changed in this tab or on another device)
			if (currentUser && Number(currentUser.id) === accountId && !isDeleted) {
				if (pics) currentUser.profilePics = pics;
				if (user.name) currentUser.name = user.name;
				if (user.username) currentUser.username = user.username;
				if (typeof user.bio === "string") currentUser.bio = user.bio;
				try {
					const stored = getCurrentUser() || {};
					localStorage.setItem(
						"user",
						JSON.stringify({
							...stored,
							name: currentUser.name || "",
							username: currentUser.username || "",
							nickname: currentUser.username || "",
							bio: currentUser.bio || "",
							profilePics: currentUser.profilePics || [],
						}),
					);
				} catch (e) {
					/* ignore */
				}
				try {
					refreshUserAvatars(currentUser);
				} catch (e) {
					/* ignore */
				}
			}

			// Keep in-memory contact objects in sync. A nickname is this user's
			// own name for the contact and is never replaced by their profile.
			const changed = [];
			for (const c of contacts) {
				// Saved Messages points at our own account: never rename it
				if (c.isSaved || Number(c.contactId) !== accountId) continue;
				if (isDeleted) {
					c.isDeleted = true;
					c.nickname = null;
					c.name = "Deleted account";
					c.username = "";
					c.email = "";
					c.bio = "";
					c.profilePics = [];
					c.isOnline = false;
					c.lastSeen = null;
				} else {
					if (pics) c.profilePics = pics;
					if (user.name) {
						if (c.contact) c.contact.name = user.name;
						c.name = c.nickname || user.name;
					}
					if (user.username) {
						if (c.contact) c.contact.username = user.username;
						c.username = user.username;
					}
					if (typeof user.bio === "string") c.bio = user.bio;
				}
				changed.push(c);
			}

			// Rebuild every place that shows them (cards, All contacts, chat
			// header, profile panel) from the updated data
			changed.forEach((friend) => {
				refreshCard(friend);
				if (state.contactUserId !== friend.id) return;
				setChatHeader(friend);
				applyComposerState(friend);
				refreshProfile(friend);
			});
		} catch (e) {
			/* ignore handler failures */
		}
	}

	// ─── Live updates ─────────────────────────────────────────────────────────
	function _findMessage(messageId) {
		if (messageId == null) return null;
		for (const [uid, msgs] of Object.entries(messages)) {
			if (!Array.isArray(msgs)) continue;
			const idx = msgs.findIndex((m) => String(m.id) === String(messageId));
			if (idx !== -1) return { contactId: Number(uid), index: idx, msg: msgs[idx], list: msgs };
		}
		return null;
	}

	function _contactOf(found, conversationId) {
		if (found) return contacts.find((c) => c.id === found.contactId) || null;
		if (conversationId == null) return null;
		return contacts.find((c) => String(c.conversationId) === String(conversationId)) || null;
	}

	function _setPreview(friend, last) {
		if (last) {
			friend.lastMessage = getContactPreviewText(last);
			friend.lastMessageId = last.id ?? null;
			friend.lastMessageTime = last.time || "";
			friend.lastMessageDate = last.date || "";
			const ts = new Date(last.createdAt).getTime();
			friend.lastMessageTs = Number.isFinite(ts) ? ts : 0;
			// Only an explicit false means "not seen yet"
			friend.lastMessageSeen = last.user ? last.isSeen !== false : true;
		} else {
			friend.lastMessage = "";
			friend.lastMessageId = null;
			friend.lastMessageTime = "";
			friend.lastMessageDate = "";
			friend.lastMessageTs = 0;
			friend.lastMessageSeen = true;
		}
	}

	// Card preview from the newest loaded message (the newest page is always
	// the one that is loaded)
	function _previewFromLoaded(friend) {
		const list = messages[friend.id];
		_setPreview(friend, Array.isArray(list) && list.length ? list[list.length - 1] : null);
	}

	// The chat's messages were never loaded here: ask the server for the newest
	async function _refreshPreviewFromServer(friend) {
		if (!friend?.conversationId) return;
		try {
			const page = await getMessagesPage(friend.conversationId, { limit: 1 });
			if (!contacts.includes(friend)) return;
			if (Array.isArray(messages[friend.id])) _previewFromLoaded(friend);
			else
				_setPreview(
					friend,
					Array.isArray(page) && page.length ? normalizeServerMessage(page[page.length - 1]) : null,
				);
			_settleCard(friend);
		} catch (e) {
			/* offline: the next sync fixes it */
		}
	}

	// Active Chats holds Saved Messages, pinned chats, the chat on screen and
	// chats with something unread or not yet seen; the rest are contact cards.
	function _settleCard(friend) {
		if (!friend) return;
		refreshCard(friend);
		const keepActive =
			friend.isSaved ||
			friend.isPinned ||
			state.contactUserId === friend.id ||
			(friend.unreadCount || 0) > 0 ||
			friend.lastMessageSeen === false;
		if (!keepActive) moveToContacts(friend);
		sortActiveChats();
		sortContacts();
	}

	// Redraws one message of the open chat from its data
	function _rerenderMessageEl(contactId, msg) {
		if (state.contactUserId !== contactId || !msg || msg.id == null || !chatEl) return;
		const old = chatEl.querySelector(`.chat-message[data-message-id="${msg.id}"]`);
		if (!old) return;
		if (state.isMenuOpen && state.selectedMsg === old) closeContextMenu();
		const idx = (messages[contactId] || []).indexOf(msg);
		if (idx !== -1) msg.index = idx;
		const el = createMessage(messageForDisplay(msg, contactId));
		if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
			try {
				applyReactionsToMessage(el, msg.reactions, currentUser?.id || null);
			} catch (e) {
				/* ignore */
			}
		}
		if (old.classList.contains("selected")) el.classList.add("selected");
		old.replaceWith(el);
	}

	// A change that moves messages around must not leave a menu or a
	// selection pointing at the wrong one
	function _resetMessageUi(contactId) {
		if (state.contactUserId !== contactId) return;
		if (state.isMenuOpen) closeContextMenu();
		if (state.isSelecting) cancelSelection();
	}

	function _removeCards(contactId) {
		activeChatsContainer
			?.querySelectorAll(`[data-user-id="${contactId}"]`)
			.forEach((el) => (el.closest(".active-chat-wrapper") ?? el).remove());
		contactsContainer
			?.querySelectorAll(`[data-user-id="${contactId}"]`)
			.forEach((el) => el.remove());
	}

	// Closes the chat (and its profile) when it shows this contact
	function _closeChatOf(contactId) {
		if (state.contactUserId !== contactId) return;
		state.skipShowChatOnProfileClose = true;
		if (state.isProfileDialogOpen) closeProfile();
		else state.skipShowChatOnProfileClose = false;
		if (chatEl) chatEl.textContent = "";
		closeChat();
	}

	function _onMessageEdited(data) {
		if (!data || data.messageId == null) return;
		const found = _findMessage(data.messageId);
		const friend = _contactOf(found, data.conversationId);
		if (found) {
			found.msg.text = data.text;
			found.msg.isEdited = true;
			_rerenderMessageEl(found.contactId, found.msg);
		}
		if (!friend) return;
		const pin = (pinnedData[friend.id] || []).find((p) => String(p.id) === String(data.messageId));
		if (pin) {
			pin.text = data.text;
			if (state.contactUserId === friend.id) updatePinnedMessage();
		}
		if (String(friend.lastMessageId) === String(data.messageId)) {
			friend.lastMessage = found ? getContactPreviewText(found.msg) : data.text || "";
			refreshCard(friend);
		}
	}

	function _onMessageDeleted(data) {
		if (!data || data.messageId == null) return;
		const messageId = data.messageId;
		const found = _findMessage(messageId);
		const friend = _contactOf(found, data.conversationId);
		if (!friend) return;
		try {
			updatePinnedData(friend.id, messageId, found ? found.msg : null, false);
		} catch (e) {
			/* ignore */
		}

		// someone else's message that was still unread here (a catch-up after
		// a reconnect already has the server's counter)
		const senderId = found ? found.msg.senderId : data.senderId;
		const fromOther = found
			? !found.msg.user
			: senderId != null && Number(senderId) !== Number(currentUser.id);
		const wasUnseen = found ? found.msg.isSeen !== true : data.isSeen === false;
		if (!data.fromSync && fromOther && wasUnseen && (friend.unreadCount || 0) > 0) {
			friend.unreadCount -= 1;
			updateTotalUnreadCount();
		}

		if (found) {
			_resetMessageUi(friend.id);
			found.list.splice(found.index, 1);
			if (state.contactUserId === friend.id) injectMessages(friend.id);
			_previewFromLoaded(friend);
			_settleCard(friend);
			return;
		}
		if (state.contactUserId === friend.id) updatePinnedMessage();
		if (String(friend.lastMessageId) === String(messageId)) _refreshPreviewFromServer(friend);
		else _settleCard(friend);
	}

	// The whole chat was cleared (for both people)
	function _onChatCleared(data) {
		const friend = _contactOf(null, data?.conversationId);
		if (!friend) return;
		const ids = new Set((Array.isArray(data.messageIds) ? data.messageIds : []).map(String));
		_resetMessageUi(friend.id);
		if (Array.isArray(messages[friend.id])) {
			messages[friend.id] = messages[friend.id].filter((m) => m.id == null || !ids.has(String(m.id)));
		}
		pinnedData[friend.id] = (pinnedData[friend.id] || []).filter((p) => !ids.has(String(p.id)));
		friend.unreadCount = 0;
		updateTotalUnreadCount();
		if (state.contactUserId === friend.id) injectMessages(friend.id);
		_previewFromLoaded(friend);
		_settleCard(friend);
	}

	function _onPresence(userId, online, lastSeen = null) {
		const friend = contacts.find(
			(c) => !c.isSaved && Number(c.contactId) === Number(userId),
		);
		if (!friend) return;
		friend.isOnline = !!online && !friend.isDeleted;
		if (!online) friend.lastSeen = lastSeen || null;
		if (state.contactUserId === friend.id && chatProfilePicture)
			chatProfilePicture.classList.toggle("online", friend.isOnline);
		refreshCard(friend);
		refreshProfile(friend);
	}

	// "typing..." also goes away by itself if the stop event never comes
	let _typingClearTimer = null;
	function _setTyping(text) {
		clearTimeout(_typingClearTimer);
		if (chatTypingStatus) chatTypingStatus.textContent = text;
		if (text)
			_typingClearTimer = setTimeout(() => {
				if (chatTypingStatus) chatTypingStatus.textContent = "";
			}, 6000);
	}
	function _onTyping(userId, typing) {
		const friend = contacts.find(
			(c) => !c.isSaved && Number(c.contactId) === Number(userId),
		);
		if (!friend || state.contactUserId !== friend.id) return;
		_setTyping(typing ? "typing..." : "");
	}

	async function _reloadPinned(friend) {
		if (!friend?.conversationId) return;
		try {
			const res = await getPinnedMessages(friend.conversationId);
			pinnedData[friend.id] = Array.isArray(res?.pinned) ? res.pinned : [];
			if (state.contactUserId === friend.id) updatePinnedMessage();
		} catch (e) {
			/* ignore */
		}
	}

	function _onMessagePinned(data) {
		if (!data || data.messageId == null) return;
		const found = _findMessage(data.messageId);
		const friend = _contactOf(found, data.conversationId);
		if (!friend) return;
		const isPinned = !!data.isPinned;
		if (!found) {
			// not loaded here: the server has its text
			if (state.contactUserId === friend.id || pinnedData[friend.id]) _reloadPinned(friend);
			return;
		}
		found.msg.isPinned = isPinned;
		try {
			updatePinnedData(friend.id, data.messageId, found.msg, isPinned);
		} catch (e) {
			/* ignore */
		}
		if (state.contactUserId !== friend.id) return;
		_rerenderMessageEl(friend.id, found.msg);
		state.pinnedIndexes = (messages[friend.id] || [])
			.map((m, i) => (m.isPinned ? i : -1))
			.filter((i) => i !== -1);
		updatePinnedMessage();
	}

	// Another device of this user removed the contact
	function _onContactRemoved(payload) {
		const rowId = Number(payload?.contactRowId);
		let idx = Number.isFinite(rowId) ? contacts.findIndex((c) => c.id === rowId) : -1;
		if (idx === -1 && payload?.contactUserId != null) {
			idx = contacts.findIndex(
				(c) => !c.isSaved && Number(c.contactId) === Number(payload.contactUserId),
			);
		}
		if (idx === -1) return;
		const removed = contacts[idx];
		_closeChatOf(removed.id);
		contacts.splice(idx, 1);
		delete messages[removed.id];
		delete pinnedData[removed.id];
		_removeCards(removed.id);
		updateContactsEmptyState();
		updateTotalUnreadCount();
		sortActiveChats();
		sortContacts();
	}

	function _onReactionUpdated(data) {
		if (!data || data.messageId == null) return;
		const { messageId, reactions, actorId, emoji, action } = data;
		const list = Array.isArray(reactions) ? reactions : [];
		const found = _findMessage(messageId);
		const friend = _contactOf(found, data.conversationId);
		if (found) found.msg.reactions = list;
		chatEl
			?.querySelectorAll(`.chat-message[data-message-id="${messageId}"]`)
			.forEach((msgEl) => {
				try {
					applyReactionsToMessage(msgEl, list, currentUser?.id || null);
				} catch (e) {
					/* ignore */
				}
			});

		// Tell this user when someone reacts to their message in a chat that
		// is not on screen (a hidden app gets a push notification instead)
		if (action !== "added" && action !== "changed") return;
		if (!friend || friend.isMuted || !found || !found.msg.user) return;
		if (Number(actorId) === Number(currentUser?.id)) return;
		if (state.contactUserId === friend.id) return;
		if (document.visibilityState === "hidden") return;
		try {
			showNotification(friend, {
				id: messageId,
				text: `${displayName(friend) || "Someone"} reacted ${emoji || ""} to your message`,
			});
		} catch (e) {
			/* ignore */
		}
	}

	// ─── Keeping up with the server ───────────────────────────────────────────
	// Puts a contact's card where it belongs (see _settleCard)
	function _placeCard(friend) {
		if (!friend) return;
		const activeCard = activeChatsContainer?.querySelector(
			`.active-chat[data-user-id="${friend.id}"]`,
		);
		const wantActive =
			!friend.isArchived &&
			(friend.isSaved ||
				friend.isPinned ||
				state.contactUserId === friend.id ||
				(friend.unreadCount || 0) > 0 ||
				friend.lastMessageSeen === false);
		if (friend.isArchived) {
			if (activeCard) (activeCard.closest(".active-chat-wrapper") ?? activeCard).remove();
			return;
		}
		if (!wantActive) {
			if (activeCard) moveToContacts(friend);
			else refreshCard(friend);
			return;
		}
		if (activeCard) {
			refreshCard(friend);
		} else if (friend.isSaved) {
			const card = createActiveChatCard(friend);
			card.dataset.saved = "true";
			activeChatsContainer.prepend(card);
		} else {
			moveToActiveChats(friend);
		}
	}

	// Brings the contact list in line with the server and redraws the cards
	let _syncing = null;
	function _syncContacts() {
		if (_syncing) return _syncing;
		_syncing = (async () => {
			try {
				const { added, updated, removed } = await syncContactsWithServer(currentUser.id);
				for (const r of removed) {
					_closeChatOf(r.id);
					delete messages[r.id];
					delete pinnedData[r.id];
					_removeCards(r.id);
				}
				[...added, ...updated].forEach(_placeCard);
				updateTotalUnreadCount();
				sortActiveChats();
				sortContacts();
				updateContactsEmptyState();
				const open = contacts.find((c) => c.id === state.contactUserId);
				if (open) {
					setChatHeader(open);
					applyComposerState(open);
					refreshProfile(open);
				}
			} finally {
				_syncing = null;
			}
		})();
		return _syncing;
	}

	// Messages, edits, deletions, reactions and read receipts the chat on
	// screen missed while the connection was down
	async function _catchUpOpenChat() {
		const contactId = state.contactUserId;
		const friend = contacts.find((c) => c.id === contactId);
		if (!friend?.conversationId) return;
		let page;
		try {
			page = await getMessagesPage(friend.conversationId, { limit: DEFAULT_PAGE_LIMIT });
		} catch (e) {
			return;
		}
		if (state.contactUserId !== contactId || !Array.isArray(page)) return;
		const convId = friend.conversationId;
		const local = Array.isArray(messages[contactId]) ? [...messages[contactId]] : [];
		const localById = new Map(local.filter((m) => m.id != null).map((m) => [String(m.id), m]));
		const freshIds = new Set(page.map((m) => String(m.id)));

		if (page.length === 0) {
			const ids = local.filter((m) => m.id != null).map((m) => m.id);
			if (ids.length) _onChatCleared({ conversationId: convId, messageIds: ids });
		} else {
			const oldest = new Date(page[0].createdAt).getTime();
			for (const m of local) {
				if (m.id == null || freshIds.has(String(m.id))) continue;
				const t = new Date(m.createdAt).getTime();
				if (Number.isFinite(t) && t >= oldest) {
					_onMessageDeleted({ messageId: m.id, conversationId: convId, fromSync: true });
				}
			}
		}

		// the counter from the server already includes the missed messages
		const syncedUnread = friend.unreadCount || 0;
		const seenIds = [];
		for (const s of page) {
			if (state.contactUserId !== contactId) return;
			const mine = localById.get(String(s.id));
			if (!mine) {
				await receiveMessage(s);
				continue;
			}
			const fresh = normalizeServerMessage(s);
			if (fresh.isEdited && !mine.isLocked && fresh.text !== mine.text) {
				_onMessageEdited({ messageId: s.id, conversationId: convId, text: fresh.text });
			}
			if (mine.user && fresh.isSeen && !mine.isSeen) seenIds.push(s.id);
			if (JSON.stringify(fresh.reactions) !== JSON.stringify(mine.reactions || [])) {
				_onReactionUpdated({ messageId: s.id, conversationId: convId, reactions: fresh.reactions, action: "sync" });
			}
			if (fresh.isPinned !== !!mine.isPinned) {
				_onMessagePinned({ messageId: s.id, conversationId: convId, isPinned: fresh.isPinned });
			}
			if (mine.isTimeCapsule && !mine.openedAt && fresh.openedAt) {
				handleCapsuleOpened({
					messageId: s.id,
					text: fresh.text,
					openedAt: fresh.openedAt,
					conversationId: convId,
					senderId: s.senderId,
				});
			}
		}
		if (seenIds.length) handleMessagesSeen(convId, seenIds, friend.contactId);
		if ((friend.unreadCount || 0) !== syncedUnread) {
			friend.unreadCount = syncedUnread;
			updateTotalUnreadCount();
			refreshCard(friend);
		}
	}

	async function _resyncAfterReconnect() {
		try {
			await _syncContacts();
		} catch (e) {
			return;
		}
		await _catchUpOpenChat();
		// the chat on screen is being read
		if (state.contactUserId != null) markOpenChatSeen();
	}

	setContactsSync(_syncContacts);

	// The newest messages of the open chat are on screen: mark them read
	let _seenAtBottomTimer = null;
	function _markSeenAtBottom() {
		if (_seenAtBottomTimer || state.initializingChat) return;
		const list = messages[state.contactUserId] || [];
		if (!list.some((m) => !m.user && m.isSeen !== true)) return;
		_seenAtBottomTimer = setTimeout(() => {
			_seenAtBottomTimer = null;
			markOpenChatSeen();
		}, 300);
	}

	initSocket({
		onMessage: (msg) => {
			// the partner's message ends their "typing..."
			const open = contacts.find((c) => c.id === state.contactUserId);
			if (
				open &&
				msg &&
				String(msg.conversationId) === String(open.conversationId) &&
				Number(msg.senderId) !== Number(currentUser.id)
			)
				_setTyping("");
			return receiveMessage(msg);
		},
		onMessageEdited: _onMessageEdited,
		onMessageDeleted: _onMessageDeleted,
		onMessagesBulkDeleted: _onChatCleared,
		onUserOnline: (userId) => _onPresence(userId, true),
		onUserOffline: (userId, lastSeen) => _onPresence(userId, false, lastSeen),
		// payload: { conversationId, messageIds, seenBy }
		onMessageSeen: (payload) => {
			handleMessagesSeen(payload?.conversationId, payload?.messageIds, payload?.seenBy ?? null);
		},
		onTypingStart: (userId) => _onTyping(userId, true),
		onTypingStop: (userId) => _onTyping(userId, false),
		onMessagePinned: _onMessagePinned,
		onUserUpdated: _handleUserUpdated,
		onContactRemoved: _onContactRemoved,
		onReactionUpdated: _onReactionUpdated,
		onReconnect: () => {
			_resyncAfterReconnect().catch(() => {});
		},
	});
	try {
		setOnetimeDeletedHandler(handleOnetimeDeleted);
		setCapsuleOpenedHandler(handleCapsuleOpened);
	} catch (e) {
		/* ignore */
	}

	// Coming back to the app with a chat open: its new messages are read now.
	// Wait a moment so the server has heard that this tab is visible again.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible" || state.contactUserId == null) return;
		setTimeout(() => {
			if (document.visibilityState === "visible" && state.contactUserId != null) markOpenChatSeen();
		}, 400);
	});

	// Leave the open conversation when the page goes away
	window.addEventListener("beforeunload", () => {
		try {
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (friend && friend.conversationId) {
				getSocket()?.emit("conversation:leave", {
					conversationId: friend.conversationId,
				});
			}
		} catch (e) {
			/* ignore */
		}
	});

	function updateContactsEmptyState() {
		const empty = document.getElementById("contacts-empty");
		if (!empty) return;
		// Show placeholder when there are no contacts
		empty.style.display =
			Array.isArray(contacts) && contacts.length > 0 ? "none" : "flex";
	}

	// Pin, mute, delete chat, block and archive from a card's menu or swipe.
	// `userId` is the Contact row id of that card; the chat on screen stays
	// as it is.
	function _onContactAction(action, userId) {
		const friend = contacts.find((c) => c.id === Number(userId));
		if (!friend) return;
		// Saved Messages can only be cleared
		if (friend.isSaved && action !== "delete") return;

		if (action === "pin") {
			const next = !friend.isPinned;
			friend.isPinned = next;
			_settleCardAfterToggle(friend);
			apiUpdateContact(friend.id, { isPinned: next }).catch(() => {
				friend.isPinned = !next;
				_settleCardAfterToggle(friend);
				showToast("Couldn't update. Try again.");
			});
			return;
		}
		if (action === "mute") {
			const next = !friend.isMuted;
			friend.isMuted = next;
			refreshCard(friend);
			apiUpdateContact(friend.id, { isMuted: next }).catch(() => {
				friend.isMuted = !next;
				refreshCard(friend);
				showToast("Couldn't update. Try again.");
			});
			return;
		}
		if (action === "delete") {
			handleDeleteChat(friend.id);
			return;
		}
		if (action === "block") {
			handleBlockContact(friend.id);
			return;
		}
		if (action === "archive") {
			if (friend.isArchived) _unarchiveContact(friend.id);
			else _archiveContact(friend.id);
		}
	}

	function _settleCardAfterToggle(friend) {
		if (friend.isPinned) moveToActiveChats(friend);
		else _settleCard(friend);
		sortActiveChats();
		sortContacts();
	}

	function openPinnedView() {
		pinnedViewList.textContent = "";

		const allPinned = getPinnedData(state.contactUserId);
		const friend = contacts.find((c) => c.id === state.contactUserId);

		let source = [];
		if (Array.isArray(allPinned) && allPinned.length > 0) {
			source = allPinned.slice().reverse();
		} else if (
			Array.isArray(state.pinnedIndexes) &&
			state.pinnedIndexes.length > 0
		) {
			const msgs = messages[state.contactUserId] || [];
			source = [...state.pinnedIndexes]
				.reverse()
				.map((idx) => msgs[idx])
				.filter(Boolean);
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
			const senderLabel =
				msg.senderId &&
				Number(msg.senderId) === Number(getCurrentUser()?.id)
					? "You"
					: friend?.nickname || friend?.name || "";
			sender.textContent = senderLabel;
			const time = document.createElement("span");
			time.className = "pinned-view-item-time";
			time.textContent =
				msg.time ||
				(msg.createdAt
					? new Date(msg.createdAt).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
							hour12: false,
						})
					: "");
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
						const msgEl = chatEl.querySelector(
							`[data-message-id="${msg.id}"]`,
						);
						if (msgEl) {
							highlightMessage(msgEl);
						}
					} catch (e) {
						/* ignore */
					}
					return;
				}

				// Fallback for index-based source
				if (typeof msg.index !== "undefined") {
					const msgEl = chatEl.querySelector(
						`[data-index="${msg.index}"]`,
					);
					if (!msgEl) return;
					state.isProgrammaticScroll = true;
					msgEl.scrollIntoView({
						behavior: "smooth",
						block: "center",
					});
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

	// ─── Contacts: first load (skeletons meanwhile) ──────────────────────────
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

	let _contactsLoaded = false;
	try {
		const rows = await fetchAllContacts();
		rows.forEach((row) => {
			const c = normalizeServerContact(row, currentUser.id);
			c._previousContainer = "contacts";
			// a message may have brought some of them in already
			const existing = contacts.find((x) => x.id === c.id);
			if (existing) Object.assign(existing, c);
			else contacts.push(c);
		});
		_contactsLoaded = true;
	} catch (err) {
		console.error("Failed to load contacts", err);
	}

	// remove skeleton placeholders before rendering real cards
	[contactsContainer, activeChatsContainer].forEach((el) => {
		if (!el) return;
		el.querySelectorAll(".skeleton-placeholder").forEach((n) => n.remove());
		el.removeAttribute("aria-busy");
	});
	// Saved Messages, pinned chats and chats with something unread go to
	// Active Chats. The Contacts section is rendered from data in
	// sortContacts(): most recent message first, then contacts without
	// messages, then blocked ones; only the first 8 are shown here.
	contacts.forEach(_placeCard);
	updateTotalUnreadCount();
	sortActiveChats();
	sortContacts();
	updateContactsEmptyState();

	if (_contactsLoaded) {
		_openFromLink();
	} else {
		showToast("Couldn't load your chats. Retrying…");
		const retry = (delay) =>
			setTimeout(() => {
				_syncContacts()
					.then(() => _openFromLink())
					.catch(() => retry(Math.min(delay * 2, 30000)));
			}, delay);
		retry(3000);
	}

	// A notification tapped while the app was closed opens its chat (and message)
	function _openFromLink() {
		try {
			const params = new URLSearchParams(window.location.search);
			const convParam = params.get("conversationId");
			const midParam = params.get("messageId");
			if (!convParam) return;
			// a reload must not open it again
			try {
				params.delete("conversationId");
				params.delete("messageId");
				const qs = params.toString();
				history.replaceState(
					history.state,
					"",
					window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
				);
			} catch (e) {
				/* ignore */
			}
			const contact = contacts.find(
				(x) => String(x.conversationId) === String(convParam),
			);
			if (contact)
				openChatWithContact(contact.id, {
					focusMessageId: midParam ? Number(midParam) : null,
				}).catch(() => {});
		} catch (e) {
			/* ignore */
		}
	}

	// The service worker reports a tapped notification while the app is open
	try {
		navigator.serviceWorker?.addEventListener?.("message", (ev) => {
			const data = ev.data || {};
			if (data.type !== "push:click") return;
			const payload = data.payload || {};
			if (!payload.conversationId) return;
			const contact = contacts.find(
				(x) => String(x.conversationId) === String(payload.conversationId),
			);
			if (contact)
				openChatWithContact(contact.id, {
					focusMessageId: payload.messageId || null,
				}).catch(() => {});
		});
	} catch (e) {
		/* ignore */
	}

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

	function _closeSearch() {
		searchbar.classList.remove("open");
		clearTimeout(_searchDebounce);
		if (searchInput.value || _lastSearchQuery) {
			searchInput.value = "";
			_lastSearchQuery = "";
			runSearch("");
		}
	}

	if (searchInput) {
		searchbar.addEventListener("click", (e) => {
			// typing in the box must not fold it away
			if (e.target === searchInput) {
				searchbar.classList.add("open");
				return;
			}
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
		searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				_closeSearch();
				searchInput.blur();
			}
		});
	}

	if (logoutBtn) {
		let loggingOut = false;
		logoutBtn.addEventListener("click", async () => {
			if (loggingOut) return; // ignore double taps
			loggingOut = true;
			// This device's push subscription: the server stops only its
			// notifications (other devices stay signed in)
			let endpoint = null;
			try {
				if (window.pushEndpoint)
					endpoint = await Promise.race([
						window.pushEndpoint(),
						new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
					]);
			} catch (e) {
				endpoint = null;
			}
			try {
				await apiLogout(endpoint);
			} catch (err) {
				// The session cookie is HttpOnly: only the server can end it. If
				// that failed, say so instead of silently staying on a dead page.
				console.error("Logout failed", err);
				loggingOut = false;
				showToast("Couldn't log out. Check your connection and try again.");
				return;
			}
			try {
				getSocket()?.disconnect();
			} catch (e) {
				// ignore
			}
			// Remove the browser's subscription too. Never let it block the
			// logout (it used to wait forever when no service worker existed).
			try {
				if (window.pushUnsubscribe)
					await Promise.race([
						window.pushUnsubscribe({ notifyServer: false }),
						new Promise((resolve) => setTimeout(resolve, 2000)),
					]);
			} catch (e) {
				// push unsubscribe failed (suppressed)
			}
			try {
				localStorage.removeItem("user");
			} catch (e) {
				/* ignore */
			}
			// replace(): the back button must not bring the chat page back
			window.location.replace("/auth/auth.html");
		});
	}

	// ─── Close chat ───────────────────────────────────────────────────────────
	if (closeChatBtn) {
		closeChatBtn.addEventListener("click", (e) => {
			e.stopPropagation();
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
			chatEl.textContent = "";
			closeChat();
		});
	}

	// ─── Opening a chat ───────────────────────────────────────────────────────
	// Every way of opening a chat (cards, All contacts, search, notifications,
	// forwarding, a new contact, archived chats) goes through here.
	async function openChatWithContact(userId, { focusMessageId = null } = {}) {
		userId = Number(userId);
		if (!Number.isFinite(userId)) return;
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;
		const seq = ++_openSeq;

		const prevFriend = contacts.find((c) => c.id === state.contactUserId);
		if (prevFriend && prevFriend.id !== userId) {
			// leave the previous conversation room
			try {
				if (prevFriend.conversationId)
					getSocket()?.emit("conversation:leave", {
						conversationId: prevFriend.conversationId,
					});
			} catch (e) {
				/* ignore */
			}
			// a menu, selection, edit, reply, send mode or profile belongs to
			// the previous chat
			if (state.isProfileDialogOpen) closeProfile();
			if (state.isMenuOpen) closeContextMenu();
			if (state.isSelecting) cancelSelection();
			if (state.isEditing || state.replyTo || state.isForwarding) {
				state.isEditing = false;
				state.editingMessageId = null;
				state.replyTo = null;
				state.isForwarding = false;
				state.forwardingMsg = null;
				state.forwardingMsgs = [];
				resetInput();
			}
			try {
				document.dispatchEvent(new CustomEvent("chat:closed"));
			} catch (e) {
				/* ignore */
			}
			// it stays in Active Chats only when something keeps it there
			if (
				!prevFriend.isPinned &&
				!prevFriend.isSaved &&
				!prevFriend.unreadCount &&
				prevFriend.lastMessageSeen !== false
			) {
				moveToContacts(prevFriend);
			}
		}

		state.contactUserId = userId;
		_setTyping("");

		// join the conversation room so the server knows this chat is on screen
		if (friend.conversationId) {
			setActiveConversation(friend.conversationId);
			try {
				getSocket()?.emit("conversation:join", {
					conversationId: friend.conversationId,
				});
			} catch (e) {
				/* ignore */
			}
		}

		if ((friend.unreadCount || 0) > 0) friend.lastMessageSeen = true;
		friend.unreadCount = 0;
		updateTotalUnreadCount();

		// The open chat has a card in Active Chats (archived chats stay hidden)
		if (!friend.isArchived) {
			if (friend.isSaved) refreshCard(friend);
			else moveToActiveChats(friend);
		}
		sortActiveChats();
		sortContacts();

		setChatHeader(friend);
		applyComposerState(friend);
		try {
			await openChat(true);
		} catch (e) {
			/* ignore */
		}
		// another chat was opened meanwhile
		if (seq !== _openSeq || state.contactUserId !== userId) return;

		// a chat added from someone we talked to before has its history back
		if (!friend.lastMessageId && Array.isArray(messages[userId]) && messages[userId].length) {
			_previewFromLoaded(friend);
			refreshCard(friend);
			sortActiveChats();
		}
		if (focusMessageId != null && focusMessageId !== "") await _focusMessage(focusMessageId);
	}

	// Scrolls to a message (loading older pages when needed) and highlights it
	async function _focusMessage(messageId) {
		const contactId = state.contactUserId;
		// let the chat finish its own first scroll to the bottom
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))),
		);
		if (state.contactUserId !== contactId) return;
		try {
			await scrollToPinnedMessage(messageId);
			const el = chatEl?.querySelector(`.chat-message[data-message-id="${messageId}"]`);
			if (el) highlightMessage(el);
		} catch (e) {
			/* ignore */
		}
	}

	if (activeChatsContainer) {
		activeChatsContainer.addEventListener("click", (e) => {
			const active = e.target.closest(".active-chat");
			if (!active) return;
			openChatWithContact(Number(active.dataset.userId)).catch(() => {});
		});
	}

	if (contactsContainer) {
		contactsContainer.addEventListener("click", (e) => {
			// the card's own ⋮ menu must not open the chat
			if (
				e.target.closest(
					".contact-menu-btn, .contact-menu-overlay, .contact-menu-panel",
				)
			)
				return;
			const card = e.target.closest(".contacts-card");
			if (!card) return;
			openChatWithContact(Number(card.dataset.userId)).catch(() => {});
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
				normal: () => originalSendBtnInner || "",
				"one-time": () => oneTimeSendIcon,
				"time-capsule": () => capsuleSvg,
			};
			const MODE_LABEL = {
				normal: "Send normally",
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
				if (capsuleBtn)
					capsuleBtn.innerHTML = MODE_ICON[topMode]?.() || "";
				if (capsuleLabel)
					capsuleLabel.textContent = MODE_LABEL[topMode] || "";
				if (onetimeBtn)
					onetimeBtn.innerHTML = MODE_ICON[botMode]?.() || "";
				if (onetimeLabel)
					onetimeLabel.textContent = MODE_LABEL[botMode] || "";
			}

			function swapWithMain(slotIdx) {
				// If main was time-capsule, clear its pending state
				if (sendModeSlots[0] === "time-capsule") {
					window._pendingCapsuleScheduledFor = null;
				}
				[sendModeSlots[0], sendModeSlots[slotIdx]] = [
					sendModeSlots[slotIdx],
					sendModeSlots[0],
				];
				applyMainSlot();
				try {
					renderPopup();
				} catch (e) {
					/* ignore */
				}
			}

			function resetSlots() {
				sendModeSlots = ["normal", "time-capsule", "one-time"];
				window._pendingCapsuleScheduledFor = null;
				state.sendMode = "normal";
				if (sendMessageBtn && originalSendBtnInner)
					sendMessageBtn.innerHTML = originalSendBtnInner;
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
					const truncateToMinute = (d) =>
						new Date(
							d.getFullYear(),
							d.getMonth(),
							d.getDate(),
							d.getHours(),
							d.getMinutes(),
							0,
							0,
						);
					const nowTrunc = truncateToMinute(new Date());
					const minDate = new Date(
						nowTrunc.getTime() + 5 * 60 * 1000,
					);
					const maxDate = new Date(
						nowTrunc.getTime() + 365 * 24 * 60 * 60 * 1000,
					);
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
							const truncateToMinute = (d) =>
								new Date(
									d.getFullYear(),
									d.getMonth(),
									d.getDate(),
									d.getHours(),
									d.getMinutes(),
									0,
									0,
								);
							const scheduledTrunc = truncateToMinute(sfLocal);
							const nowTrunc2 = truncateToMinute(new Date());
							const minTime = new Date(
								nowTrunc2.getTime() + 5 * 60 * 1000,
							);
							const maxTime = new Date(
								nowTrunc2.getTime() + 365 * 24 * 60 * 60 * 1000,
							);
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
							sendModeSlots[0] = "time-capsule";
							sendModeSlots[slotIndex] = prevMain;
							state.sendMode = "time-capsule";
							window._pendingCapsuleScheduledFor = scheduledFor;
							if (sendMessageBtn)
								sendMessageBtn.innerHTML = capsuleSvg;
							try {
								renderPopup();
							} catch (e) {
								/* ignore */
							}
						});
				};

				capsuleBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					if (sendModeSlots[1] === "time-capsule") {
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
					if (sendModeSlots[1] === "time-capsule")
						openCapsulePicker(1, e);
					else {
						swapWithMain(1);
						hideOneTime();
					}
				});

				onetimeWrap.appendChild(onetimeLabel);
				onetimeWrap.appendChild(onetimeBtn);
				// Ensure popup icons/labels reflect current slot ordering
				try {
					renderPopup();
				} catch (e) {
					/* ignore */
				}
				// group both trigger buttons into a single container to simplify
				// outside-click handling and DOM management
				triggerContainer.appendChild(capsuleWrap);
				triggerContainer.appendChild(onetimeWrap);
				messageContainer.appendChild(triggerContainer);

				onetimeBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					if (sendModeSlots[2] === "time-capsule") {
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
					try {
						resetSlots();
					} catch (_e) {
						/* ignore */
					}
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
				if (triggerContainer && triggerContainer.contains(e.target))
					return;
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

				// a moving finger (scrolling) is not a long press
				if (Math.abs(dx) > 10 || Math.abs(dy) > 10)
					clearTimeout(state.touchTimeout);

				// if its more likely vertical, its not swipe
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
				toggleSelectedMessage(msg);
				return;
			}

			const reply = e.target.closest(".chat-reply");
			if (!reply) return;
			// The quoted message, by id (older pages are loaded when needed)
			const target = reply.dataset.replyTo;
			if (!target) return;
			const targetMsg = chatEl.querySelector(
				`.chat-message[data-message-id="${target}"]`,
			);
			if (targetMsg) {
				targetMsg.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				highlightMessage(targetMsg);
			} else if (/^\d+$/.test(target)) {
				scrollToPinnedMessage(target)
					.then(() => {
						const el = chatEl.querySelector(
							`.chat-message[data-message-id="${target}"]`,
						);
						if (el) highlightMessage(el);
					})
					.catch(() => {});
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
			// reached the newest messages: they are read now
			if (distanceFromBottom < 80) _markSeenAtBottom();

			// If server-provided pinned data exists, prefer locating by messageId
			const allPinned = getPinnedData(state.contactUserId);
			if (Array.isArray(allPinned) && allPinned.length > 0) {
				for (let i = allPinned.length - 1; i >= 0; i--) {
					const mid = allPinned[i].id;
					const msgEl = chatEl.querySelector(
						`[data-message-id="${mid}"]`,
					);
					if (!msgEl) continue;
					const rect = msgEl.getBoundingClientRect();
					const chatRect = chatEl.getBoundingClientRect();
					// consider the message visible if any part overlaps the chat viewport
					if (
						rect.bottom >= chatRect.top &&
						rect.top <= chatRect.bottom
					) {
						pinnedMessageText.dataset.messageId = String(mid);
						pinnedMessageText.textContent = allPinned[i].text || "";
						// update pin-count UI (mirror chat.js helper)
						pinnedMessageCount.textContent = "";
						const total = Math.min(allPinned.length, 3);
						if (total > 0) {
							const pos = i;
							let activeSpan;
							if (allPinned.length <= 3) {
								activeSpan = pos;
							} else {
								if (pos === 0) activeSpan = 0;
								else if (pos === allPinned.length - 1)
									activeSpan = 2;
								else activeSpan = 1;
							}
							for (let s = 0; s < total; s++) {
								const span = document.createElement("span");
								if (s === activeSpan) {
									span.style.height = "1.2rem";
									span.style.opacity = "1";
								} else {
									span.style.height = "0.6rem";
									span.style.opacity = "0.4";
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
					if (
						rect.bottom >= chatRect.top &&
						rect.top <= chatRect.bottom
					) {
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
			state.editingMessageId = null;
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
		// closed without choosing (button, Esc or a chat was picked): a later
		// single-message forward must not be taken for a selection forward
		forwardDialog.addEventListener("close", () => {
			state.isSelectionForwarding = false;
		});

		forwardDialog.addEventListener("click", async (e) => {
			const card = e.target.closest(".forwarded-contact-card");
			if (!card) return;

			const target = contacts.find(
				(c) => c.id === Number(card.dataset.userId),
			);
			if (!target) return;

			if (state.isSelectionForwarding) {
				const source = contacts.find((c) => c.id === state.contactUserId);
				executeBulkForward(target, displayName(source) || "Unknown");
				return;
			}

			// Single message: built while the source chat is still on screen
			const sourceId = state.contactUserId;
			const original = (messages[sourceId] || [])[Number(state.msgIndex)];
			forwardDialog.close();
			if (!original || original.id == null) return;
			const source = contacts.find((c) => c.id === sourceId);
			const senderName = original.user ? "You" : displayName(source) || "Unknown";
			const forwardingMsg = buildForwardedMsg(original, target.id);

			await openChatWithContact(target.id);
			if (state.contactUserId !== target.id || target.isBlocked || target.isDeleted) return;

			msgAction.style.display = "flex";
			state.actionPreviewHeight =
				msgAction.getBoundingClientRect().height / 14;
			chatEl.style.paddingBottom =
				basePadding + state.actionPreviewHeight + "rem";
			msgActionText.textContent = "Forwarding message from " + senderName;
			msgActionmsg.textContent = original.text || "";
			messageInput.style.borderRadius = "0 0 2rem 2rem";
			sendMessageBtn.style.display = "block";
			// Wait for padding/layout changes (msgAction) then scroll.
			scrollChatToBottomAfterPadding();

			state.isForwarding = true;
			state.forwardingMsg = forwardingMsg;
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
			const msg = (messages[state.contactUserId] || [])[Number(state.msgIndex)];
			closeContextMenu();
			if (!msg || typeof msg.text !== "string") return;
			const copied = () => showToast("Message copied", copyIcon);
			// The clipboard API exists only on https (and localhost)
			const fallback = () => {
				try {
					const area = document.createElement("textarea");
					area.value = msg.text;
					area.setAttribute("readonly", "");
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					const ok = document.execCommand("copy");
					area.remove();
					if (ok) copied();
					else showToast("Couldn't copy the message");
				} catch (e) {
					showToast("Couldn't copy the message");
				}
			};
			if (navigator.clipboard?.writeText) {
				navigator.clipboard.writeText(msg.text).then(copied, fallback);
			} else {
				fallback();
			}
		});
	}

	if (editMsg[0]) editMsg[0].addEventListener("click", editMessage);
	if (replyMsg[0]) replyMsg[0].addEventListener("click", replyMessage);
	if (pinMsg[0])
		pinMsg[0].addEventListener("click", () => pinMessage(pinIcon));

	if (deleteMsg[0]) {
		deleteMsg[0].addEventListener("click", () => {
			const msgEl = state.selectedMsg;
			const msgIndex = state.msgIndex;
			const contactId = state.contactUserId;
			closeContextMenu();
			if (!msgEl) return;

			const friend = contacts.find((c) => c.id === contactId);
			const prev = friend
				? {
						lastMessage: friend.lastMessage,
						lastMessageId: friend.lastMessageId,
						lastMessageTime: friend.lastMessageTime,
						lastMessageDate: friend.lastMessageDate,
						lastMessageTs: friend.lastMessageTs,
						lastMessageSeen: friend.lastMessageSeen,
					}
				: null;

			// The message fades out and is deleted after the undo window
			const { timeout, deletedMsg } = deleteMessage(msgEl, msgIndex);
			state.deleting = timeout;

			// the card already shows the message before it
			if (friend && deletedMsg) {
				const remaining = (messages[contactId] || []).filter((m) => m !== deletedMsg);
				_setPreview(friend, remaining.length ? remaining[remaining.length - 1] : null);
				refreshCard(friend);
				sortActiveChats();
				sortContacts();
			}

			state.currentUndoAction = () => {
				// nothing was removed yet: just show it again
				undoDeleteMessage(msgEl);
				if (friend && prev) {
					Object.assign(friend, prev);
					_placeCard(friend);
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
			state.isSelectionForwarding = false;
			const list = forwardDialog.querySelector(".forwarded-contact-dialog");
			list.textContent = "";
			// only chats that can receive messages
			contacts
				.filter((c) => !c.isBlocked && !c.isDeleted)
				.forEach((contact) => {
					list.appendChild(createForwardedContactCard({ ...contact }));
				});
			forwardDialog.showModal();
		});
	}

	if (selectMsg[0]) {
		selectMsg[0].addEventListener("click", () => {
			enterSelectionMode(state.selectedMsg);
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
	// (wrapped: the handlers take a contact id, not the click event)
	if (detailsCloseBtn)
		detailsCloseBtn.addEventListener("click", () => closeProfile());
	deleteChatBtns.forEach((b) =>
		b.addEventListener("click", () => handleDeleteChat()),
	);
	editNameBtns.forEach((b) =>
		b.addEventListener("click", () => handleEditNickname()),
	);
	editNameDoneBtn.forEach((b) =>
		b.addEventListener("click", () => handleEditNicknameDone()),
	);
	cancelEditNameBtn.forEach((b) =>
		b.addEventListener("click", () => handleEditNicknameCancel()),
	);
	blockContactBtns.forEach((b) =>
		b.addEventListener("click", () => handleBlockContact()),
	);
	unblockActionBtn.forEach((b) =>
		b.addEventListener("click", () => handleBlockContact()),
	);
	deleteContactBtns.forEach((b) =>
		b.addEventListener("click", () => {
			handleDeleteContact();
			// the contact leaves the list when the undo time is over
			setTimeout(updateContactsEmptyState, 3200);
		}),
	);

	archiveContactBtns.forEach((btn) =>
		btn.addEventListener("click", () => {
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (!friend) return;
			if (friend.isArchived) {
				_unarchiveContact(friend.id).then(() => refreshProfile(friend));
				return;
			}
			_archiveContact(friend.id);
			state.skipShowChatOnProfileClose = true;
			closeProfile();
			setTimeout(() => {
				if (state.contactUserId !== friend.id) return;
				if (chatEl) chatEl.textContent = "";
				closeChat();
			}, 350);
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
			const friend = contacts.find((c) => c.id === state.contactUserId);
			if (!friend || friend.isBlocked || friend.isDeleted || state.isSelecting) return;
			// a draft in the box is not replaced
			if (messageInput.value.trim()) return;
			messageInput.value = "hi";
			messageInput.dispatchEvent(new Event("input"));
			sendMessage();
		});
	}

	// ─── Archived ──────────────────────────────────────────────────
	async function _archiveContact(userId) {
		const friend = contacts.find((c) => c.id === userId);
		if (!friend) return;
		const uid = Number(userId);
		if (!Number.isFinite(uid)) return;

		try {
			await apiUpdateContact(friend.id, { isArchived: true });
			friend.isArchived = true;

			const card =
				activeChatsContainer.querySelector(
					`[data-wrapper-user-id="${uid}"]`,
				) ||
				activeChatsContainer
					.querySelector(`[data-user-id="${uid}"]`)
					?.closest(".active-chat-wrapper") ||
				contactsContainer.querySelector(`[data-user-id="${uid}"]`);
			card?.remove();

			updateContactsEmptyState();
			updateTotalUnreadCount();
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
			updateTotalUnreadCount();
			showToast("Chat unarchived", archiveIcon);
		} catch (err) {
			console.error("Failed to unarchive contact", err);
			showToast("Failed to unarchive chat");
		}
	}

	function _openArchivedDialog() {
		if (!archivedDialog || !archivedDialogList) return;

		while (archivedDialogList.firstChild) {
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
							await _unarchiveContact(id);
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
							archivedDialog.close();
							closeSettings();
							await openChatWithContact(id);
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
		// a tap outside the search box and its results ends the search
		if (
			searchbar &&
			!searchbar.contains(e.target) &&
			!(searchResults && searchResults.contains(e.target))
		) {
			_closeSearch();
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
	// Double-tap zoom is turned off in CSS (touch-action: manipulation): a
	// touchend blocker here used to swallow quick second taps on buttons.
});
