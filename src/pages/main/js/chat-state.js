// ─────────────────────────────────────────────────────────────────────────────
// chat-state.js
// حالت مشترکی که قبلاً در سطح ماژول chat.js بود.
// چون این مقادیر بین چند فایل مشترک‌اند، همه اینجا نگهداری می‌شوند.
//
// نکته‌ی مهم: متغیرهای `let` که از فایل‌های دیگر بازنویسی می‌شوند، فقط از طریق
// تابع setter عوض می‌شوند. خواندنشان مستقیم است (ES live binding همیشه مقدار
// به‌روز را می‌دهد).
// ─────────────────────────────────────────────────────────────────────────────

import { getCurrentUser } from "./currentUser.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────
// تنها نویسنده initChat است (در همین فایل)، بقیه فقط می‌خوانند.
export let _dom = {};

// ─── Local notification dedupe fallback ──────────────────────────────────────
export const _localNotifQueue = new Set();

// ─── Revealed time-capsules ──────────────────────────────────────────────────
const _REVEALED_CAPSULES_KEY = "rivo.revealedCapsules";
export let _revealedCapsuleIds = new Set();
try {
	const raw = localStorage.getItem(_REVEALED_CAPSULES_KEY) || "[]";
	const arr = JSON.parse(raw || "[]");
	if (Array.isArray(arr)) arr.forEach((id) => _revealedCapsuleIds.add(String(id)));
} catch (e) {
	_revealedCapsuleIds = new Set();
}

export function _markCapsuleRevealed(id) {
	try {
		if (!id) return;
		const sid = String(id);
		if (_revealedCapsuleIds.has(sid)) return;
		_revealedCapsuleIds.add(sid);
		try {
			localStorage.setItem(_REVEALED_CAPSULES_KEY, JSON.stringify(Array.from(_revealedCapsuleIds)));
		} catch (e) {}
	} catch (e) {}
}

// ─── Constants ───────────────────────────────────────────────────────────────
export const basePadding = 4;
export const lineHeight = 22.4;
export const maxLines = 7;
export const maxHeight = lineHeight * maxLines;

// Read client pagination config from environment or global injected config.
function _getClientEnvNumber(name, fallback) {
	try {
		if (typeof process !== "undefined" && process.env && process.env[name]) {
			const v = Number(process.env[name]);
			if (!Number.isNaN(v)) return v;
		}
	} catch (e) {}

	try {
		if (typeof window !== "undefined") {
			// Attempt multiple injected config sources
			if (window.__RIVO_CLIENT_CONFIG && window.__RIVO_CLIENT_CONFIG[name] != null) {
				const v = Number(window.__RIVO_CLIENT_CONFIG[name]);
				if (!Number.isNaN(v)) return v;
			}
			if (window.__env && window.__env[name] != null) {
				const v = Number(window.__env[name]);
				if (!Number.isNaN(v)) return v;
			}
			if (window.RIVO_CONFIG && window.RIVO_CONFIG[name] != null) {
				const v = Number(window.RIVO_CONFIG[name]);
				if (!Number.isNaN(v)) return v;
			}
		}
	} catch (e) {}

	return fallback;
}

export const DEFAULT_PAGE_LIMIT = _getClientEnvNumber("DEFAULT_PAGE_LIMIT", 50);
// Client-side hard limit to avoid requesting huge pages
export const MAX_CLIENT_PAGE_LIMIT = _getClientEnvNumber("MAX_CLIENT_PAGE_LIMIT", 100);

// After server reports messages marked as seen, keep the unread separator
// visible for at least this many milliseconds before applying the seen state
export const _MIN_SEPARATOR_VISIBLE_AFTER_MARK_MS = 600;

// Cap messages kept per conversation to avoid unbounded client memory growth
export const MAX_MESSAGES_PER_CONVERSATION = 1000;

// ─── Shared mutable containers ───────────────────────────────────────────────
// اینها const هستند ولی محتوایشان تغییر می‌کند؛ چون با ارجاع به اشتراک
// گذاشته می‌شوند، هر فایلی که import کند همان شیء را می‌بیند.

// Pending capsule reveals received while chat or message element not present
export const _pendingCapsuleReveals = new Map(); // String(messageId) -> { text, openedAt, conversationId }

// paging state per contact
export const messagePaging = {};

// pinned messages cache fetched separately from pagination
export const pinnedData = {}; // contactId -> [{ id, text, senderId, createdAt }]

// Map of pending messages keyed by pendingId -> { node, timeoutId, contactId, text, replyTo }
export const pendingMessages = new Map();

// ─── Unread separator state ──────────────────────────────────────────────────
// فقط openChat و closeChat اینها را عوض می‌کنند.
export let _unreadSeparatorContactId = null;
export let _unreadSeparatorIndex = -1;

export function setUnreadSeparatorContactId(v) {
	_unreadSeparatorContactId = v;
}
export function setUnreadSeparatorIndex(v) {
	_unreadSeparatorIndex = v;
}

// ─── Seen timers ─────────────────────────────────────────────────────────────
export let _seenTimeoutId = null;
export let _seenApplyTimeoutId = null;

export function setSeenTimeoutId(v) {
	_seenTimeoutId = v;
}
export function setSeenApplyTimeoutId(v) {
	_seenApplyTimeoutId = v;
}

// ─── Inject-scroll suppression ───────────────────────────────────────────────
export let _suppressInjectScroll = false;

export function setSuppressInjectScroll(v) {
	_suppressInjectScroll = v;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function _currentUserId() {
	const u = getCurrentUser();
	return u && u.id;
}

// Returns a safe preview string for contact cards. For locked time-capsule
// messages destined for the recipient, return an empty string so nothing
// is leaked in contact lists or previews.
export function getContactPreviewText(msg) {
	try {
		if (!msg) return "";
		const isSenderLocal = !!msg.user;
		// If message is a time-capsule and still locked for the recipient,
		// don't reveal anything in previews. If it has been opened and the
		// server provided plaintext, show that; otherwise show a neutral
		// placeholder.
		if (msg.isTimeCapsule) {
			if (msg.isLocked && !isSenderLocal) return "";
			if (msg.openedAt && !isSenderLocal) {
				if (msg.text) return msg.text;
				return "Time capsule unlocked";
			}
		}
		return msg.text || "";
	} catch (e) {
		return "";
	}
}

// ─── Init ────────────────────────────────────────────────────────────────────
export function initChat(dom) {
	_dom = dom;

	// Delegated click handler for failed message buttons
	try {
		if (_dom.chatEl) {
			_dom.chatEl.addEventListener("click", (e) => {
				const btn = e.target.closest && e.target.closest(".msg-failed-btn");
				if (!btn) return;
				e.stopPropagation();
				const msgEl = btn.closest(".chat-message");
				if (!msgEl) return;
				const pendingId = msgEl.dataset.pendingId;
				// import پویا برای پرهیز از وابستگی حلقوی با chat-send.js
				import("./chat-send.js")
					.then((m) => m._toggleFailedPanel(msgEl, pendingId))
					.catch(() => {});
			});
		}
	} catch (e) {
		/* ignore */
	}
}
