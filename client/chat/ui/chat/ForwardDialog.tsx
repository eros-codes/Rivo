// "Forward to...": the chats that can receive messages.
import { useMemo } from "react";
import { useStore } from "../../../shared/lib/store";
import { Avatar } from "../../../shared/ui/Avatar";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icons } from "../../../shared/ui/icons";
import { cancelSelection, closeDialog, openChat } from "../../services/navigation";
import { patchComposer } from "../../state/composerModel";
import { displayName, isDeletedAccount, sortActive } from "../../state/contactModel";
import { contacts, ui, undoing } from "../../state/stores";

export function ForwardDialog() {
	const forwarding = useStore(ui, (s) => s.forwarding);
	const byConv = useStore(contacts, (s) => s.byConv);
	const removed = useStore(undoing, (s) => s.removedContacts);
	const targets = useMemo(
		() => sortActive(Object.values(byConv).filter((r) => !r.isBlocked && !isDeletedAccount(r) && !removed[r.conversationId]), {}),
		[byConv, removed],
	);

	const choose = (convId: number) => {
		if (!forwarding) return;
		cancelSelection();
		closeDialog();
		openChat(convId);
		patchComposer(convId, { action: { kind: "forward", items: forwarding.items, fromName: forwarding.fromName }, mode: "normal", scheduledFor: null });
	};

	return (
		<Dialog className="forward-dialog" onClose={closeDialog} label="Forward to">
			<div className="forward-dialog-header">
				<span>Forward to...</span>
				<button type="button" className="close-forward-dialog" aria-label="Close" onClick={closeDialog}>
					✕
				</button>
			</div>
			<div className="forwarded-contact-dialog">
				{targets.map((row) => (
					<button key={row.conversationId} type="button" className="forwarded-contact-card" onClick={() => choose(row.conversationId)}>
						{row.isSaved ? (
							<div className="forwarded-contact-profile saved-icon forwarded-saved-icon">
								<Icons.Saved />
							</div>
						) : (
							<Avatar name={displayName(row)} picture={row.contact?.profilePics[0]} className="forwarded-contact-profile" />
						)}
						<span className="forwarded-contact-name" dir="auto">
							{displayName(row)}
						</span>
					</button>
				))}
			</div>
		</Dialog>
	);
}
