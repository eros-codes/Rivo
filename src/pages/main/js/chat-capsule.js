import { unlockCapsule } from "../../../components/messages/messages.js";
import { refreshCard, sortActiveChats } from "./chat-logic.js";
import { _currentUserId, _dom, _markCapsuleRevealed, _pendingCapsuleReveals } from "./chat-state.js";
import { showNotification } from "./in-app-notification.js";
import { contacts, messages } from "./state.js";

function _findModelMessage(messageId) {
	for (const [uid, msgs] of Object.entries(messages)) {
		if (!Array.isArray(msgs)) continue;
		const msg = msgs.find((m) => String(m.id) === String(messageId));
		if (msg) return { contactId: Number(uid), msg };
	}
	return null;
}

// The chat card shows the capsule's text only when it is the latest message
function _updatePreview(contact, messageId, text) {
	if (!contact || String(contact.lastMessageId) !== String(messageId)) return;
	contact.lastMessage = text || "Time capsule unlocked";
	refreshCard(contact);
	sortActiveChats();
}

export function handleCapsuleOpened({ messageId, text, openedAt, conversationId, senderId }) {
	if (!messageId) return;

	// Update in-memory messages
	const found = _findModelMessage(messageId);
	if (found) {
		found.msg.text = text;
		found.msg.openedAt = openedAt;
		found.msg.isLocked = false;
		found.msg.isTimeCapsule = true;
	}

	const contact =
		contacts.find((c) => c.conversationId === conversationId) ||
		(found ? contacts.find((c) => c.id === found.contactId) : null);
	const fromMe =
		senderId != null ? Number(senderId) === Number(_currentUserId()) : !!(found && found.msg.user);
	const msgEl = _dom?.chatEl?.querySelector(`.chat-message[data-message-id="${messageId}"]`) || null;

	// The sender's own capsule: it only changes its label to "Opened"
	if (fromMe) {
		if (msgEl) {
			const label = msgEl.querySelector(".capsule-sender-text");
			if (label) label.textContent = "Opened";
		}
		return;
	}

	// Not on screen: the reveal animation runs when the chat is opened
	if (!msgEl) {
		try { _pendingCapsuleReveals.set(String(messageId), { text, openedAt, conversationId }); } catch (e) { /* ignore */ }
		_updatePreview(contact, messageId, text);
		try {
			if (contact && !contact.isMuted && document.visibilityState !== "hidden") {
				showNotification(contact, { text: "A time capsule was unlocked", id: messageId });
			}
		} catch (e) { /* ignore */ }
		return;
	}

	try {
		// Place the real text into the element (keep hidden until revealed)
		const textEl = msgEl.querySelector('.chat-message-text');
		if (textEl) textEl.textContent = text || '';

		// Schedule unlock animation to run only when the message element becomes visible
		const runReveal = () => {
			try {
				msgEl.classList.add('capsule-unlocking');

				// Update sender label if present (use a simple text label here)
				const label = msgEl.querySelector('.capsule-sender-label');
				if (label) label.textContent = 'Time Capsule — Opened';

				try {
					unlockCapsule(msgEl);
				} catch (err) {
					// fallback: quickly reveal if helper missing
					const center = msgEl.querySelector('.capsule-center');
					const lines = msgEl.querySelector('.capsule-lines');
					if (center && center.parentNode) center.parentNode.removeChild(center);
					if (lines && lines.parentNode) lines.parentNode.removeChild(lines);
					msgEl.classList.remove('capsule-locked', 'capsule-unlocking');
					msgEl.classList.add('capsule-opened');
					if (textEl) textEl.classList.add('capsule-reveal');
				}

				// Ensure classes reflect final state after animation
				setTimeout(() => {
					msgEl.classList.remove('capsule-unlocking');
					msgEl.classList.add('capsule-opened');
					_updatePreview(contact, messageId, text);
					// Persist that we've shown the reveal animation for this message
					try { _markCapsuleRevealed(String(messageId)); } catch (e) { /* ignore */ }
				}, 950);
			} catch (e) {
				console.error('reveal failed', e);
			}
		};

		// helper: check visibility
		const isVisible = (el) => {
			try {
				const rect = el.getBoundingClientRect();
				return rect.top >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight);
			} catch (e) { return false; }
		};

		if (isVisible(msgEl)) {
			setTimeout(runReveal, 1000);
		} else {
			const obs = new IntersectionObserver((entries) => {
				for (const ent of entries) {
					if (ent.isIntersecting) {
						setTimeout(() => {
							try { runReveal(); } catch (e) { /* ignore */ }
						}, 1000);
						try { obs.disconnect(); } catch (e) { /* ignore */ }
						break;
					}
				}
			}, { threshold: 0.2 });
			try { obs.observe(msgEl); } catch (e) { setTimeout(runReveal, 1000); }
		}
	} catch (e) {
		console.error('handleCapsuleOpened DOM update failed', e);
	}
}
