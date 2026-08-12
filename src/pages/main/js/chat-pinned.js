import { getCurrentUserId } from "../../../utils/user.js";
import { canLoadOlder, clearOpenSuppression, loadOlderMessages } from "./chat-paging.js";
import { _dom, pinnedData } from "./chat-state.js";
import { messages, state } from "./state.js";
import { showToast } from "./ui.js";

export function getPinnedData(contactId) {
	return pinnedData[contactId] || [];
}

// Update in-memory pinned cache for a contact. Used by UI actions
// (pin/unpin) so the pinned banner reflects changes immediately.
export function updatePinnedData(contactId, messageId, messageObj, isPinned) {
	try {
		if (!contactId) return;
		if (!pinnedData[contactId]) pinnedData[contactId] = [];
		const arr = pinnedData[contactId];
		const mid = String(messageId || (messageObj && messageObj.id) || '');
		if (!mid) return;
		if (isPinned) {
			const exists = arr.some((p) => String(p.id) === String(mid));
			if (!exists) {
				arr.push({
					id: mid,
					text: (messageObj && messageObj.text) || '',
					senderId: messageObj && messageObj.user ? getCurrentUserId() : (messageObj && messageObj.senderId) || null,
					createdAt: (messageObj && messageObj.createdAt) || Date.now(),
				});
			}
		} else {
			pinnedData[contactId] = arr.filter((p) => String(p.id) !== String(mid));
		}
	} catch (e) {}
}

export function updatePinCount(activeIdx) {
	_dom.pinnedMessageCount.textContent = "";
	const total = Math.min(state.pinnedIndexes.length, 3);
	if (total === 0) return;

	const pos = state.pinnedIndexes.indexOf(activeIdx);
	let activeSpan;
	if (state.pinnedIndexes.length <= 3) {
		activeSpan = pos;
	} else {
		if (pos === 0) activeSpan = 0;
		else if (pos === state.pinnedIndexes.length - 1) activeSpan = 2;
		else activeSpan = 1;
	}

	for (let i = 0; i < total; i++) {
		const span = document.createElement("span");
		if (i === activeSpan) {
			span.style.height = "1.2rem";
			span.style.opacity = "1";
		} else {
			span.style.height = "0.6rem";
			span.style.opacity = "0.4";
		}
		_dom.pinnedMessageCount.appendChild(span);
	}
}

// ─── Pinned message bar ───────────────────────────────────────────────────────
export function updatePinnedMessage(contactId = state.contactUserId) {
	// Prefer server-provided pinned list if available
	const allPinned = pinnedData[contactId] || [];

	if (allPinned.length > 0) {
		if (contactId !== state.contactUserId) return;
		const latest = allPinned[allPinned.length - 1];
		_dom.pinnedMessageContainer.style.display = 'flex';
		_dom.pinnedMessageText.textContent = latest.text || '';
		_dom.pinnedMessageText.dataset.messageId = String(latest.id);
		_dom.chatHeader.style.borderRadius = '1rem 1rem 0 0';
		_updatePinCountFromData(allPinned, latest.id, contactId);
		return;
	}

	// Fallback to local model when pinnedData isn't available
	const userMessages = messages[contactId];
	if (!Array.isArray(userMessages)) return;
	const pinnedMsg = [...userMessages].reverse().find((msg) => msg.isPinned);
	if (pinnedMsg) {
		if (contactId === state.contactUserId) {
			_dom.pinnedMessageContainer.style.display = 'flex';
			_dom.pinnedMessageText.textContent = pinnedMsg.text;
			_dom.pinnedMessageText.dataset.messageId = String(pinnedMsg.id);
			_dom.chatHeader.style.borderRadius = '1rem 1rem 0 0';
		}
	} else {
		if (contactId === state.contactUserId) {
			_dom.pinnedMessageContainer.style.display = 'none';
			_dom.pinnedMessageText.textContent = '';
			_dom.pinnedMessageText.dataset.messageId = '';
			_dom.chatHeader.style.borderRadius = '1rem';
		}
	}

	if (contactId === state.contactUserId)
		updatePinCount(pinnedMsg ? pinnedMsg.index : null);
}

export function _updatePinCountFromData(allPinned, activeId, contactId) {
	if (contactId !== state.contactUserId) return;
	_dom.pinnedMessageCount.textContent = '';
	const total = Math.min(allPinned.length, 3);
	if (total === 0) return;
	const pos = allPinned.findIndex((m) => m.id === activeId);
	let activeSpan;
	if (allPinned.length <= 3) {
		activeSpan = pos;
	} else {
		if (pos === 0) activeSpan = 0;
		else if (pos === allPinned.length - 1) activeSpan = 2;
		else activeSpan = 1;
	}

	for (let i = 0; i < total; i++) {
		const span = document.createElement('span');
		if (i === activeSpan) {
			span.style.height = '1.2rem';
			span.style.opacity = '1';
		} else {
			span.style.height = '0.6rem';
			span.style.opacity = '0.4';
		}
		_dom.pinnedMessageCount.appendChild(span);
	}
}

export async function scrollToPinnedMessage(messageId) {
	if (!messageId) return;
	if (!_dom || !_dom.chatEl) return;
	const mid = String(messageId);

	let el = _dom.chatEl.querySelector(
		`.chat-message[data-message-id="${mid}"]`,
	);
	if (el) {
		try {
			state.isProgrammaticScroll = true;
		} catch (e) {}
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		setTimeout(() => {
			try {
				state.isProgrammaticScroll = false;
			} catch (e) {}
		}, 800);
		return;
	}

	clearOpenSuppression(state.contactUserId);

	const MAX_PAGES = 10;
		for (let i = 0; i < MAX_PAGES; i++) {
			if (!canLoadOlder()) break;
			await loadOlderMessages({ skipSuppress: true });
		// loadOlderMessages در finally یه openSuppressedUntil جدید ست میکنه — clear کن
		clearOpenSuppression(state.contactUserId);
		await new Promise((r) => setTimeout(r, 150));
		el = _dom.chatEl.querySelector(
			`.chat-message[data-message-id="${mid}"]`,
		);
		if (el) {
			try {
				state.isProgrammaticScroll = true;
			} catch (e) {}
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			setTimeout(() => {
				try {
					state.isProgrammaticScroll = false;
				} catch (e) {}
			}, 800);
			return;
		}
	}

	try {
		showToast("Could not load this message");
	} catch (e) {}
}
