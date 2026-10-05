// The Contacts grid: the first eight, with "Show more" for the rest.
import type { ContactRow } from "../../../shared/api/types";
import { useStore } from "../../../shared/lib/store";
import { Icons } from "../../../shared/ui/icons";
import { openAllContacts } from "../../services/navigation";
import { contacts, undoing } from "../../state/stores";
import { useMeId } from "../selectors";
import { ContactCard } from "./ContactCard";
import { ContactSkeletons } from "./Skeletons";

export const PREVIEW_COUNT = 8;

export function ContactsSection({ rows }: { rows: ContactRow[] }) {
	const loaded = useStore(contacts, (s) => s.loaded);
	// "No contacts yet" only when there is nobody at all (Saved Messages aside)
	const nobody = useStore(contacts, (s) => s.loaded && !Object.values(s.byConv).some((r) => !r.isSaved));
	const meId = useMeId();
	const cleared = useStore(undoing, (s) => s.clearedChats);
	const removed = useStore(undoing, (s) => s.removedContacts);

	return (
		<section className="contacts-container" aria-busy={!loaded} aria-label="Contacts">
			<h4 className="guid">Contacts</h4>
			{nobody && (
				<div className="contacts-empty">
					<Icons.People />
					<p>No contacts yet</p>
				</div>
			)}
			{!loaded ? (
				<ContactSkeletons />
			) : (
				rows
					.slice(0, PREVIEW_COUNT)
					.map((row) => (
						<ContactCard
							key={row.conversationId}
							row={row}
							meId={meId}
							fading={!!cleared[row.conversationId] || !!removed[row.conversationId]}
						/>
					))
			)}
			{loaded && rows.length > PREVIEW_COUNT && (
				<div className="contacts-fade">
					<button type="button" className="contacts-show-more" onClick={openAllContacts}>
						Show more
					</button>
				</div>
			)}
		</section>
	);
}
