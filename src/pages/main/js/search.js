import { contacts, messages } from "./state.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createMessage } from "../../../components/messages/messages.js";

let _dom = {};
let _onContactAction = null;
let _onMessageClick = null;

/**
 * @param {{
 * mainContent, searchResults,
 * searchContactsList, searchMessagesList,
 * onContactAction, onMessageClick
 * }} dom
 */
export function initSearch(dom) {
	_dom = dom;
	_onContactAction = dom.onContactAction;
	_onMessageClick = dom.onMessageClick;
}

export function runSearch(query) {
	const q = String(query || "").trim().toLowerCase();
	// require a minimal query to avoid expensive full scans
	if (!q || q.length < 2) {
		_dom.mainContent.style.display = "";
		_dom.searchResults.style.display = "none";
		return;
	}

	_dom.mainContent.style.display = "none";
	_dom.searchResults.style.display = "flex";

	_renderContactResults(q);
	_renderMessageResults(q);
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
function _renderContactResults(query) {
	const list = _dom.searchContactsList;
	list.textContent = "";

	const MAX_CONTACT_RESULTS = 50;
	const matched = contacts
		.filter(
			(c) =>
				!c.isArchived &&
				!c.isBlocked &&
				(c.nickname || c.name).toLowerCase().includes(query),
		)
		.slice(0, MAX_CONTACT_RESULTS);

	if (matched.length === 0) {
		const p = document.createElement("p");
		p.className = "search-no-results";
		p.textContent = "No contacts found";
		list.appendChild(p);
		return;
	}

	matched.forEach((c) => {
		const card = createContactCard(
			{ ...c, hasMessages: !!c.lastMessage },
			_onContactAction,
		);

		card.addEventListener("click", (e) => {
			if (
				e.target.closest(".contact-menu-btn") ||
				e.target.closest(".contact-menu-panel")
			)
				return;
			_onMessageClick(c, null);
		});

		list.appendChild(card);
	});
}

// ─── Messages ─────────────────────────────────────────────────────────────────
function _renderMessageResults(query) {
	const list = _dom.searchMessagesList;
	list.textContent = "";

	let found = false;
	const MAX_MESSAGE_RESULTS = 50;
	let resultsCount = 0;
	// stop scanning once we reach max results
	outer: for (let ci = 0; ci < contacts.length; ci++) {
		const contact = contacts[ci];
		const msgs = messages[contact.id];
		if (!msgs) continue;

		for (let idx = 0; idx < msgs.length; idx++) {
			const msg = msgs[idx];
			if (!msg.text) continue;
			if (!msg.text.toLowerCase().includes(query)) continue;

			found = true;
			resultsCount++;

			const wrapper = document.createElement("div");
			wrapper.className = "search-message-result";

			const sender = document.createElement("p");
			sender.className = "search-message-sender";
			sender.textContent = contact.nickname || contact.name;

			const msgEl = createMessage({
				user: msg.user,
				text: msg.text,
				time: msg.time,
				index: idx,
				isEdited: msg.isEdited,
				replyTo: msg.replyTo,
				isSeen: msg.isSeen,
				isPinned: msg.isPinned,
			});

			wrapper.appendChild(sender);
			wrapper.appendChild(msgEl);

			wrapper.addEventListener("click", () => {
				_onMessageClick(contact, idx);
			});

			list.appendChild(wrapper);

			if (resultsCount >= MAX_MESSAGE_RESULTS) break outer;
		}
	}

	if (!found) {
		const p = document.createElement("p");
		p.className = "search-no-results";
		p.textContent = "No messages found";
		list.appendChild(p);
	}
}
