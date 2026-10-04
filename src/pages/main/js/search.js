import { contacts } from "./state.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { createMessage } from "../../../components/messages/messages.js";
import { safeFetch } from "../../../utils/fetch.js";
import { getCurrentUserId } from "../../../utils/user.js";
import { formatClock } from "../../../utils/date.js";

let _dom = {};
let _onContactAction = null;
let _onMessageClick = null;
// Answers can arrive out of order: only the latest search may draw results
let _searchSeq = 0;

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
	const seq = ++_searchSeq;
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
	await _renderMessageResults(q, seq);
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
function _renderContactResults(query) {
	const list = _dom.searchContactsList;
	list.textContent = "";

	const MAX_CONTACT_RESULTS = 50;
	const matched = contacts
		.filter((c) => c && !c.isBlocked && String(c.nickname || c.name || "").toLowerCase().includes(query))
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
async function _renderMessageResults(query, seq) {
	const list = _dom.searchMessagesList;
	list.textContent = "";

	const loading = document.createElement("p");
	loading.className = "search-no-results";
	loading.textContent = "Searching…";
	list.appendChild(loading);

	try {
		const data = await safeFetch(
			`/api/messages/search?q=${encodeURIComponent(query)}`,
		);
		if (seq !== _searchSeq) return;

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

			const messageId = result.messageId ?? result.id;
			const msgEl = createMessage({
				user: Number(result.senderId) === Number(myId),
				text: result.text,
				time: formatClock(new Date(result.createdAt)),
				isEdited: result.isEdited,
				isPinned: result.isPinned,
				isSeen: result.isSeen,
				isTimeCapsule: !!result.isTimeCapsule,
				isLocked: !!result.isLocked,
				scheduledFor: result.scheduledFor || null,
				openedAt: result.openedAt || null,
				isOneTime: !!result.isOneTime,
			});

			wrapper.appendChild(sender);
			wrapper.appendChild(msgEl);

			// opens the chat at this message (older pages load as needed)
			wrapper.addEventListener("click", () => {
				_onMessageClick(contact, messageId);
			});

			list.appendChild(wrapper);
		});
	} catch (err) {
		if (seq !== _searchSeq) return;
		list.textContent = "";
		const p = document.createElement("p");
		p.className = "search-no-results";
		p.textContent = err && err.status === 429 ? "Too many searches. Please wait a moment." : "Search failed";
		list.appendChild(p);
	}
}