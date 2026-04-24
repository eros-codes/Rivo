export function createForwardedContactCard({
	name,
	profilePics,
	isOnline,
	id,
}) {
	const card = document.createElement("span");
	card.className = "forwarded-contact-card";
	card.dataset.userId = id;
	card.innerHTML = `
        <img
        class="forwarded-contact-profile ${isOnline ? "online-contact" : ""}"
        src="${profilePics[0]}"
        alt="Profile"
        />
        <span class="forwarded-contact-name">${name}</span>
    `;
	return card;
}
