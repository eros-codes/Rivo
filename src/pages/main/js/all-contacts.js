import { createContactCard } from "../../../components/contact-cards/contact-card.js";

// تعداد مخاطبی که در صفحه‌ی اصلی نشان داده می‌شود؛ بقیه پشت «Show more» می‌مانند
export const CONTACTS_PREVIEW_COUNT = 8;

// همان breakpoint ای که CSS برای چیدمان موبایل استفاده می‌کند
const MOBILE_QUERY = "(max-width: 700px)";
const MAIN_OPEN_CLASS = "all-contacts-open";
// فاصله‌ی بالای صفحه تا زیر هدر وقتی در دسکتاپ چت باز است
const DESKTOP_TOP_GAP = 8;

let _list = []; // همه‌ی مخاطبین بخش Contacts، به همان ترتیب صفحه‌ی اصلی
let _onContactAction = null;
let _onOpenChat = null;
let _el = {};

let _open = false; // کاربر در صفحه‌ی All contacts است
let _suspended = false; // دسکتاپ: موقتاً پنهان، چون از اینجا چتی باز شده
let _savedScroll = null; // اسکرول لیست، برای برگشتن دقیق به همان‌جا
let _animToken = 0;
let _animCleanup = null;
let _wasMobile = null; // برای تشخیص عبور از breakpoint هنگام resize

// کارت‌ها نگه داشته می‌شوند تا رندر دوباره، اسکرول و حالت‌ها را به هم نریزد
const _cards = new Map(); // id -> { sig, el }

const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;
const reduceMotion = () =>
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isChatOpen = () => _el.chatPart?.style.display === "flex";

function _signature(c) {
	return JSON.stringify([
		c.nickname || "",
		c.name || "",
		c.lastMessage || "",
		(c.profilePics && c.profilePics[0]) || "",
		!!c.isOnline,
		!!c.isBlocked,
		!!c.isMuted,
		!!c.isPinned,
		!!c.isDeleted,
	]);
}

function _query() {
	return (_el.search?.value || "").trim().toLocaleLowerCase();
}

function _matches(c, q) {
	const name = (c.nickname || c.name || "").toLocaleLowerCase();
	const username = (c.username || "").toLocaleLowerCase();
	return name.includes(q) || username.includes(q);
}

function render() {
	const { list, empty } = _el;
	if (!list) return;

	const q = _query();
	const matched = q ? _list.filter((c) => _matches(c, q)) : _list;

	// دقیقاً همان کامپوننت صفحه‌ی اصلی، تا کارت‌ها یکسان باشند
	const wanted = matched.map((c) => {
		const sig = _signature(c);
		let entry = _cards.get(c.id);
		if (!entry || entry.sig !== sig) {
			entry = {
				sig,
				el: createContactCard(
					{ ...c, hasMessages: !!c.lastMessage },
					_onContactAction,
				),
			};
			_cards.set(c.id, entry);
		}
		return entry.el;
	});

	const keep = new Set(wanted);
	Array.from(list.children).forEach((el) => {
		if (!keep.has(el)) el.remove();
	});
	wanted.forEach((el, i) => {
		if (list.children[i] !== el)
			list.insertBefore(el, list.children[i] || null);
	});

	const ids = new Set(_list.map((c) => c.id));
	for (const id of _cards.keys()) if (!ids.has(id)) _cards.delete(id);

	if (empty) empty.hidden = matched.length > 0;
}

// While the page is not on screen its cards are taken out of the DOM, so
// code that looks a contact up with document.querySelector never finds a
// stale copy here. (The cache keeps them for a fast re-open.)
function _detachCards() {
	if (_el.list) _el.list.textContent = "";
}

function _setVisible(on) {
	_el.section?.classList.toggle("is-open", on);
	_el.mainContent?.classList.toggle(MAIN_OPEN_CLASS, on);
}

function _scrollListTo(top) {
	_el.list?.scrollTo({ top, behavior: "instant" });
}

// در دسکتاپ لیست داخل خودش اسکرول می‌خورد؛ ارتفاع تا پایین صفحه پر می‌شود
function _fitDesktop({ align = false } = {}) {
	const { section, peoplePart, header, mainContent } = _el;
	if (!section) return;
	if (!_open || _suspended || isMobile() || !peoplePart) {
		section.style.height = "";
		return;
	}
	// e.g. hidden behind the header search results: measure later
	if (!section.getClientRects().length) return;
	const ppTop = peoplePart.getBoundingClientRect().top;
	const headerBottom = header
		? header.getBoundingClientRect().bottom - ppTop
		: 0;
	const stacked = getComputedStyle(mainContent).flexDirection.startsWith(
		"column",
	);

	if (stacked) {
		// چت باز است: این بخش زیر Active Chats می‌آید و درست زیر هدر می‌نشیند
		const top = headerBottom + DESKTOP_TOP_GAP;
		section.style.height =
			Math.max(260, peoplePart.clientHeight - top) + "px";
		if (align) {
			const secTop = section.getBoundingClientRect().top - ppTop;
			peoplePart.scrollBy({ top: secTop - top, behavior: "instant" });
		}
		return;
	}

	// دو ستونی: ستون راست، از زیر هدر تا پایین صفحه
	if (align && section.getBoundingClientRect().top - ppTop < headerBottom) {
		peoplePart.scrollTo({ top: 0, behavior: "instant" });
	}
	const offset =
		section.getBoundingClientRect().top - ppTop + peoplePart.scrollTop;
	section.style.height =
		Math.max(260, peoplePart.clientHeight - offset) + "px";
}

function _animate(cls, done) {
	const { section } = _el;
	const token = ++_animToken;
	if (_animCleanup) _animCleanup();
	if (!section || reduceMotion()) {
		done?.();
		return;
	}
	section.classList.remove("slide-in", "slide-out");
	void section.offsetWidth; // restart the animation
	section.classList.add(cls);

	let timer = null;
	const onEnd = (e) => {
		if (e.target === section) finish();
	};
	const cleanup = () => {
		clearTimeout(timer);
		section.removeEventListener("animationend", onEnd);
		section.classList.remove(cls);
		if (_animCleanup === cleanup) _animCleanup = null;
	};
	function finish() {
		cleanup();
		if (token === _animToken) done?.();
	}
	_animCleanup = cleanup;
	section.addEventListener("animationend", onEnd);
	timer = setTimeout(finish, 450);
}

export function openAllContacts() {
	if (!_el.section) return;
	if (_open && !_suspended) return;
	_open = true;
	_suspended = false;
	_savedScroll = null;
	if (_el.search) _el.search.value = "";

	_setVisible(true);
	render();
	_scrollListTo(0);

	if (isMobile()) {
		_animate("slide-in");
	} else {
		if (_animCleanup) _animCleanup();
		_fitDesktop({ align: true });
		// فقط در دسکتاپ؛ در گوشی کیبورد نصف صفحه را می‌گیرد
		if (window.matchMedia("(hover: hover)").matches)
			_el.search?.focus({ preventScroll: true });
	}
}

export function closeAllContacts() {
	if (!_open) return;
	_open = false;
	_suspended = false;
	_savedScroll = null;
	_el.search?.blur();

	const finish = () => {
		_el.section?.classList.remove("is-open");
		if (_el.section) _el.section.style.height = "";
		if (_el.search) _el.search.value = "";
		_detachCards();
	};
	// صفحه‌ی اصلی همان لحظه برمی‌گردد؛ در گوشی این صفحه رویش کنار می‌رود
	_el.mainContent?.classList.remove(MAIN_OPEN_CLASS);
	if (isMobile() && _el.section?.classList.contains("is-open")) {
		_animate("slide-out", finish);
	} else {
		finish();
	}
}

/**
 * openChat() قبل از نمایش چت این را صدا می‌زند.
 * گوشی: این صفحه زیر چت باز می‌ماند. دسکتاپ: سمت چپ همان Active Chats +
 * پیش‌نمایش Contacts (با Show more) نشان داده می‌شود و این صفحه موقتاً کنار می‌رود.
 */
export function noteChatOpening() {
	if (!_open || _suspended) return;
	_savedScroll = _el.list?.scrollTop ?? 0;
	if (!isMobile()) {
		_suspended = true;
		_el.search?.blur();
		_setVisible(false);
		_el.section.style.height = "";
		_detachCards();
	}
}

/** closeChat() بعد از بستن چت صدا می‌زند: برگشت دقیق به همان حالت قبلی. */
export function noteChatClosed() {
	if (!_open) return;
	if (_suspended) {
		_suspended = false;
		_setVisible(true);
		render();
	}
	_fitDesktop({ align: true });
	if (_savedScroll !== null) {
		_scrollListTo(_savedScroll);
		_savedScroll = null;
	}
}

// هر بار بخش Contacts دوباره چیده شد، این تابع با لیست کامل و مرتب صدا زده می‌شود
export function setAllContacts(contacts) {
	_list = Array.isArray(contacts) ? contacts : [];
	const fade = _el.fade || document.getElementById("contacts-fade");
	// فقط وقتی از سقف بیشتر شد ظاهر می‌شود؛ با ۸ تا یا کمتر اصلاً دیده نمی‌شود
	if (fade) fade.hidden = _list.length <= CONTACTS_PREVIEW_COUNT;
	if (_open && !_suspended) render();
}

function _onResize() {
	const mobile = isMobile();
	const crossed = _wasMobile !== null && mobile !== _wasMobile;
	_wasMobile = mobile;
	if (!_open) return;
	// اگر چیدمان بین گوشی و دسکتاپ عوض شد، حالت را با آن هماهنگ کن
	if (crossed && !mobile && isChatOpen() && !_suspended) {
		noteChatOpening();
		return;
	}
	if (crossed && mobile && _suspended) {
		_suspended = false;
		_setVisible(true);
		render();
		if (_savedScroll !== null) _scrollListTo(_savedScroll);
	}
	_fitDesktop();
}

export function initAllContacts({ onContactAction, onOpenChat } = {}) {
	_onContactAction = onContactAction;
	_onOpenChat = onOpenChat;
	_el = {
		section: document.getElementById("all-contacts-section"),
		list: document.getElementById("all-contacts-list"),
		empty: document.getElementById("all-contacts-empty"),
		search: document.getElementById("all-contacts-search"),
		fade: document.getElementById("contacts-fade"),
		mainContent: document.getElementById("main-content"),
		peoplePart: document.getElementById("people-part"),
		chatPart: document.getElementById("chat-part"),
		header: document.querySelector("#people-part .main-header"),
	};

	document
		.getElementById("contacts-show-more")
		?.addEventListener("click", openAllContacts);
	document
		.getElementById("all-contacts-back")
		?.addEventListener("click", closeAllContacts);

	_el.search?.addEventListener("input", () => {
		render();
		_scrollListTo(0);
	});
	_el.search?.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		if (_el.search.value) {
			_el.search.value = "";
			render();
		} else {
			closeAllContacts();
		}
	});

	// کلیک روی کارت، چت را با همان مسیر صفحه‌ی اصلی باز می‌کند
	_el.list?.addEventListener("click", (e) => {
		if (
			e.target.closest(
				".contact-menu-btn, .contact-menu-overlay, .contact-menu-panel",
			)
		)
			return;
		const card = e.target.closest(".contacts-card");
		if (!card || !_el.list.contains(card)) return;
		const userId = Number(card.dataset.userId);
		if (!Number.isFinite(userId)) return;
		_onOpenChat?.(userId);
	});

	_wasMobile = isMobile();
	let resizeRaf = 0;
	window.addEventListener("resize", () => {
		cancelAnimationFrame(resizeRaf);
		resizeRaf = requestAnimationFrame(_onResize);
	});
}
