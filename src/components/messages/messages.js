import { parseSvg } from "../../utils/svg.js";

const seenIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.3"></circle><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10s10-4.47 10-10S17.53 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8s8 3.58 8 8s-3.58 8-8 8"></path></svg>`;
const sentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"></path></svg>`;
const pinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="currentColor" d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"></path></svg>`;

const oneTimeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="47 10" stroke-linecap="round" stroke-dashoffset="-5"/><text x="12" y="16.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="currentColor">1</text></svg>`;

// Capsule lock/clock icons (locked / unlocked)
const capsuleClockLockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7.5C8 5.57 9.57 4 11.5 4H12.5C14.43 4 16 5.57 16 7.5V10" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="15" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M12 15V13.8M12 15L13 15.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const capsuleClockUnlockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 6.2C15.5 4.64 14.36 3.5 12.8 3.5H12.2C10.64 3.5 9.5 4.64 9.5 6.2V8" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="15" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M12 15V13.8M12 15L13 15.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

const pendingSpinnerSvg = `<svg class="msg-pending-spinner" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="52 10" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></circle></svg>`;

const failedIconSvg = `<svg class="msg-failed-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="var(--danger-color)" stroke-width="2"/><line x1="12" y1="7" x2="12" y2="13" stroke="var(--danger-color)" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="var(--danger-color)"/></svg>`;

// URL matcher (anchored) — reuse across createMessage calls to avoid
// allocating a RegExp on every message render.
const LINK_REGEX = /^(?:https?:\/\/)?(?:www\.)[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?$|^https?:\/\/[^\s]+$/i;

// This file contains functions related to creating and manipulating message elements in the chat, as well as the context menu for messages.
export function escapeHtml(str) {
	if (!str) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function applyReactionsToMessage(msgEl, reactions, currentUserId) {
	// Remove existing badge wrap and class
	const existing = msgEl.querySelector(".reaction-badge-wrap");
	if (existing) existing.remove();
	msgEl.classList.remove("has-reaction");

	if (!reactions || reactions.length === 0) return;

	// Group by emoji and count
	const counts = {};
	reactions.forEach(({ emoji }) => {
		counts[emoji] = (counts[emoji] || 0) + 1;
	});

	// Check if current user reacted (per-emoji check below)

	const wrap = document.createElement("div");
	wrap.className = "reaction-badge-wrap";

	const uniqueEmojis = Object.keys(counts);
	const emojis = uniqueEmojis.slice(0, 2);
	const multiEmoji = uniqueEmojis.length > 1;
	emojis.forEach((emoji) => {
		const badge = document.createElement("div");
		badge.className = "reaction-badge";

		badge.dataset.emoji = emoji;
		badge.style.position = "relative";

		const span = document.createElement("span");
		span.className = "reaction-badge-emoji";
		span.textContent = emoji;
		badge.appendChild(span);

		// Determine if the current user reacted to this emoji
		const currentReacted = currentUserId
			? reactions.some(
					(r) => r.userId === currentUserId && r.emoji === emoji,
				)
			: false;
		const othersReacted = counts[emoji] - (currentReacted ? 1 : 0) > 0;

		if (multiEmoji) {
			// When there are multiple distinct emojis, badges stay circular.
			// Color each badge by who reacted: if current user reacted to
			// this emoji -> outgoing, otherwise incoming. Do NOT use accent
			// here to avoid two-tone badges.
			badge.classList.add("single");
			if (currentReacted) badge.classList.add("outgoing-reaction");
			else badge.classList.add("incoming-reaction");
		} else {
			// Single-emoji across the message
			if (counts[emoji] > 1 && currentReacted && othersReacted) {
				// Exception: both of us reacted to the same emoji -> color by
				// the message direction (incoming/outgoing)
				if (msgEl.classList.contains("outgoing"))
					badge.classList.add("outgoing-reaction");
				else badge.classList.add("incoming-reaction");
				// keep pill/number styling below
			} else {
				// Normal case: color by who reacted
				if (currentReacted) badge.classList.add("outgoing-reaction");
				else badge.classList.add("incoming-reaction");
				// circular when single reaction total
				if (counts[emoji] === 1 && reactions.length === 1)
					badge.classList.add("single");
			}
		}

		if (counts[emoji] > 1) {
			const count = document.createElement("span");
			count.className = "reaction-badge-count";
			count.textContent = counts[emoji];
			badge.appendChild(count);
		}

		wrap.appendChild(badge);
	});

	// Append and mark element so CSS can add spacing without relying on :has()
	msgEl.appendChild(wrap);
	msgEl.classList.add("has-reaction");
}

export function createMessage({
	id = null,
	user,
	text,
	time,
	index,
	_localId = null,
	isEdited = false,
	replyTo = null,
	forwardedFrom = null,
	isSeen = false,
	isPinned = false,
	pending = false,
	failed = false,
	isOneTime = false,
	isTimeCapsule = false,
	scheduledFor = null,
	openedAt = null,
	isLocked = false,
}) {
	const message = document.createElement("div");

	// Prepare reply attributes
	let _replyAttr = "";
	let _replySender = "";
	if (replyTo) {
		_replyAttr =
			replyTo.id ??
			(typeof replyTo.index !== "undefined" ? replyTo.index : "");
		_replySender = replyTo.sender ?? replyTo.name ?? "";
	}

	// "user ?" means that if the sender is user itself or not
	message.className = `chat-message ${user ? "outgoing" : "incoming"}`;
	if (pending) message.classList.add("pending");
	if (failed) message.classList.add("failed");
	if (typeof index !== "undefined") message.dataset.index = index; // Add index to message element for styling purposes
	message.dataset.messageId = id || "";
	if (_localId) message.dataset.localId = _localId;
	// Build DOM safely using textContent and DOM nodes
	if (replyTo) {
		const replyDiv = document.createElement("div");
		replyDiv.className = "chat-reply";
		if (_replyAttr) replyDiv.dataset.replyTo = String(_replyAttr);

		const senderSpan = document.createElement("span");
		senderSpan.className = "chat-reply-sender";
		senderSpan.textContent = _replySender || "";

		const replyText = document.createElement("span");
		replyText.className = "chat-reply-text";
		replyText.textContent = replyTo.text || "";

		replyDiv.appendChild(senderSpan);
		replyDiv.appendChild(replyText);
		message.appendChild(replyDiv);
	}

	if (forwardedFrom) {
		const fwd = document.createElement("div");
		fwd.className = "chat-forwarded-label";
		fwd.textContent = "Forwarded from " + forwardedFrom;
		message.appendChild(fwd);
	}

	const p = document.createElement("p");
	p.className = "chat-message-text";

	(text || "").split(/(\s+)/).forEach((word) => {
		if (LINK_REGEX.test(word)) {
			const a = document.createElement("a");
			const href = word.startsWith("http") ? word : `https://${word}`;
			a.href = href;
			a.textContent = word;
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			a.className = "message-link";
			p.appendChild(a);
		} else {
			p.appendChild(document.createTextNode(word));
		}
	});

	message.appendChild(p);

	// Mark visually as one-time (dashed border) and show subtle label in meta below
	if (isOneTime) {
		message.classList.add("onetime-message");
	}

	const meta = document.createElement("span");
	meta.className = "chat-message-meta";

	if (user && isPinned) {
		const pinSpan = document.createElement("span");
		pinSpan.className = "chat-pinned-icon";
		const _svg = parseSvg(pinIcon);
		if (_svg) pinSpan.appendChild(_svg.cloneNode(true));
		meta.appendChild(pinSpan);
	}

	if (user && isEdited) {
		const edited = document.createElement("span");
		edited.className = "chat-edited-label";
		edited.textContent = "edited";
		meta.appendChild(edited);
	}

	const timeEl = document.createElement("span");
	timeEl.className = "chat-message-time";
	timeEl.textContent = time || "";

	// If this is a one-time message, show the one-time icon in meta only.
	if (isOneTime) {
		const oneMeta = document.createElement("span");
		oneMeta.className = "chat-onetime-meta";
		const _s = parseSvg(oneTimeIcon);
		if (_s) oneMeta.appendChild(_s.cloneNode(true));
		meta.appendChild(oneMeta);
	}
	meta.appendChild(timeEl);

	if (!user && isEdited) {
		const edited = document.createElement("span");
		edited.className = "chat-edited-label";
		edited.textContent = "edited";
		meta.appendChild(edited);
	}

	// Pending or failed status override the normal sent/seen icons for outgoing messages
	if (user && pending) {
		const status = document.createElement("span");
		status.className = "chat-message-status";
		const _s = parseSvg(pendingSpinnerSvg);
		if (_s) status.appendChild(_s.cloneNode(true));
		meta.appendChild(status);
	} else if (user && failed) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "msg-failed-btn";
		const _s = parseSvg(failedIconSvg);
		if (_s) btn.appendChild(_s.cloneNode(true));
		meta.appendChild(btn);
	} else if (user && isSeen) {
		const status = document.createElement("span");
		status.className = "chat-message-status";
		const _s = parseSvg(seenIcon);
		if (_s) status.appendChild(_s.cloneNode(true));
		meta.appendChild(status);
	} else if (user && !isSeen) {
		const status = document.createElement("span");
		status.className = "chat-message-status";
		const _s = parseSvg(sentIcon);
		if (_s) status.appendChild(_s.cloneNode(true));
		meta.appendChild(status);
	}

	if (!user && isPinned) {
		const pinSpan = document.createElement("span");
		pinSpan.className = "chat-pinned-icon";
		const _svg2 = parseSvg(pinIcon);
		if (_svg2) pinSpan.appendChild(_svg2.cloneNode(true));
		meta.appendChild(pinSpan);
	}

	message.appendChild(meta);

	// ─── Time Capsule — Locked (recipient view) ───────────────────
	if (isTimeCapsule && isLocked && !user) {
		message.classList.add("capsule-locked");

		// Real text — blurred behind the overlay
		const existingText = message.querySelector(".chat-message-text");
		if (existingText) {
			existingText.style.cssText =
				"filter:blur(7px);opacity:.18;user-select:none;pointer-events:none;";
		}

		// Blurred placeholder lines (simulate content)
		const lines = document.createElement("div");
		lines.className = "capsule-lines";
		[82, 65, 90, 50].forEach((w) => {
			const l = document.createElement("div");
			l.className = "capsule-line";
			l.style.width = w + "%";
			lines.appendChild(l);
		});

		// Center overlay — lock + opens at
		const center = document.createElement("div");
		center.className = "capsule-center";

		const lockEl = document.createElement("div");
		lockEl.className = "capsule-lock-icon";
		// Insert SVG lock icon
		try {
			const _sv = parseSvg(capsuleClockLockIcon);
			if (_sv) lockEl.appendChild(_sv.cloneNode(true));
		} catch (e) {
			// fallback to emoji if parsing fails
			lockEl.textContent = "🔒";
		}

		const timeEl2 = document.createElement("div");
		timeEl2.className = "capsule-unlock-time";
		if (scheduledFor) {
			const d = new Date(scheduledFor);
			timeEl2.textContent = `Opens ${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
		}

		center.appendChild(lockEl);
		center.appendChild(timeEl2);

		message.insertBefore(lines, meta);
		message.insertBefore(center, meta);
	}

	// ─── Time Capsule — Sender view ───────────────────────────────
	if (isTimeCapsule && user) {
		const label = document.createElement("div");
		label.className = "capsule-sender-label";

		// icon
		const iconWrap = document.createElement("span");
		iconWrap.className = "capsule-sender-icon";
		try {
			const _sv = parseSvg(
				openedAt ? capsuleClockUnlockIcon : capsuleClockLockIcon,
			);
			if (_sv) iconWrap.appendChild(_sv.cloneNode(true));
		} catch (e) {
			iconWrap.textContent = openedAt ? "🔓" : "📦";
		}
		label.appendChild(iconWrap);

		// text
		const textWrap = document.createElement("span");
		textWrap.className = "capsule-sender-text";
		if (openedAt) {
			textWrap.textContent = "Opened";
		} else if (scheduledFor) {
			const d = new Date(scheduledFor);
			textWrap.textContent = `Unlocks ${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
		} else {
			textWrap.textContent = "Time Capsule";
		}
		label.appendChild(textWrap);

		// insert before the main text so label appears above message body
		const textNode = message.querySelector(".chat-message-text");
		if (textNode) message.insertBefore(label, textNode);
	}

	return message;
}

export function unlockCapsule(msgEl) {
	const lockIcon = msgEl.querySelector(".capsule-lock-icon");
	const center = msgEl.querySelector(".capsule-center");
	const lines = msgEl.querySelector(".capsule-lines");
	const realText = msgEl.querySelector(".chat-message-text");
	if (!lockIcon || !center) return;

	// 1 — stop the ongoing pulse animation then trigger zoom
	try {
		lockIcon.style.animation = "none"; // kill pulse
		// force reflow so the animation restarts cleanly
		void lockIcon.offsetWidth;
		lockIcon.style.animation = "";
	} catch (e) {
		/* ignore */
	}
	lockIcon.classList.add("capsule-zoom");

	// 2 — change to unlocked icon
	setTimeout(() => {
		try {
			// replace with unlocked SVG
			lockIcon.textContent = "";
			const _sv = parseSvg(capsuleClockUnlockIcon);
			if (_sv) lockIcon.appendChild(_sv.cloneNode(true));
		} catch (e) {
			lockIcon.textContent = "🔓";
		}
	}, 300);

	// 3 — fade overlay out
	setTimeout(() => {
		center.classList.add("capsule-fading");
		if (lines) lines.classList.add("capsule-fading");
	}, 500);

	// 4 — reveal text
	setTimeout(() => {
		if (center && center.parentNode) center.parentNode.removeChild(center);
		if (lines && lines.parentNode) lines.parentNode.removeChild(lines);
		msgEl.classList.remove("capsule-locked");
		if (realText) {
			realText.style.cssText = "";
			realText.classList.add("capsule-reveal");
		}
	}, 900);
}

export function markMessagesAsSeen(chatEl, indices) {
	if (!chatEl) return;

	if (Array.isArray(indices) && indices.length > 0) {
		indices.forEach((idx) => {
			const el = chatEl.querySelector(
				`.chat-message[data-index="${idx}"] .chat-message-status`,
			);
			if (el) {
				el.textContent = "";
				const _s = parseSvg(seenIcon);
				if (_s) el.appendChild(_s.cloneNode(true));
			}
		});
		return;
	}

	chatEl
		.querySelectorAll(".chat-message.outgoing .chat-message-status")
		.forEach((el) => {
			el.textContent = "";
			const _s = parseSvg(seenIcon);
			if (_s) el.appendChild(_s.cloneNode(true));
		});
}
