export function createMessage({ user, text, time, index, isEdited = false, replyTo = null, forwardedFrom = null, seen = true, isPinned = false }) {
	const seenIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
					<circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.3"></circle>
					<path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10s10-4.47 10-10S17.53 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8s8 3.58 8 8s-3.58 8-8 8"></path>
					</svg>`;
	const sentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"></path>
                  	</svg>`;
	const pinIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
					<path fill="currentColor" d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"></path>
					</svg>`;

	const message = document.createElement("div");

	// "user ?" means that if the sender is user itself or not
	message.className = `chat-message ${user ? "outgoing" : "incoming"}`;
	message.dataset.index = index; // Add index to message element for styling purposes
	message.innerHTML = `
	${
		replyTo
			? `
		<div class="chat-reply" data-reply-to="${replyTo.index}">
			<span class="chat-reply-sender">${replyTo.sender}</span>
			<span class="chat-reply-text">${replyTo.text}</span>
		</div>`
			: ""
	}
	${
		forwardedFrom
			? `
			<div class="chat-forwarded-label">Forwarded from ${forwardedFrom}</div>`
			: ""
	}
	<p class="chat-message-text">${text}</p>
	<span class="chat-message-meta">
		${user && isPinned ? `<span class="chat-pinned-icon">${pinIcon}</span>` : ""}
		${user && isEdited  ? `<span class="chat-edited-label">edited</span>` : ""}
		<span class="chat-message-time">${time}</span>
		${!user && isEdited ? `<span class="chat-edited-label">edited</span>` : ""}
		${user && seen ? `<span class="chat-message-status">${seenIcon}</span>` : ""}
		${user && !seen ? `<span class="chat-message-status">${sentIcon}</span>` : ""}
		${!user && isPinned ? `<span class="chat-pinned-icon">${pinIcon}</span>` : ""}
	</span>
	`;

	return message;
}
