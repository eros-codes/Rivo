// Archived chats (from Settings): open one, or bring it back to the lists.
import { useMemo } from "react";
import { useStore } from "../../../shared/lib/store";
import { Avatar } from "../../../shared/ui/Avatar";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icons } from "../../../shared/ui/icons";
import { setArchived } from "../../services/actions";
import { closeDialog, openChat } from "../../services/navigation";
import { displayName, isDeletedAccount, isOnline, lastTime } from "../../state/contactModel";
import { contacts, undoing } from "../../state/stores";
import { useUi } from "../selectors";

function Archived() {
	const byConv = useStore(contacts, (s) => s.byConv);
	const removed = useStore(undoing, (s) => s.removedContacts);
	const rows = useMemo(
		() =>
			Object.values(byConv)
				.filter((r) => r.isArchived && !r.isSaved && !removed[r.conversationId])
				// most recent conversation first
				.sort((a, b) => lastTime(b) - lastTime(a) || b.id - a.id),
		[byConv, removed],
	);

	return (
		<Dialog className="archived-dialog" onClose={closeDialog} labelledBy="archived-dialog-title">
			<div className="archived-dialog-header">
				<button type="button" className="archived-dialog-close" aria-label="Close" onClick={closeDialog}>
					<Icons.Close size={22} />
				</button>
				<h3 className="archived-dialog-title" id="archived-dialog-title">
					Archived Chats
				</h3>
			</div>
			<div className="archived-dialog-list">
				{rows.length === 0 ? (
					<p className="archived-dialog-empty">No archived chats</p>
				) : (
					rows.map((row) => {
						const name = displayName(row);
						return (
							<div key={row.conversationId} className="archived-card" onClick={() => openChat(row.conversationId)}>
								<button
									type="button"
									className="card-open-btn visually-hidden"
									onClick={(e) => {
										e.stopPropagation();
										openChat(row.conversationId);
									}}
								>
									Open chat with {name}
								</button>
								<div className="archived-card-left">
									<Avatar
										name={name}
										picture={row.contact?.profilePics[0]}
										className="archived-card-avatar"
										online={isOnline(row)}
										onlineClass="online"
										deleted={isDeletedAccount(row)}
									/>
									<span className="archived-card-name" dir="auto">
										{name}
									</span>
								</div>
								<button
									type="button"
									className="archived-card-unarchive-btn"
									title="Unarchive"
									aria-label={`Unarchive ${name}`}
									onClick={(e) => {
										e.stopPropagation();
										void setArchived(row, false);
									}}
								>
									<Icons.Unarchive />
								</button>
							</div>
						);
					})
				)}
			</div>
		</Dialog>
	);
}

export function ArchivedDialog() {
	const open = useUi((s) => s.dialog === "archived");
	return open ? <Archived /> : null;
}
