// Lightweight in-app notification module
import { safeSrc, mountAvatar } from "../../../utils/dom.js";
const QUEUE = [];
let _container = null;
let _notif = null;
let _avatar = null;
let _title = null;
let _text = null;
let _timer = null;
let _visible = false;

export function initInAppNotification() {
  if (_container) return;
  _container = document.createElement('div');
  _container.id = 'in-app-notif-wrap';
  _container.className = 'in-app-notif-wrap';

  _container.innerHTML = `
    <div id="in-app-notif" class="in-app-notif" aria-hidden="true" role="button" tabindex="0">
      <div class="notif-card">
        <div class="notif-avatar"></div>
        <div class="notif-body">
          <div class="notif-title"></div>
          <div class="notif-text"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(_container);

  _notif = _container.querySelector('#in-app-notif');
  _avatar = _container.querySelector('.notif-avatar');
  _title = _container.querySelector('.notif-title');
  _text = _container.querySelector('.notif-text');

  // Click opens chat (handled by main via custom event)
  _notif.addEventListener('click', (e) => {
    const cid = Number(_notif.dataset.contactId || 0);
    if (!cid) return;
    document.dispatchEvent(new CustomEvent('in-app-notif:open', { detail: { contactId: cid } }));
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
    } catch (e) {
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
      if (QUEUE.length > 0) {
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

  QUEUE.push({ contact, message });
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
    _notif.style.transform = 'translateY(-140%)';
    // schedule a small timeout to clear style and allow transitionend
    setTimeout(() => {
      _notif.style.transform = '';
    }, 20);
  }
}
