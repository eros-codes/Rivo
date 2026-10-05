// All pinned messages of the chat, newest first; a tap jumps to one.
import type { ContactRow, PinnedItem } from "../../../shared/api/types";
import { clock } from "../../../shared/lib/time";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icons } from "../../../shared/ui/icons";
import { closeDialog, focusMessage } from "../../services/navigation";
import { displayName } from "../../state/contactModel";
import { pinnedText } from "./PinnedBar";

export function PinnedViewDialog({ row, pinned, meId }: { row: ContactRow; pinned: PinnedItem[]; meId: number | null }) {
	const newestFirst = [...pinned].reverse();
	return (
		<Dialog className="pinned-view-dialog" onClose={closeDialog} label="Pinned messages">
			<div className="pinned-view-header">
				<span className="pinned-view-title">Pinned Messages</span>
				<button type="button" className="pinned-view-close" aria-label="Close" onClick={closeDialog}>
					<Icons.Close />
				</button>
			</div>
			<div className="pinned-view-list">
				{newestFirst.length === 0 ? (
					<p className="pinned-view-empty">No pinned messages</p>
				) : (
					newestFirst.map((p) => (
						<button
							key={p.id}
							type="button"
							className="pinned-view-item"
							onClick={() => {
								closeDialog();
								focusMessage(row.conversationId, p.id);
							}}
						>
							<div className="pinned-view-item-meta">
								<span className="pinned-view-item-sender">{p.senderId === meId ? "You" : displayName(row)}</span>
								<span className="pinned-view-item-time">{clock(p.createdAt)}</span>
							</div>
							<p className="pinned-view-item-text" dir="auto">
								{pinnedText(p)}
							</p>
						</button>
					))
				)}
			</div>
		</Dialog>
	);
}
