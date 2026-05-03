import { escapeHtml } from "../messages/messages.js";
import { parseSvg } from "../../utils/svg.js";
const muteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4L9.91 6.09L12 8.18M4.27 3L3 4.27L7.73 9H3v6h4l5 5v-6.73l4.25 4.26c-.67.51-1.42.93-2.25 1.17v2.07c1.38-.32 2.63-.95 3.68-1.81L19.73 21L21 19.73l-9-9M19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.9 8.9 0 0 0 21 12c0-4.28-3-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71m-2.5 0c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.05-.2.05-.42.05-.63"></path></svg>`;
const unmuteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77"/></svg>`;
const pinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="currentColor" d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"></path></svg>`;
const unpinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="m20.97 17.172l-1.414 1.414l-3.535-3.535l-.073.074l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243L5.34 8.761l3.536-.707l.073-.074l-3.536-3.536L6.828 3.03zM10.365 9.394l-.502.502l-2.822.565l6.5 6.5l.564-2.822l.502-.502zm8.411.074l-1.34 1.34l1.414 1.415l1.34-1.34l.707.707l1.415-1.415l-8.486-8.485l-1.414 1.414l.707.707l-1.34 1.34l1.414 1.415l1.34-1.34z"/></svg>`;
const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8 9h8v10H8zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
const blockIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2M4 12c0-4.42 3.58-8 8-8c1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.9 7.9 0 0 1 4 12m8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.9 7.9 0 0 1 20 12c0 4.42-3.58 8-8 8"/></svg>`;

export function createActiveChatCard({
	id,
	name,
	nickname,
	lastMessage,
	profilePics,
	isOnline,
	isMuted,
	lastMessageTime,
	lastMessageDate,
	isPinned,
	unreadCount,
}) {
	const muteEl = isMuted ? muteIconSvg : "";
	const pinEl = isPinned ? pinIconSvg : "";
	// Wrapper
	const wrapper = document.createElement("div");
	wrapper.className = "active-chat-wrapper";
	wrapper.dataset.wrapperUserId = id;

	// Right actions (buttons)
	const actionsRight = document.createElement("div");
	actionsRight.className = "card-actions card-actions--right";
	const muteBtn = document.createElement("button");
	muteBtn.className = "card-action-btn card-action-btn--mute";
	muteBtn.dataset.action = "mute";
	muteBtn.title = isMuted ? "Unmute" : "Mute";
	muteBtn.textContent = '';
	const _mute = parseSvg(isMuted ? unmuteIconSvg : muteIconSvg);
	if (_mute) muteBtn.appendChild(_mute.cloneNode(true));
	const pinBtn = document.createElement("button");
	pinBtn.className = "card-action-btn card-action-btn--pin";
	pinBtn.dataset.action = "pin";
	pinBtn.title = isPinned ? "Unpin" : "Pin";
	pinBtn.textContent = '';
	const _pin = parseSvg(isPinned ? unpinIconSvg : pinIconSvg);
	if (_pin) pinBtn.appendChild(_pin.cloneNode(true));
	actionsRight.appendChild(muteBtn);
	actionsRight.appendChild(pinBtn);

	// Left actions
	const actionsLeft = document.createElement("div");
	actionsLeft.className = "card-actions card-actions--left";
	const delBtn = document.createElement("button");
	delBtn.className = "card-action-btn card-action-btn--delete";
	delBtn.dataset.action = "delete";
	delBtn.title = "Delete";
	delBtn.textContent = '';
	const _del = parseSvg(deleteIconSvg);
	if (_del) delBtn.appendChild(_del.cloneNode(true));
	actionsLeft.appendChild(delBtn);

	function formatCardTime (date, time) {
		if (!date && !time) return "";
		const today = new Date().toISOString().slice(0, 10)
		const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
		if (date === today) return time;
		if (date === yesterday) return "yesterday";
		if (date) return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric"});
	}

	// Card
	const active = document.createElement("div");
	active.className = isPinned ? "active-chat pinned" : "active-chat";
	active.dataset.userId = id;

	function safeSrc(url) {
		if (!url) return "/assets/images/profile.jpeg";
		const u = String(url).trim();
		if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("/")) return u;
		if (u.startsWith("data:image/")) return u;
		return "/assets/images/profile.jpeg";
	}

	const img = document.createElement("img");
	img.className = `active-chat-profile ${isOnline ? "online-active-chat" : ""}`;
	img.src = safeSrc((profilePics && profilePics[0]) || "/assets/images/profile.jpeg");
	img.alt = "active-profile";

	const info = document.createElement("span");
	info.className = "active-chat-info";
	const nameEl = document.createElement("span");
	nameEl.className = "active-chat-name";
	nameEl.textContent = nickname || name || "";
	if (isPinned) {
		const pinSpan = document.createElement("span");
		pinSpan.className = "active-chat-pin";
		pinSpan.textContent = '';
		const _p = parseSvg(pinIconSvg);
		if (_p) pinSpan.appendChild(_p.cloneNode(true));
		nameEl.appendChild(pinSpan);
	}
	const lastEl = document.createElement("span");
	lastEl.className = "active-chat-last-message";
	lastEl.textContent = lastMessage || "";
	if (isMuted) {
		const muteSpan = document.createElement("span");
		muteSpan.className = "active-chat-mute";
		muteSpan.textContent = '';
		const _m = parseSvg(muteIconSvg);
		if (_m) muteSpan.appendChild(_m.cloneNode(true));
		lastEl.appendChild(muteSpan);
	}
	info.appendChild(nameEl);
	info.appendChild(lastEl);

	const meta = document.createElement("span");
	meta.className = "active-chat-meta";
	const timeEl = document.createElement("span");
	timeEl.className = "active-chat-message-time";
	timeEl.textContent = formatCardTime(lastMessageDate, lastMessageTime);
	const unreadEl = document.createElement("span");
	unreadEl.className = "active-chat-unread-messages";
	if (unreadCount === 0) unreadEl.style.opacity = 0;
	const unreadInner = document.createElement("p");
	unreadInner.textContent = String(unreadCount);
	unreadEl.appendChild(unreadInner);
	meta.appendChild(timeEl);
	meta.appendChild(unreadEl);

	active.appendChild(img);
	active.appendChild(info);
	active.appendChild(meta);

    wrapper.appendChild(actionsLeft);
	wrapper.appendChild(active);
	wrapper.appendChild(actionsRight);

	return wrapper;
}
