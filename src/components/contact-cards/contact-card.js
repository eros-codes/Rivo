import { parseSvg } from "../../utils/svg.js";

function safeSrc(url) {
	if (!url) return "/assets/images/profile.jpeg";
	const u = String(url).trim();
	if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("/")) return u;
	if (u.startsWith("data:image/")) return u;
	return "/assets/images/profile.jpeg";
}
const muteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4L9.91 6.09L12 8.18M4.27 3L3 4.27L7.73 9H3v6h4l5 5v-6.73l4.25 4.26c-.67.51-1.42.93-2.25 1.17v2.07c1.38-.32 2.63-.95 3.68-1.81L19.73 21L21 19.73l-9-9M19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.9 8.9 0 0 0 21 12c0-4.28-3-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71m-2.5 0c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.05-.2.05-.42.05-.63"/></svg>`;
const unmuteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77"/></svg>`;
const pinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z"/></svg>`;
const unpinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="m20.97 17.172l-1.414 1.414l-3.535-3.535l-.073.074l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243L5.34 8.761l3.536-.707l.073-.074l-3.536-3.536L6.828 3.03zM10.365 9.394l-.502.502l-2.822.565l6.5 6.5l.564-2.822l.502-.502zm8.411.074l-1.34 1.34l1.414 1.415l1.34-1.34l.707.707l1.415-1.415l-8.486-8.485l-1.414 1.414l.707.707l-1.34 1.34l1.414 1.415l1.34-1.34z"/></svg>`;
const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8 9h8v10H8zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
const dotsIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12 10c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0-6c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0 12c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2"/></svg>`;
const backIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M16.62 2.99a1.25 1.25 0 0 0-1.77 0L6.54 11.3a.996.996 0 0 0 0 1.41l8.31 8.31c.49.49 1.28.49 1.77 0s.49-1.28 0-1.77L9.38 12l7.25-7.25c.48-.48.48-1.28-.01-1.76"/></svg>`;

/**

- @param {{
- id, name, nickname, lastMessage, lastMessageSeen,
- profilePics, isOnline, isMuted, isPinned, isBlocked,
- hasMessages
- }} contact
- @param {Function} onAction — called with (action, userId)
- action: "pin" | "mute" | "delete"
  */
export function createContactCard(contact, onAction) {
	const {
		id,
		name,
		nickname,
		lastMessage,
		profilePics,
		isOnline,
		isBlocked,
		isMuted,
		isPinned = false,
		hasMessages = !!lastMessage,
	} = contact;

    

	// ── Card ──────────────────────────────────────────────────────────────────
	const card = document.createElement("span");
	card.className = "contacts-card";
	card.dataset.userId = id;

	// Menu button
	const menuBtn = document.createElement("button");
	menuBtn.className = "contact-menu-btn";
	menuBtn.tabIndex = -1;
	menuBtn.textContent = "";
	const _dots = parseSvg(dotsIcon);
	if (_dots) menuBtn.appendChild(_dots.cloneNode(true));

	const overlay = document.createElement("div");
	overlay.className = "contact-menu-overlay";

	const panel = document.createElement("div");
	panel.className = "contact-menu-panel";

	const muteBtn = document.createElement("button");
	muteBtn.className = "contact-menu-item";
	muteBtn.dataset.action = "mute";
	const muteIconWrap = document.createElement("span");
	muteIconWrap.className = "contact-menu-icon";
	muteIconWrap.textContent = "";
	const _muteSvg = parseSvg(isMuted ? unmuteIconSvg : muteIconSvg);
	if (_muteSvg) muteIconWrap.appendChild(_muteSvg.cloneNode(true));
	muteBtn.appendChild(muteIconWrap);
	panel.appendChild(muteBtn);

	const pinBtn = document.createElement("button");
	pinBtn.className = "contact-menu-item";
	pinBtn.dataset.action = "pin";
	const pinIconWrap = document.createElement("span");
	pinIconWrap.className = "contact-menu-icon";
	pinIconWrap.textContent = "";
	const _pinSvg = parseSvg(isPinned ? unpinIconSvg : pinIconSvg);
	if (_pinSvg) pinIconWrap.appendChild(_pinSvg.cloneNode(true));
	pinBtn.appendChild(pinIconWrap);
	panel.appendChild(pinBtn);

	if (hasMessages) {
		const delBtn = document.createElement("button");
		delBtn.className = "contact-menu-item contact-menu-item--danger";
		delBtn.dataset.action = "delete";
		const delIconWrap = document.createElement("span");
		delIconWrap.className = "contact-menu-icon";
		delIconWrap.textContent = "";
		const _delSvg = parseSvg(deleteIconSvg);
		if (_delSvg) delIconWrap.appendChild(_delSvg.cloneNode(true));
		delBtn.appendChild(delIconWrap);
		panel.appendChild(delBtn);
	}

	// Profile image
	const img = document.createElement("img");
	img.className = `contact-profile ${isOnline ? "online-contact" : ""}`;
	img.src = safeSrc((profilePics && profilePics[0]) || "/assets/images/profile.jpeg");
	img.alt = "Profile";

	// Name
	const nameSpan = document.createElement("span");
	nameSpan.className = "contact-name";
	nameSpan.textContent = nickname || name || "";
	if (isMuted) {
		const m = document.createElement("span");
		m.className = "contact-muted-icon";
		m.textContent = "";
		const _msvg = parseSvg(muteIconSvg);
		if (_msvg) m.appendChild(_msvg.cloneNode(true));
		nameSpan.appendChild(m);
	}

	// Message section
	const msgSpan = document.createElement("span");
	msgSpan.className = "contact-message";
	if (isBlocked) {
		const badge = document.createElement("span");
		badge.className = "blocked-badge";
		badge.textContent = "Blocked";
		msgSpan.appendChild(badge);
	} else if (!lastMessage) {
		const anchor = document.createElement("a");
		anchor.className = "send-message";
		anchor.textContent = "Send message";
		msgSpan.appendChild(anchor);
	} else {
		const last = document.createElement("span");
		last.className = "last-message";
		last.textContent = lastMessage;
		msgSpan.appendChild(last);
	}

	card.appendChild(menuBtn);
	card.appendChild(overlay);
	card.appendChild(panel);
	card.appendChild(img);
	card.appendChild(nameSpan);
	card.appendChild(msgSpan);

	// ── Menu logic ────────────────────────────────────────────────────────────

	let menuOpen = false;

	function openMenu(e) {
		e.stopPropagation();
		menuOpen = true;
		overlay.classList.add("active");
		panel.classList.add("active");
		menuBtn.textContent = "";
		const _back = parseSvg(backIcon);
		if (_back) menuBtn.appendChild(_back.cloneNode(true));
		menuBtn.classList.add("contact-menu-btn--back");
	}

	function closeMenu() {
		menuOpen = false;
		overlay.classList.remove("active");
		panel.classList.remove("active");
		menuBtn.textContent = "";
		const _dots2 = parseSvg(dotsIcon);
		if (_dots2) menuBtn.appendChild(_dots2.cloneNode(true));
		menuBtn.classList.remove("contact-menu-btn--back");
	}

	menuBtn.addEventListener("click", (e) => {
		if (menuOpen) closeMenu();
		else openMenu(e);
	});

	overlay.addEventListener("click", (e) => {
		e.stopPropagation();
		closeMenu();
	});

	panel.querySelectorAll(".contact-menu-item").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			closeMenu();
			if (onAction) onAction(btn.dataset.action, id);
		});
	});

	card.addEventListener("click", (e) => {
		if (menuOpen) {
			e.stopPropagation();
			closeMenu();
		}
	});

	return card;
}
