import { safeSrc, createAvatarElement } from "../../utils/dom.js";

export function createForwardedContactCard({ name, nickname, profilePics, isOnline, id }) {
	const card = document.createElement("span");
	card.className = "forwarded-contact-card";
	card.dataset.userId = id;

	const avatarEl = createAvatarElement({ name, nickname, profilePics, className: "forwarded-contact-profile", isOnline });

	const nameEl = document.createElement("span");
	nameEl.className = "forwarded-contact-name";
	nameEl.textContent = nickname || name || "";

	if (avatarEl) card.appendChild(avatarEl);
	card.appendChild(nameEl);
	return card;
}
