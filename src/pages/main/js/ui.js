// ─── Toast ────────────────────────────────────────────────────────────────────
let _t = {};

/**

- Call once in DOMContentLoaded before using showToast.
- @param {{ toaster, messageContainer, toastMessage, toastIcon, undoBtn }} dom
  */
export function initToast(dom) {
	_t = dom;
}

export function showToast(message, icon= "", showUndo = false) {
	_t.toaster.style.display = "flex";
	_t.toaster.style.bottom =
		_t.messageContainer.getBoundingClientRect().height + 14 + "px";
	_t.toaster.style.opacity = 1;
	_t.toastMessage.textContent = message;
	_t.toastIcon.innerHTML = icon;
	_t.undoBtn.style.display = showUndo ? "block" : "none";
	setTimeout(() => {
		_t.toaster.style.opacity = 0;
	}, 3000);
	setTimeout(() => {
		_t.toaster.style.display = "none";
	}, 3150);
}

// ─── Highlight ────────────────────────────────────────────────────────────────
export function highlightMessage(msg) {
	const cls = msg.classList.contains("incoming")
		? "highlight-incoming-reply"
		: "highlight-outgoing-reply";
	msg.classList.add(cls);
	setTimeout(() => msg.classList.remove(cls), 500);
}

// ─── Empty state ──────────────────────────────────────────────────────────────
export function createEmptyStateEl() {
	const el = document.createElement("div");
	el.className = "chat-empty";
	el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" aria-hidden="true" focusable="false"> <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.464 16.828C2 15.657 2 14.771 2 11s0-5.657 1.464-6.828C4.93 3 7.286 3 12 3s7.071 0 8.535 1.172S22 7.229 22 11s0 4.657-1.465 5.828C19.072 18 16.714 18 12 18c-2.51 0-3.8 1.738-6 3v-3.212c-1.094-.163-1.899-.45-2.536-.96"/> </svg> <p class="chat-empty-text">Say hello!</p>`;
	return el;
}

export function showEmptyState(chatEl, emptyStateEl) {
	if (!chatEl) return;
	chatEl.innerHTML = "";
	chatEl.appendChild(emptyStateEl);
	emptyStateEl.style.display = "flex";
}

export function hideEmptyState(chatEl, emptyStateEl) {
	if (!chatEl) return;
	if (emptyStateEl.parentElement === chatEl) emptyStateEl.remove();
}
