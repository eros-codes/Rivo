import { state, messages, contacts, getMessageByIndex } from "./state.js";
import { showEmptyState, showToast } from "./ui.js";
import {
	// Scroll helper that waits for padding transition
	scrollChatToBottomAfterPadding,
	updatePinnedMessage,
	basePadding,
	nearBottom,
} from "./chat.js";
import {
	refreshCard,
	moveToContacts,
	sortActiveChats,
	sortContacts,
	updateTotalUnreadCount,
} from "./chat-logic.js";
import { emitDeleteMessage, emitPinMessage, emitReaction } from "./socket.js";
import { parseSvg } from "../../../utils/svg.js";

const pinIconForMenu = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z"/></svg>`;
const unpinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="m20.97 17.172l-1.414 1.414l-3.535-3.535l-.073.074l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243L5.34 8.761l3.536-.707l.073-.074l-3.536-3.536L6.828 3.03zM10.365 9.394l-.502.502l-2.822.565l6.5 6.5l.564-2.822l.502-.502zm8.411.074l-1.34 1.34l1.414 1.415l1.34-1.34l.707.707l1.415-1.415l-8.486-8.485l-1.414 1.414l.707.707l-1.34 1.34l1.414 1.415l1.34-1.34z"/></svg>`;

const REACTION_PRESETS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const REACTION_BAR_GAP = 10; // px - fixed gap between message and reaction bar

const reactionBarEl = document.createElement("div");
reactionBarEl.className = "reaction-bar";
reactionBarEl.style.display = "none";
REACTION_PRESETS.forEach((emoji) => {
	const btn = document.createElement("button");
	btn.className = "reaction-bar-btn";
	btn.textContent = emoji;
	btn.dataset.emoji = emoji;
	reactionBarEl.appendChild(btn);
});
document.body.appendChild(reactionBarEl);

let _dom = {};
let _prevBodyOverflow = null;
let _prevBodyTouchAction = null;
const _preventScroll = (e) => {
	try { e.preventDefault(); } catch (err) { /* ignore */ }
};

function _disableScrollWhileMenuOpen() {
	try {
		_prevBodyOverflow = document.body.style.overflow || "";
		_prevBodyTouchAction = document.body.style.touchAction || "";
		document.body.style.overflow = "hidden";
		document.body.style.touchAction = "none";
		document.addEventListener('wheel', _preventScroll, { passive: false, capture: true });
		document.addEventListener('touchmove', _preventScroll, { passive: false, capture: true });
	} catch (e) { /* ignore */ }
}

function _enableScrollAfterMenuClose() {
	try {
		document.removeEventListener('wheel', _preventScroll, { capture: true });
		document.removeEventListener('touchmove', _preventScroll, { capture: true });
		document.body.style.overflow = _prevBodyOverflow || "";
		document.body.style.touchAction = _prevBodyTouchAction || "";
	} catch (e) { /* ignore */ }
}

/**

- @param {{
- messageMenu, chatOverlay, editMsg,
- chatEl, emptyStateEl,
- messageInput, sendMessageBtn, msgAction, msgActionText, msgActionmsg,
- cancelEditBtn
- }} dom
  */
export function initContextMenu(dom) {
	_dom = dom;
}

// Reaction bar click handler
reactionBarEl.addEventListener("click", async (e) => {
	const btn = e.target.closest(".reaction-bar-btn");
	if (!btn) return;
	const emoji = btn.dataset.emoji;
	const idx = reactionBarEl.dataset.msgIndex;
	const msg = getMessageByIndex(state.contactUserId, idx);
	if (!msg?.id) return;

	closeContextMenu();

	try {
		await emitReaction(msg.id, emoji);
	} catch (err) {
		console.error("reaction emit failed", err);
		try { showToast("Failed to send reaction"); } catch (e) { /* ignore */ }
	}
});

// ─── Open ─────────────────────────────────────────────────────────────────────
export function openContextMenu(msg, e) {
	if (state.isMenuOpen) {
		if (msg.dataset.index == state.msgIndex) {
			closeContextMenu();
			return;
		}
		closeContextMenu();
	}
	state.msgIndex = msg.dataset.index;
	state.selectedMsg = msg;

	_dom.messageMenu.style.display = "block";

	// Compute whether message needs to be nudged up to fit the menu,
	// apply the transform first, then position the reaction bar using
	// the message's post-transform bounding rect so the bar sits
	// visually above the message itself (not the original position).
	const preRect = msg.getBoundingClientRect();
	const menuHeight = _dom.messageMenu.getBoundingClientRect().height;
	let translateAmount = 0;
	if (window.innerHeight - preRect.bottom < menuHeight) {
		translateAmount = menuHeight + preRect.bottom - window.innerHeight + 24;
		msg.style.transform = `translateY(-${translateAmount}px)`;
	}

	// Prepare reaction bar position but keep it hidden until the
	// context menu is shown. Measure the bar height invisibly so the
	// spacing above the message matches the bottom spacing used for
	// the context menu (uses `basePadding`).
	reactionBarEl.style.position = "fixed";
	// Temporarily render invisible to measure size without flashing
	reactionBarEl.style.visibility = "hidden";
	reactionBarEl.style.display = "flex";
	const barRect = reactionBarEl.getBoundingClientRect();
	reactionBarEl.style.display = "none";
	reactionBarEl.style.visibility = "";

	// Compute top so gap above equals fixed REACTION_BAR_GAP (px)
	const top = Math.max(8, preRect.top - barRect.height - REACTION_BAR_GAP - translateAmount);
	reactionBarEl.style.top = top + "px";
	if (msg.classList.contains("outgoing")) {
		reactionBarEl.style.right = (window.innerWidth - preRect.right) + "px";
		reactionBarEl.style.left = "auto";
	} else {
		reactionBarEl.style.left = preRect.left + "px";
		reactionBarEl.style.right = "auto";
	}
	reactionBarEl.dataset.msgIndex = msg.dataset.index;
	_dom.chatOverlay.style.display = "block";

	// Prevent the page/chat from scrolling while the context menu is open.
	_disableScrollWhileMenuOpen();
	msg.style.zIndex = 500;

	// Pin/Unpin label & icon
	const pinLabels = document.querySelectorAll(".pin-message p");
	const pinIconEl = document.querySelector(".pin-message span");
	const isPinned = state.pinnedIndexes.includes(Number(msg.dataset.index));
	if (pinLabels[0]) pinLabels[0].textContent = isPinned ? "Unpin" : "Pin";
	if (pinIconEl) {
		pinIconEl.textContent = "";
		const _i = parseSvg(isPinned ? unpinIcon : pinIconForMenu);
		if (_i) pinIconEl.appendChild(_i.cloneNode(true));
	}

	// Determine message object and ownership; forwarded messages can't be edited
	const messageObj = getMessageByIndex(state.contactUserId, state.msgIndex);
	const forwardedFrom = messageObj?.forwardedFrom;
	const isOwner = messageObj
		? !!messageObj.user
		: msg.classList.contains("outgoing");
	const editMsg0 = _dom.editMsg?.[0];
	if (editMsg0) {
		editMsg0.style.display = !forwardedFrom && isOwner ? "flex" : "none";
	}

	// Hide delete for incoming messages (only show for owner's messages)
	const deleteMsg0 = document.querySelectorAll(".delete-message")[0];
	if (deleteMsg0) {
		deleteMsg0.style.display = isOwner ? "flex" : "none";
	}

	// Position menu
	// Position the context menu below the (possibly shifted) message using
	// the same pre-transform rectangle and translateAmount so it moves
	// together with the message and reaction bar.
	_dom.messageMenu.style.top =
		preRect.top + preRect.height - translateAmount + basePadding + "px";

	if (msg.classList.contains("outgoing")) {
		_dom.messageMenu.style.right = window.innerWidth - preRect.right + "px";
		_dom.messageMenu.style.left = "";
	} else {
		_dom.messageMenu.style.left = preRect.left + "px";
		_dom.messageMenu.style.right = "";
	}

	state.isMenuOpen = true;
	// Show menu and reaction bar together to keep timing identical.
	setTimeout(() => {
		_dom.messageMenu.style.opacity = 1;
		_dom.chatOverlay.style.opacity = 1;
		// reveal reaction bar at the same time
		reactionBarEl.style.display = "flex";
	}, 100);

	if (e && typeof e.stopPropagation === "function") e.stopPropagation();
}

// ─── Close ────────────────────────────────────────────────────────────────────
export function closeContextMenu() {
	_dom.messageMenu.style.opacity = 0;
	_dom.chatOverlay.style.opacity = 0;
	_dom.messageMenu.style.display = "none";
	_dom.chatOverlay.style.display = "none";
	// hide reaction bar when menu closes
	reactionBarEl.style.display = "none";
	if (state.selectedMsg) {
		state.selectedMsg.style.zIndex = "";
		state.selectedMsg.style.transform = "translateY(0px)";
	}
	// Re-enable scrolling now that menu is closed
	_enableScrollAfterMenuClose();
	state.isMenuOpen = false;
}

// ─── Delete & undo ────────────────────────────────────────────────────────────
export function deleteMessage(msg, index) {
	const idx = Number(index);
	const capturedContactId = state.contactUserId;
	const arr = Array.isArray(messages[capturedContactId])
		? messages[capturedContactId]
		: [];
	const deletedMsg = arr[idx];
	const messageId = deletedMsg?.id;

	msg.style.transition = "opacity 3s ease";
	msg.style.opacity = 0;
	const timeout = setTimeout(() => {
		// after undo window, attempt server deletion and then finalize local removal on success
		(async () => {
			try {
				if (messageId) await emitDeleteMessage(messageId);

				// Remove message by id if possible, otherwise by localId, otherwise by index
				const currentArr = messages[capturedContactId] || [];
				let removeIdx = -1;
				if (messageId)
					removeIdx = currentArr.findIndex((m) => m.id === messageId);
				if (removeIdx === -1 && deletedMsg && deletedMsg._localId)
					removeIdx = currentArr.findIndex(
						(m) => m._localId === deletedMsg._localId,
					);
				if (removeIdx === -1) removeIdx = idx;

				// Determine which message object will be removed so we can
				// adjust unread counts for incoming, unseen messages.
				let removedCandidate = null;
				if (removeIdx !== -1 && removeIdx < currentArr.length) {
					removedCandidate = currentArr[removeIdx];
				} else if (deletedMsg) {
					removedCandidate = deletedMsg;
				}

				// Update DOM and data structures
				msg.remove();
				if (removeIdx !== -1 && removeIdx < currentArr.length) {
					currentArr.splice(removeIdx, 1);
				}

				// If we removed an incoming message that was not seen by the
				// current user, decrement the unread counter for this contact.
				try {
					const friend = contacts.find(
						(c) => c.id === capturedContactId,
					);
					if (
						friend &&
						removedCandidate &&
						!removedCandidate.user &&
						!removedCandidate.isSeen
					) {
						friend.unreadCount = Math.max(
							0,
							(friend.unreadCount || 0) - 1,
						);
						updateTotalUnreadCount();
					}
				} catch (e) {
					/* ignore unread update errors */
				}
				currentArr.forEach((m, i) => (m.index = i));

				// Re-index DOM elements
				document
					.querySelectorAll(".chat-message")
					.forEach((msgEl, i) => {
						msgEl.dataset.index = i;
					});

				state.pinnedIndexes = currentArr
					.map((m, i) => (m.isPinned ? i : -1))
					.filter((i) => i !== -1);

				const remaining = currentArr;

				const friend = contacts.find(
					(c) => c.id === capturedContactId,
				);
				if (friend) {
					if (remaining.length > 0) {
						const lastMsg = remaining.at(-1);
						friend.lastMessage = lastMsg.text;
						friend.lastMessageTime = lastMsg.time;
						friend.lastMessageDate = lastMsg.date || "";
						// Only explicit `false` means unseen.
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
					}
				}
				if (remaining.length === 0) {
					showEmptyState(_dom.chatEl, _dom.emptyStateEl);
				}
			} catch (e) {
				// server delete failed; restore message opacity and notify
				console.error("deleteMessage failed", e);
				msg.style.transition = "opacity 0.15s ease";
				msg.style.opacity = 1;
				setTimeout(() => {
					msg.style.transition = "";
				}, 150);
				// optionally show toast via UI; keep message in state
			}
		})();
	}, 3000);

	return { timeout, deletedMsg, idx };
}

export function undoDeleteMessage(msg) {
	clearTimeout(state.deleting);
	msg.style.transition = "opacity 0.15s ease";
	msg.style.opacity = 1;
	setTimeout(() => {
		msg.style.transition = "";
	}, 150);
}

// ─── Build forwarded message ──────────────────────────────────────────────────
export function buildForwardedMsg(originalMsg, targetContactId) {
	const senderName = originalMsg.user
		? "You"
		: (contacts.find((c) => c.id === state.contactUserId)?.name ??
			"Unknown");
	return {
		user: true,
		text: originalMsg.text,
		time: new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}),
		date: new Date().toISOString().slice(0, 10),
		isEdited: false,
		replyTo: null,
		forwardedFrom: senderName,
		isSeen: false,
		index: (messages[targetContactId] || []).length,
	};
}

// ─── Pin / Unpin ──────────────────────────────────────────────────────────────
export async function pinMessage(pinIconSvg) {
	const idx = Number(state.selectedMsg?.dataset.index);
	const contactId = state.contactUserId;
	const msg = getMessageByIndex(contactId, idx);
	const messageId = msg?.id;
	if (!messageId) {
		closeContextMenu();
		return;
	}

	const msgEl = _dom.chatEl.querySelector(`[data-index="${idx}"]`);
	const meta = msgEl ? msgEl.querySelector(".chat-message-meta") : null;
	let existingIcon = msgEl ? msgEl.querySelector(".chat-pinned-icon") : null;

	try {
		// Wait for server ack; time out if it takes too long to avoid
		// leaving the UI in an indeterminate state.
		const isPinned = await Promise.race([
			emitPinMessage(messageId),
			new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout")), 5000)),
		]);

		// Apply server-approved state to model and DOM
		if (isPinned) {
			msg.isPinned = true;
			existingIcon = msgEl ? msgEl.querySelector(".chat-pinned-icon") : null;
			if (msgEl && !existingIcon && meta) {
				const pinSpan = document.createElement("span");
				pinSpan.className = "chat-pinned-icon";
				pinSpan.textContent = "";
				const _p = parseSvg(pinIconSvg);
				if (_p) pinSpan.appendChild(_p.cloneNode(true));
				msg.user ? meta.prepend(pinSpan) : meta.appendChild(pinSpan);
			}
			// update pinned indexes for the conversation we acted on,
			// but avoid clobbering the global `state.pinnedIndexes` for
			// a different conversation that may now be visible.
			if (contactId === state.contactUserId) {
				state.pinnedIndexes = (messages[contactId] || [])
					.map((m, i) => (m.isPinned ? i : -1))
					.filter(i => i !== -1)
					.sort((a,b)=>a-b);
			}
		} else {
			msg.isPinned = false;
			if (msgEl) {
				const existing = msgEl.querySelector(".chat-pinned-icon");
				if (existing) existing.remove();
			}
			if (contactId === state.contactUserId) {
				state.pinnedIndexes = (messages[contactId] || [])
					.map((m, i) => (m.isPinned ? i : -1))
					.filter(i => i !== -1)
					.sort((a,b)=>a-b);
			}
		}

		// Refresh the pinned banner for the conversation we updated.
		updatePinnedMessage(contactId);
	} catch (e) {
		console.error('pinMessage failed', e);
		showToast('Failed to update pin');
	} finally {
		closeContextMenu();
	}
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
export function editMessage() {
	const msg = getMessageByIndex(state.contactUserId, Number(state.msgIndex));
	if (!msg) return;

	// Determine if user was near bottom before we change layout (used to keep view pinned)
	const wasNearBottomBefore = nearBottom(_dom.chatEl, 20);

	state.isEditing = true;

	// Breadcrumb for monitoring (optional, if Sentry loaded)
	try {
		if (
			typeof window !== "undefined" &&
			window.Sentry &&
			window.Sentry.addBreadcrumb
		) {
			window.Sentry.addBreadcrumb({
				category: "edit",
				message: "enter_edit",
				data: { messageId: msg?.id },
			});
		}
	} catch (e) {
		void e;
	}

	// Show action preview first so padding calculation has the correct height
	if (_dom.msgAction) {
		_dom.msgAction.style.display = "flex";
		state.actionPreviewHeight =
			_dom.msgAction.getBoundingClientRect().height / 14;
		_dom.msgActionText.textContent = "Edit";
		_dom.msgActionmsg.textContent = msg.text;
	}

	const msgInputEl =
		_dom.messageInput || document.querySelector(".message-input");
	if (msgInputEl) {
		msgInputEl.value = msg.text;
		if (typeof msgInputEl.focus === "function") msgInputEl.focus();
		try {
			msgInputEl.selectionStart = msgInputEl.selectionEnd =
				msgInputEl.value.length;
		} catch (e) {
			void e;
		}

		// Dispatch the input event on next RAF to avoid layout race between
		// showing the action preview and autosize calculation.
		requestAnimationFrame(() => {
			try {
				msgInputEl.dispatchEvent(new Event("input", { bubbles: true }));
			} catch (e) {
				void e;
			}
			// Ensure the textarea height is explicitly set after autosize
			try {
				msgInputEl.style.height = msgInputEl.scrollHeight + "px";
			} catch (e) {
				void e;
			}
			// Do not scroll here; main input handler will handle scroll-after-padding.
		});
	}

	// ensure chat padding uses action-preview height (input handler may override)
	_dom.chatEl.style.paddingBottom =
		basePadding + state.actionPreviewHeight + "rem";
	closeContextMenu();

	_dom.messageInput.style.borderRadius = "0 0 2rem 2rem";
	_dom.sendMessageBtn.style.display = "block";
	// If user was near bottom before editing, wait for the padding transition
	// to finish and then scroll to bottom.
	if (wasNearBottomBefore) scrollChatToBottomAfterPadding();
}

// ─── Reply ────────────────────────────────────────────────────────────────────
export function replyMessage() {
	const msg = getMessageByIndex(state.contactUserId, Number(state.msgIndex));
	if (!msg) return;
	const senderName = msg.user
		? "You"
		: contacts.find((c) => c.id === state.contactUserId)?.name;
	_dom.msgAction.style.display = "flex";
	state.actionPreviewHeight =
		_dom.msgAction.getBoundingClientRect().height / 14;
	_dom.chatEl.style.paddingBottom =
		basePadding + state.actionPreviewHeight + "rem";
	_dom.msgActionText.textContent = "Replying to " + senderName;
	_dom.msgActionmsg.textContent = msg.text;
	const msgInputEl2 =
		_dom.messageInput || document.querySelector(".message-input");
	if (msgInputEl2 && typeof msgInputEl2.focus === "function") {
		msgInputEl2.focus();
		if (msgInputEl2.style) msgInputEl2.style.borderRadius = "0 0 2rem 2rem";
	}

	state.replyTo = {
		text: msg.text,
		sender: senderName,
		index: Number(state.msgIndex),
		id: msg.id,
	};
	closeContextMenu();

	if (
		nearBottom(
			_dom.chatEl,
			(_dom.msgAction?.getBoundingClientRect().height || 0) + 20,
		)
	)
		scrollChatToBottomAfterPadding();
}
