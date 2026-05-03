import { escapeHtml } from "../messages/messages.js";

function safeSrc(url) {
	if (!url) return "/assets/images/profile.jpeg";
	const u = String(url).trim();
	if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("/")) return u;
	if (u.startsWith("data:image/")) return u;
	return "/assets/images/profile.jpeg";
}

export function createForwardedContactCard({ name, profilePics, isOnline, id }) {
	const card = document.createElement("span");
	card.className = "forwarded-contact-card";
	card.dataset.userId = id;

	const img = document.createElement("img");
	img.className = `forwarded-contact-profile ${isOnline ? "online-contact" : ""}`;
	img.src = safeSrc((profilePics && profilePics[0]) || "/assets/images/profile.jpeg");
	img.alt = "Profile";

	const nameEl = document.createElement("span");
	nameEl.className = "forwarded-contact-name";
	nameEl.textContent = escapeHtml(name);

	card.appendChild(img);
	card.appendChild(nameEl);
	return card;
}
