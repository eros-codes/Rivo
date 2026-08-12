import { unlockCapsule } from "../../../components/messages/messages.js";
import { refreshCard, sortActiveChats } from "./chat-logic.js";
import { _dom, _markCapsuleRevealed, _pendingCapsuleReveals } from "./chat-state.js";
import { showNotification } from "./in-app-notification.js";
import { contacts, messages, state } from "./state.js";

export function handleCapsuleOpened({ messageId, text, openedAt, conversationId }) {
	if (!messageId) return;

	// Update in-memory messages
	try {
						for (const [_uid, msgs] of Object.entries(messages)) {
			if (!Array.isArray(msgs)) continue;
			const idx = msgs.findIndex((m) => String(m.id) === String(messageId));
			if (idx !== -1) {
				msgs[idx].text = text;
				msgs[idx].openedAt = openedAt;
				msgs[idx].isLocked = false;
				msgs[idx].isTimeCapsule = true;
				break;
			}
		}
	} catch (e) {
		console.error('handleCapsuleOpened update model failed', e);
	}

	// Update DOM if present; otherwise queue the reveal for later injection
	if (!_dom || !_dom.chatEl) {
		try { _pendingCapsuleReveals.set(String(messageId), { text, openedAt, conversationId }); } catch (e) { /* ignore */ }
		return;
	}
	const msgEl = _dom.chatEl.querySelector(`.chat-message[data-message-id="${messageId}"]`);
	if (!msgEl) {
		try { _pendingCapsuleReveals.set(String(messageId), { text, openedAt, conversationId }); } catch (e) { /* ignore */ }
		return;
	}

	try {
		// Place the real text into the element (keep hidden until revealed)
		const textEl = msgEl.querySelector('.chat-message-text');
		if (textEl) textEl.textContent = text || '';

		// Update in-memory contact preview to a placeholder so lists don't show plaintext yet
		try {
			const contact = contacts.find(c => c.conversationId === conversationId);
			if (contact) {
				contact.lastMessage = 'Time capsule unlocked';
				refreshCard(contact);
				sortActiveChats();
			}
		} catch (e) { /* ignore */ }

		// Show an in-app notification and a native notification (if permitted)
		try {
			const contact = contacts.find(c => c.conversationId === conversationId);
			if (contact) {
				const notifMsg = { text: 'A time capsule was unlocked', id: messageId };
				try { showNotification(contact, notifMsg); } catch (e) { /* ignore */ }
				if (window.Notification && Notification.permission === 'granted') {
					try {
						const n = new Notification('Time capsule unlocked', {
							body: 'A time capsule in your chat has been unlocked. Click to view.',
							data: { conversationId, messageId },
						});
						n.onclick = function () {
							try {
								window.focus();
								document.dispatchEvent(new CustomEvent('in-app-notif:open', { detail: { contactId: contact.id, messageId } }));
								n.close();
							} catch (e) { /* ignore */ }
						};
					} catch (e) { /* ignore */ }
				}
			}
		} catch (e) { /* ignore */ }

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

					// mark in-memory message as unlocked and update contact preview to real text
					try {
						for (const [_uid, msgs] of Object.entries(messages)) {
							if (!Array.isArray(msgs)) continue;
							const idx = msgs.findIndex((m) => String(m.id) === String(messageId));
							if (idx !== -1) {
								msgs[idx].isLocked = false;
								msgs[idx].openedAt = openedAt;
								break;
							}
						}
						const contact = contacts.find(c => c.conversationId === conversationId);
						if (contact) {
							contact.lastMessage = text || '';
							refreshCard(contact);
							sortActiveChats();
						}
					} catch (e) { /* ignore */ }

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

// Dev helper: manually trigger capsule-open flow from the browser console.
// Usage: window.__rivo_test_unlockCapsule(messageId, "optional revealed text")
try {
	if (typeof window !== 'undefined') {
		window.__rivo_test_unlockCapsule = (messageId, text = 'Test unlock') => {
			try {
				handleCapsuleOpened({ messageId, text, openedAt: new Date().toISOString() });
			} catch (e) { console.error('test unlock failed', e); }
		};
	}
} catch (e) { /* ignore */ }
