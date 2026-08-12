import { _dom } from "./chat-state.js";
import { messages, state } from "./state.js";

export function nearBottom(chatEl, offset = 70) {
	if (!chatEl) return false;
	return (
		chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - offset
	);
}

// Returns true when the chat view is near the start (oldest messages)
// within `offset` pixels. This handles reversed layouts by comparing
// the first message element's proximity to the container edges.
export function nearTop(chatEl, offset = 60) {
	if (!chatEl) return false;
	try {
		const firstEl = chatEl.querySelector('.chat-message');
		if (!firstEl) return false;
		const firstRect = firstEl.getBoundingClientRect();
		const chatRect = chatEl.getBoundingClientRect();
		const distTop = Math.abs(firstRect.top - chatRect.top);
		const distBottom = Math.abs(chatRect.bottom - firstRect.bottom);
		// Determine which edge the first element is anchored to and
		// compare distance to that edge.
		if (distTop <= distBottom) {
			return (firstRect.top - chatRect.top) <= offset;
		}
		return (chatRect.bottom - firstRect.bottom) <= offset;
	} catch (e) {
		return false;
	}
}

export function _chatPaddingBottom() {
	try {
		if (!_dom || !_dom.chatEl) return 0;
		// Prefer the actual input element height if available so the last
		// message aligns above the input area (covers overlay/input cases).
		const inputEl = _dom.messageInput;
		if (inputEl) {
			try {
				const r = inputEl.getBoundingClientRect();
				if (r && r.height) return r.height;
			} catch (e) {
				// fall back to computed style
			}
		}
		const el = _dom.chatEl;
		const style = getComputedStyle(el);
		return parseFloat(style.paddingBottom) || 0;
	} catch (e) {
		return 0;
	}
}

export function scrollChatToBottom() {
	if (!_dom.chatEl) return;
	try {
		state.isProgrammaticScroll = true;
	} catch (e) {}
	requestAnimationFrame(() => {
		if (_dom.chatEl) _dom.chatEl.scrollTop = _dom.chatEl.scrollHeight;
		requestAnimationFrame(() => {
			try {
				state.isProgrammaticScroll = false;
			} catch (e) {}
		});
	});
}

export function scrollChatToBottomAfterPadding(timeout = 400) {
	if (!_dom.chatEl) return;
	const el = _dom.chatEl;
	let called = false;

	try {
		state.isProgrammaticScroll = true;
	} catch (e) {}

	function doScroll() {
		if (called) return;
		called = true;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
			requestAnimationFrame(() => {
				// یه بار دیگه بعد از RAF برای layout shifts ناشی از fonts/images
				try {
					state.isProgrammaticScroll = false;
				} catch (e) {}
			});
		});
	}

	let timeoutId = null;
	function cleanup() {
		el.removeEventListener("transitionend", onT);
		if (timeoutId !== null) clearTimeout(timeoutId);
	}
	function onT(e) {
		if (!e.propertyName || !e.propertyName.includes("padding")) return;
		cleanup();
		doScroll();
	}
	el.addEventListener("transitionend", onT);
	timeoutId = setTimeout(() => {
		cleanup();
		doScroll();
	}, timeout);
}
