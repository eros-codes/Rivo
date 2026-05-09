import { safeSrc } from "../../utils/dom.js";

export function createForwardedContactCard({ name, nickname, profilePics, isOnline, id }) {
	const card = document.createElement("span");
	card.className = "forwarded-contact-card";
	card.dataset.userId = id;

	const img = document.createElement("img");
	img.className = `forwarded-contact-profile ${isOnline ? "online-contact" : ""}`;
	img.src = safeSrc((profilePics && profilePics[0]) || "/assets/images/profile.jpeg");
	img.alt = "Profile";

	const nameEl = document.createElement("span");
	nameEl.className = "forwarded-contact-name";
	nameEl.textContent = nickname || name || "";

	card.appendChild(img);
	card.appendChild(nameEl);
	return card;
}
