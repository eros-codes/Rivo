// Search results: matching contacts (from the list here) and matching
// messages (searched on the server, newest first).
import { useEffect, useMemo, useState } from "react";
import { messagesApi } from "../../../shared/api/endpoints";
import { ApiError } from "../../../shared/api/http";
import type { SearchHit } from "../../../shared/api/types";
import { useStore } from "../../../shared/lib/store";
import { normalizeForSearch } from "../../../shared/lib/text";
import { closeSearch, openChat } from "../../services/navigation";
import { displayName } from "../../state/contactModel";
import { contacts } from "../../state/stores";
import type { BubbleData } from "../chat/bubbleData";
import { MessageBubble, type BubbleHandlers } from "../chat/MessageBubble";
import { searchResultsRef } from "../refs";
import { useMeId } from "../selectors";
import { ContactCard } from "./ContactCard";

const MAX_CONTACTS = 50;
const NOOP = () => undefined;
const NO_HANDLERS: BubbleHandlers = {
	onMenu: NOOP,
	onReply: NOOP,
	onToggle: NOOP,
	onQuote: NOOP,
	onReact: NOOP,
	onRetry: NOOP,
	onDiscard: NOOP,
	onCopy: NOOP,
};

function hitBubble(h: SearchHit, meId: number | null): BubbleData {
	const mine = h.senderId === meId;
	return {
		key: `s${h.id}`,
		id: h.id,
		clientId: null,
		mine,
		text: h.text,
		createdAt: h.createdAt,
		isEdited: h.isEdited,
		isPinned: h.isPinned,
		isOneTime: h.isOneTime,
		isTimeCapsule: h.isTimeCapsule,
		isLocked: h.isLocked,
		scheduledFor: h.scheduledFor,
		openedAt: h.openedAt,
		reply: null,
		forwardedFrom: null,
		reactions: [],
		status: mine ? (h.isSeen ? "seen" : "sent") : null,
		error: null,
		unseen: false,
	};
}

type MessageState = { kind: "loading" } | { kind: "done"; hits: SearchHit[] } | { kind: "error"; text: string };

export function SearchResults({ query }: { query: string }) {
	const byConv = useStore(contacts, (s) => s.byConv);
	const meId = useMeId();
	const [found, setFound] = useState<MessageState>({ kind: "loading" });

	const people = useMemo(() => {
		const q = normalizeForSearch(query);
		return Object.values(byConv)
			.filter((r) => !r.isBlocked && (normalizeForSearch(displayName(r)).includes(q) || normalizeForSearch(r.contact?.username ?? "").includes(q)))
			.slice(0, MAX_CONTACTS);
	}, [byConv, query]);

	useEffect(() => {
		const ctrl = new AbortController();
		setFound({ kind: "loading" });
		messagesApi
			.search(query, ctrl.signal)
			.then((res) => setFound({ kind: "done", hits: res.results }))
			.catch((e: unknown) => {
				if ((e as Error)?.name === "AbortError") return;
				setFound({
					kind: "error",
					text: e instanceof ApiError && e.status === 429 ? "Too many searches. Please wait a moment." : "Search failed",
				});
			});
		return () => ctrl.abort();
	}, [query]);

	const go = (convId: number, messageId: number | null) => {
		closeSearch();
		openChat(convId, { focusMessageId: messageId });
	};

	return (
		<div ref={searchResultsRef} className="search-results" id="search-results">
			<section className="search-contacts-section" aria-label="Contacts found">
				<h4 className="guid">Contacts</h4>
				{/* a card opens its chat itself (which also ends the search) */}
				<div className="search-contacts-list">
					{people.length === 0 ? (
						<p className="search-no-results">No contacts found</p>
					) : (
						people.map((row) => <ContactCard key={row.conversationId} row={row} meId={meId} />)
					)}
				</div>
			</section>
			<section className="search-messages-section" aria-label="Messages found">
				<h4 className="guid">Conversations</h4>
				<div className="search-messages-list">
					{found.kind === "loading" ? (
						<p className="search-no-results">Searching…</p>
					) : found.kind === "error" ? (
						<p className="search-no-results">{found.text}</p>
					) : found.hits.length === 0 ? (
						<p className="search-no-results">No messages found</p>
					) : (
						found.hits.map((h) => {
							const row = byConv[h.conversationId];
							if (!row) return null;
							return (
								<div
									key={h.id}
									className="search-message-result"
									role="button"
									tabIndex={0}
									onClick={() => go(h.conversationId, h.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											go(h.conversationId, h.id);
										}
									}}
								>
									<p className="search-message-sender">{displayName(row)}</p>
									<MessageBubble
										data={hitBubble(h, meId)}
										meId={meId}
										selecting={false}
										selected={false}
										fading={false}
										vanishing={false}
										highlighted={false}
										canReply={false}
										handlers={NO_HANDLERS}
										passive
									/>
								</div>
							);
						})
					)}
				</div>
			</section>
		</div>
	);
}
