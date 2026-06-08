// Lightweight in-app notification module
import { mountAvatar } from "../../../utils/dom.js";
const QUEUE = [];
const MAX_QUEUE = 5;
let _container = null;
let _notif = null;
let _avatar = null;
let _title = null;
let _text = null;
let _timer = null;
let _visible = false;
// flag set when hideNotification(true) is used so transitionend shouldn't trigger next
let _hideWasImmediate = false;

export function initInAppNotification() {
  if (_container) return;
  _container = document.createElement('div');
  _container.id = 'in-app-notif-wrap';
  _container.className = 'in-app-notif-wrap';

  // build DOM structure with createElement to avoid injecting HTML strings
  const notif = document.createElement('div');
  notif.id = 'in-app-notif';
  notif.className = 'in-app-notif';
  notif.setAttribute('aria-hidden', 'true');
  notif.setAttribute('role', 'button');
  notif.tabIndex = 0;

  const card = document.createElement('div');
  card.className = 'notif-card';

  const avatar = document.createElement('div');
  avatar.className = 'notif-avatar';

  const body = document.createElement('div');
  body.className = 'notif-body';

  const title = document.createElement('div');
  title.className = 'notif-title';

  const text = document.createElement('div');
  text.className = 'notif-text';

  body.appendChild(title);
  body.appendChild(text);
  card.appendChild(avatar);
  card.appendChild(body);
  notif.appendChild(card);
  _container.appendChild(notif);

  document.body.appendChild(_container);

  _notif = notif;
  _avatar = avatar;
  _title = title;
  _text = text;

  // Click opens chat (handled by main via custom event)
  _notif.addEventListener('click', () => {
    const cid = Number(_notif.dataset.contactId || 0);
    const mid = _notif.dataset.messageId ? Number(_notif.dataset.messageId) : null;
    if (!cid) return;
    document.dispatchEvent(new CustomEvent('in-app-notif:open', { detail: { contactId: cid, messageId: mid } }));
    hideNotification(true);
  });

  // Pointer-based swipe-up to dismiss
  let pointerId = null;
  let startY = 0;
  let dragging = false;
  let lastDelta = 0;

  _notif.addEventListener('pointerdown', (ev) => {
    pointerId = ev.pointerId;
    startY = ev.clientY;
    dragging = true;
    lastDelta = 0;
    try {
      _notif.setPointerCapture(pointerId);
    } catch (_e) {
      // ignore
    }
    _notif.style.transition = 'none';
  });

  _notif.addEventListener('pointermove', (ev) => {
    if (!dragging || ev.pointerId !== pointerId) return;
    const delta = ev.clientY - startY;
    // only allow upward movement
    if (delta < 0) {
      _notif.style.transform = `translateY(${delta}px)`;
      lastDelta = delta;
    }
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    try {
      if (pointerId) _notif.releasePointerCapture(pointerId);
    } catch (e) {
      void e;
    }
    _notif.style.transition = '';
    if (lastDelta < -40) {
      hideNotification(true);
    } else {
      // animate back
      _notif.style.transform = '';
    }
    lastDelta = 0;
    pointerId = null;
  }

  _notif.addEventListener('pointerup', endDrag);
  _notif.addEventListener('pointercancel', endDrag);

  // When hidden animation completes, show next queued notification
  _notif.addEventListener('transitionend', (ev) => {
    if (ev.propertyName && ev.propertyName.includes('transform') && !_visible) {
      _notif.setAttribute('aria-hidden', 'true');
      // If the hide was immediate, we call _showNext directly from hideNotification
      // and must not trigger it here (would interrupt the next animation).
      if (!_hideWasImmediate && QUEUE.length > 0) {
        _showNext();
      }
    }
  });
}

function _showNext() {
  const item = QUEUE.shift();
  if (!item) return;
  const { contact, message } = item;
  _render(contact, message);
  _notif.setAttribute('aria-hidden', 'false');
  _notif.classList.add('show');
  _visible = true;
  _startTimer();
}

function _render(contact, message) {
  mountAvatar(_avatar, {
    name: contact.name,
    nickname: contact.nickname,
    profilePics: contact.profilePics,
    className: 'notif-avatar',
  });
  _title.textContent = contact.nickname || contact.name || '';
  _text.textContent = message.text || '';
  _notif.dataset.contactId = String(contact.id || contact.contactId || '');
  // allow passing message id so click can navigate to a specific message
  _notif.dataset.messageId = String(message.messageId || message.id || '');
}

function _startTimer() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => hideNotification(false), 3000);
}

export function showNotification(contact, message) {
  if (!contact || !message) return;
  if (!_notif) {
    // lazy init if main didn't call init
    try {
      initInAppNotification();
    } catch (e) {}
  }

  // If currently visible for same contact, update content and reset timer
  if (_visible && Number(_notif.dataset.contactId) === Number(contact.id)) {
    _render(contact, message);
    _startTimer();
    return;
  }

  // Avoid queue growth and duplicates for the same contact+message
  if (MAX_QUEUE && QUEUE.length >= MAX_QUEUE) QUEUE.shift();
  const incomingId = String(message.messageId || message.id || '');
  const contactIdStr = String(contact.id || contact.contactId || '');
  const dup = QUEUE.some((q) => String(q.message?.messageId || q.message?.id || '') === incomingId && String(q.contact?.id || q.contact?.contactId || '') === contactIdStr);
  if (!dup) QUEUE.push({ contact, message });
  if (!_visible) _showNext();
}

export function hideNotification(immediate = false) {
  if (!_notif) return;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _visible = false;
  _notif.classList.remove('show');
  // if immediate, force transform so transition occurs
  if (immediate) {
    _hideWasImmediate = true;
    // remove transition and move instantly off-screen, then restore transition
    _notif.style.transition = 'none';
    _notif.style.transform = 'translateY(-140%)';
    // force reflow so the instant transform is applied
    void _notif.offsetHeight;
    // restore transition so future shows animate normally
    _notif.style.transition = '';
    _notif.style.transform = '';
    // call next show directly (do not rely on transitionend)
    setTimeout(() => {
      _hideWasImmediate = false;
      _showNext();
    }, 0);
  }
}
