import { contacts, messages } from "./state.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createMessage } from "../../../components/messages/messages.js";
import { getCurrentUserId } from "../../../utils/user.js";

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

export async function runSearch(query) {
	const q = String(query || "")
		.trim()
		.toLowerCase();
	if (!q || q.length < 2) {
		_dom.mainContent.style.display = "";
		_dom.searchResults.style.display = "none";
		return;
	}

	_dom.mainContent.style.display = "none";
	_dom.searchResults.style.display = "flex";

	_renderContactResults(q);
	await _renderMessageResults(q);
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
async function _renderMessageResults(query) {
	const list = _dom.searchMessagesList;
	list.textContent = "";

	const loading = document.createElement("p");
	loading.className = "search-no-results";
	loading.textContent = "Searching…";
	list.appendChild(loading);

	try {
		const res = await fetch(
			`/api/messages/search?q=${encodeURIComponent(query)}`,
			{ credentials: "include" },
		);
		if (!res.ok) throw new Error();
		const data = await res.json();

		list.textContent = "";

		if (!data.results || data.results.length === 0) {
			const p = document.createElement("p");
			p.className = "search-no-results";
			p.textContent = "No messages found";
			list.appendChild(p);
			return;
		}

		const myId = getCurrentUserId();

		data.results.forEach((result) => {
			const contact = contacts.find(
				(c) => c.conversationId === result.conversationId,
			);
			if (!contact) return;

			const wrapper = document.createElement("div");
			wrapper.className = "search-message-result";

			const sender = document.createElement("p");
			sender.className = "search-message-sender";
			sender.textContent = contact.nickname || contact.name;

			const msgEl = createMessage({
				user: result.senderId === myId,
				text: result.text,
				time: new Date(result.createdAt).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				}),
				index: null,
				isEdited: result.isEdited,
				isPinned: result.isPinned,
				isSeen: result.isSeen,
			});

			wrapper.appendChild(sender);
			wrapper.appendChild(msgEl);

			wrapper.addEventListener("click", () => {
				_onMessageClick(contact, null);
			});

			list.appendChild(wrapper);
		});
	} catch {
		list.textContent = "";
		const p = document.createElement("p");
		p.className = "search-no-results";
		p.textContent = "Search failed";
		list.appendChild(p);
	}
}