// "Show more": every contact, with a search box. On a desktop it takes the
// Contacts column (and steps aside while a chat is open); on a phone it is a
// page of its own that chats slide in over.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContactRow } from "../../../shared/api/types";
import { usePresence } from "../../../shared/lib/hooks";
import { useStore } from "../../../shared/lib/store";
import { normalizeForSearch } from "../../../shared/lib/text";
import { Icons } from "../../../shared/ui/icons";
import { closeAllContacts } from "../../services/navigation";
import { displayName } from "../../state/contactModel";
import { undoing } from "../../state/stores";
import { useMeId, useUi } from "../selectors";
import { ContactCard } from "./ContactCard";

export function AllContacts({ rows, phone, chatOpen }: { rows: ContactRow[]; phone: boolean; chatOpen: boolean }) {
	const open = useUi((s) => s.allContactsOpen);
	// desktop: a chat opened from here takes the screen; closing it comes back here
	const visible = open && (phone || !chatOpen);
	const { mounted, state } = usePresence(visible, phone ? 300 : 0);
	const [query, setQuery] = useState("");
	const meId = useMeId();
	const cleared = useStore(undoing, (s) => s.clearedChats);
	const removed = useStore(undoing, (s) => s.removedContacts);
	const section = useRef<HTMLElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const savedScroll = useRef(0);

	// a fresh visit starts with an empty search at the top
	useEffect(() => {
		if (open) return;
		setQuery("");
		savedScroll.current = 0;
	}, [open]);

	const matched = useMemo(() => {
		const q = normalizeForSearch(query.trim());
		if (!q) return rows;
		return rows.filter((r) => normalizeForSearch(displayName(r)).includes(q) || normalizeForSearch(r.contact?.username ?? "").includes(q));
	}, [rows, query]);

	// desktop: the list scrolls by itself, from below the header to the bottom
	useLayoutEffect(() => {
		const el = section.current;
		if (!el) return undefined;
		if (!visible || phone) {
			el.style.height = "";
			return undefined;
		}
		const people = document.getElementById("people-part");
		const fit = () => {
			if (!people || !el.getClientRects().length) return;
			const offset = el.getBoundingClientRect().top - people.getBoundingClientRect().top + people.scrollTop;
			el.style.height = `${Math.max(260, people.clientHeight - offset)}px`;
		};
		people?.scrollTo({ top: 0, behavior: "instant" });
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, [visible, phone, mounted]);

	// back from a chat: the same place in the list
	useLayoutEffect(() => {
		if (visible && list.current) list.current.scrollTop = savedScroll.current;
	}, [visible]);

	// only on a desktop: on a phone the keyboard would cover half the page
	useEffect(() => {
		if (visible && !phone && window.matchMedia("(hover: hover)").matches) input.current?.focus({ preventScroll: true });
	}, [visible, phone]);

	if (!mounted) return null;
	const anim = phone ? (state === "enter" ? " slide-in" : state === "exit" ? " slide-out" : "") : "";

	return (
		<section ref={section} className={`all-contacts-section is-open${anim}`} aria-label="All contacts">
			<header className="all-contacts-header">
				<button type="button" className="all-contacts-back" aria-label="Back" onClick={closeAllContacts}>
					<Icons.Back size={22} />
				</button>
				<div className="all-contacts-search-bar">
					<Icons.SearchLine />
					<input
						ref={input}
						type="search"
						className="all-contacts-search"
						placeholder="Search contacts"
						autoComplete="off"
						enterKeyHint="search"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							if (list.current) list.current.scrollTop = 0;
						}}
						onKeyDown={(e) => {
							if (e.key !== "Escape") return;
							e.preventDefault();
							if (query) setQuery("");
							else closeAllContacts();
						}}
					/>
				</div>
			</header>
			<div ref={list} className="all-contacts-list" onScroll={(e) => (savedScroll.current = e.currentTarget.scrollTop)}>
				{matched.map((row) => (
					<ContactCard key={row.conversationId} row={row} meId={meId} fading={!!cleared[row.conversationId] || !!removed[row.conversationId]} />
				))}
			</div>
			{matched.length === 0 && <p className="all-contacts-empty">No contact found</p>}
		</section>
	);
}
