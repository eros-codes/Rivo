const SWIPE_THRESHOLD = 70; // px — minimum to snap open
const SWIPE_REVEAL_PX_RIGHT = 70;
const SWIPE_REVEAL_PX_LEFT = 140;

// Desktop mouse drag
let mouseWrapper = null;
let mouseStartX = 0;
let mouseDiff = 0;

export function initCardContextMenu(container, onCardAction) {
	// Use event delegation so dynamically added cards are covered too
	container.addEventListener("touchstart", _onTouchStart, { passive: true });
	container.addEventListener("touchmove", _onTouchMove, { passive: true });
	container.addEventListener("touchend", _onTouchEnd, { passive: true });
	container.addEventListener("click", _onClick);

	container.addEventListener("mousedown", (e) => {
		mouseWrapper = e.target.closest(".active-chat-wrapper");
		if (!mouseWrapper) return;
		mouseStartX = e.clientX;
		mouseDiff = 0;
		const _card = _getCard(mouseWrapper);
		if (_card) {
			_card.classList.remove('card-transition','translate-left','translate-right','translate-none');
		}
	});

	container.addEventListener("mousemove", (e) => {
		if (!mouseWrapper) return;
		mouseDiff = e.clientX - mouseStartX;
		const s = _getState(mouseWrapper);
		const base =
			s.swipeState === "left"
				? -SWIPE_REVEAL_PX_LEFT
				: s.swipeState === "right"
					? SWIPE_REVEAL_PX_RIGHT
					: 0;
		const clamped = Math.max(
			-SWIPE_REVEAL_PX_LEFT,
			Math.min(SWIPE_REVEAL_PX_RIGHT, base + mouseDiff),
		);
		_getCard(mouseWrapper).style.transform = `translateX(${clamped}px)`;
	});

	container.addEventListener("mouseup", (e) => {
		if (!mouseWrapper) return;

		if (Math.abs(mouseDiff) > 5) {
			e.stopPropagation();
			container.addEventListener('click', (ev) => ev.stopPropagation(), { once: true, capture: true});
		}

		const s = _getState(mouseWrapper);
		const base =
			s.swipeState === "left"
				? -SWIPE_REVEAL_PX_LEFT
				: s.swipeState === "right"
					? SWIPE_REVEAL_PX_RIGHT
					: 0;
		const total = base + mouseDiff;
		if (total < -SWIPE_THRESHOLD) {
			_closeAll(mouseWrapper);
			_snapTo(mouseWrapper, "left");
		} else if (total > SWIPE_THRESHOLD) {
			_closeAll(mouseWrapper);
			_snapTo(mouseWrapper, "right");
		} else {
			_snapTo(mouseWrapper, "closed");
		}
		mouseWrapper = null;
	});

	container.addEventListener("mouseleave", () => {
		if (mouseWrapper) {
			_snapTo(mouseWrapper, "closed");
			mouseWrapper = null;
		}
	});

	// Store per-wrapper state in a WeakMap so there are no memory leaks
	const stateMap = new WeakMap();

	function _getState(wrapper) {
		if (!stateMap.has(wrapper)) {
			stateMap.set(wrapper, {
				startX: 0,
				currentDiff: 0,
				dragging: false,
				swipeState: "closed",
			});
		}
		return stateMap.get(wrapper);
	}

	function _getCard(wrapper) {
		return wrapper.querySelector(".active-chat");
	}

	function _snapTo(wrapper, swipeState) {
		const card = _getCard(wrapper);
		if (!card) return;
		const s = _getState(wrapper);
		s.swipeState = swipeState;
		// use class-based snapping to avoid inline transition styles
		card.classList.add('card-transition');
		// clear any inline transform from dragging so classes take effect
		card.style.transform = '';
		card.classList.remove('translate-left','translate-right','translate-none');
		if (swipeState === "left") {
			card.classList.add('translate-left');
		} else if (swipeState === "right") {
			card.classList.add('translate-right');
		} else {
			card.classList.add('translate-none');
		}
	}

	function _closeAll(except = null) {
		container.querySelectorAll(".active-chat-wrapper").forEach((w) => {
			if (w === except) return;
			const s = _getState(w);
			if (s.swipeState !== "closed") _snapTo(w, "closed");
		});
	}

	function _onTouchStart(e) {
		const wrapper = e.target.closest(".active-chat-wrapper");
		if (!wrapper) return;
		if (e.target.closest(".card-action-btn")) return;
		const s = _getState(wrapper);
		s.startX = e.touches[0].clientX;
		s.currentDiff = 0;
		s.dragging = true;
		const _card = _getCard(wrapper);
		if (_card) _card.classList.remove('card-transition','translate-left','translate-right','translate-none');
	}

	function _onTouchMove(e) {
		const wrapper = e.target.closest(".active-chat-wrapper");
		if (!wrapper) return;
		const s = _getState(wrapper);
		if (!s.dragging) return;
		const diff = e.touches[0].clientX - s.startX;
		s.currentDiff = diff;

		const base =
			s.swipeState === "left"
				? -SWIPE_REVEAL_PX_LEFT
				: s.swipeState === "right"
					? SWIPE_REVEAL_PX_RIGHT
					: 0;

		const clamped = Math.max(
			-SWIPE_REVEAL_PX_LEFT,
			Math.min(SWIPE_REVEAL_PX_RIGHT, base + diff),
		);
		_getCard(wrapper).style.transform = `translateX(${clamped}px)`;
	}

	function _onTouchEnd(e) {
		const wrapper = e.target.closest(".active-chat-wrapper");
		if (!wrapper) return;
		const s = _getState(wrapper);
		if (!s.dragging) return;
		s.dragging = false;
		const base =
			s.swipeState === "left"
				? -SWIPE_REVEAL_PX_LEFT
				: s.swipeState === "right"
					? SWIPE_REVEAL_PX_RIGHT
					: 0;

		const total = base + s.currentDiff;

		if (total < -SWIPE_THRESHOLD) {
			_closeAll(wrapper);
			_snapTo(wrapper, "left");
		} else if (total > SWIPE_THRESHOLD) {
			_closeAll(wrapper);
			_snapTo(wrapper, "right");
		} else {
			_snapTo(wrapper, "closed");
		}

		s.currentDiff = 0;
	}

	function _onClick(e) {
		// Action button tapped
		const btn = e.target.closest(".card-action-btn");
		if (btn) {
			e.stopPropagation();
			const wrapper = btn.closest(".active-chat-wrapper");
			const userId = Number(wrapper?.dataset.wrapperUserId);
			_snapTo(wrapper, "closed");
			if (onCardAction) onCardAction(btn.dataset.action, userId);
			return;
		}
		// Tapped the card itself while open → close
		const wrapper = e.target.closest(".active-chat-wrapper");
		if (!wrapper) return;
		const s = _getState(wrapper);

		if (Math.abs(s.currentDiff) > 5) {
			e.stopPropagation();
			return;
		}

		if (s.swipeState !== "closed") {
			e.stopPropagation();
			_snapTo(wrapper, "closed");
		}
	}
}
