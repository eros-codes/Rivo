// The lists side: header, Contacts, All contacts, Active Chats, or the
// search results while searching.
import { useEffect, useState } from "react";
import { useChatLists, useUi } from "../selectors";
import { ActiveChats } from "./ActiveChats";
import { AllContacts } from "./AllContacts";
import { ContactsSection } from "./ContactsSection";
import { Header } from "./Header";
import { SearchResults } from "./SearchResults";

export function PeoplePart({ phone }: { phone: boolean }) {
	const lists = useChatLists();
	const chatOpen = useUi((s) => s.openConvId !== null);
	const allOpen = useUi((s) => s.allContactsOpen);
	const query = useUi((s) => s.search.query);
	const searching = query.trim().length >= 2;

	// phone: the header steps away once the chat has slid over it
	const [headerHidden, setHeaderHidden] = useState(false);
	useEffect(() => {
		if (!phone || !chatOpen) {
			setHeaderHidden(false);
			return undefined;
		}
		const t = window.setTimeout(() => setHeaderHidden(true), 200);
		return () => window.clearTimeout(t);
	}, [phone, chatOpen]);

	const classes = ["main-content"];
	// desktop with a chat open: Active Chats above, Contacts below
	if (!phone && chatOpen) classes.push("flex-column-reverse");
	if (allOpen && (phone || !chatOpen)) classes.push("all-contacts-open");

	return (
		<div className="people-part" id="people-part">
			<Header hidden={headerHidden} />
			<div className={classes.join(" ")} id="main-content" style={searching ? { display: "none" } : undefined}>
				<ContactsSection rows={lists.contacts} />
				<AllContacts rows={lists.contacts} phone={phone} chatOpen={chatOpen} />
				<ActiveChats rows={lists.active} />
			</div>
			{searching && <SearchResults query={query.trim()} />}
		</div>
	);
}
