import { createContactCard } from "../../../components/contact-cards/contact-card.js";

// تعداد مخاطبی که در صفحه‌ی اصلی نشان داده می‌شود؛ بقیه پشت «Show all» می‌مانند
export const CONTACTS_PREVIEW_COUNT = 8;

let allContacts = [];
let onOpenChat = null;

function render(filter = "") {
	const list = document.getElementById("all-contacts-list");
	const empty = document.getElementById("all-contacts-empty");
	if (!list) return;

	const q = filter.trim().toLowerCase();
	const matched = q
		? allContacts.filter((c) => {
				const name = (c.nickname || c.name || "").toLowerCase();
				const username = (c.username || "").toLowerCase();
				return name.includes(q) || username.includes(q);
			})
		: allContacts;

	list.textContent = "";
	matched.forEach((contact) => list.appendChild(createContactCard(contact)));
	if (empty) empty.hidden = matched.length > 0;
}

export function openAllContacts() {
	const section = document.getElementById("all-contacts-section");
	const mainContent = document.getElementById("main-content");
	if (!section || !mainContent) return;
	// همان الگوی search: بخش‌های دیگر مخفی، این یکی نمایش داده می‌شود
	Array.from(mainContent.children).forEach((child) => {
		if (child !== section) child.dataset.prevDisplay = child.style.display;
	});
	Array.from(mainContent.children).forEach((child) => {
		if (child !== section) child.style.display = "none";
	});
	section.style.display = "flex";
	const input = document.getElementById("all-contacts-search");
	if (input) {
		input.value = "";
		input.focus();
	}
	render("");
}

export function closeAllContacts() {
	const section = document.getElementById("all-contacts-section");
	const mainContent = document.getElementById("main-content");
	if (!section || !mainContent) return;
	section.style.display = "none";
	Array.from(mainContent.children).forEach((child) => {
		if (child !== section) child.style.display = child.dataset.prevDisplay || "";
	});
}

// هر بار لیست مخاطبین به‌روز شد، این تابع صدا زده می‌شود
export function setAllContacts(contacts) {
	allContacts = contacts;
	const btn = document.getElementById("contacts-show-more");
	const label = document.getElementById("contacts-show-more-label");
	if (btn) btn.hidden = contacts.length <= CONTACTS_PREVIEW_COUNT;
	if (label) label.textContent = `Show all contacts (${contacts.length})`;
	// اگر صفحه باز است، محتوایش هم تازه شود
	const section = document.getElementById("all-contacts-section");
	if (section && section.style.display === "flex") {
		render(document.getElementById("all-contacts-search")?.value || "");
	}
}

export function initAllContacts({ onOpen } = {}) {
	onOpenChat = onOpen;
	document.getElementById("contacts-show-more")?.addEventListener("click", openAllContacts);
	document.getElementById("all-contacts-back")?.addEventListener("click", closeAllContacts);
	document.getElementById("all-contacts-search")?.addEventListener("input", (e) => render(e.target.value));
	// کلیک روی کارت مخاطب، همان چت را باز می‌کند
	document.getElementById("all-contacts-list")?.addEventListener("click", (e) => {
		const card = e.target.closest("[data-wrapper-user-id]");
		if (!card) return;
		closeAllContacts();
		onOpenChat?.(card.dataset.wrapperUserId);
	});
}
