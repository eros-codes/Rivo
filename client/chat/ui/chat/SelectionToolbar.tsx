// Selection mode: how many are picked, forward, delete (only the user's own), cancel.
import type { ContactRow, LiveMessage } from "../../../shared/api/types";
import { Icons } from "../../../shared/ui/icons";
import { deleteMessages, forwardSource } from "../../services/actions";
import { showToast } from "../../services/feedback";
import { cancelSelection, openDialog } from "../../services/navigation";
import { displayName } from "../../state/contactModel";
import { ui } from "../../state/stores";

export function SelectionToolbar({
	row,
	selected,
	meId,
	refCallback,
}: {
	row: ContactRow;
	/** the picked messages, in chat order */
	selected: LiveMessage[];
	meId: number | null;
	refCallback: (el: HTMLDivElement | null) => void;
}) {
	const convId = row.conversationId;
	const allMine = selected.length > 0 && selected.every((m) => m.senderId === meId);

	const forward = () => {
		// someone else's sealed capsule or one-time message is not passed on
		const items = selected.filter((m) => m.senderId === meId || (!m.isLocked && !m.isOneTime)).map((m) => forwardSource(convId, m));
		if (items.length === 0) {
			cancelSelection();
			showToast("These messages can't be forwarded", { icon: "error" });
			return;
		}
		ui.set((s) => ({ ...s, forwarding: { items, fromName: row.isSaved ? "You" : displayName(row) || "Unknown" } }));
		openDialog("forward");
	};

	const remove = () => {
		if (!allMine) {
			showToast("You can only delete your own messages", { icon: "error" });
			cancelSelection();
			return;
		}
		const ids = selected.map((m) => m.id);
		cancelSelection();
		deleteMessages(convId, ids);
	};

	return (
		<div ref={refCallback} className="selection-toolbar" role="toolbar" aria-label="Selected messages">
			<p className="selection-count" aria-live="polite">
				{selected.length} selected
			</p>
			<div className="selection-actions">
				<button type="button" className="selection-forward-btn" aria-label="Forward" onClick={forward}>
					<Icons.Forward />
				</button>
				{allMine && (
					<button type="button" className="selection-delete-btn" aria-label="Delete" onClick={remove}>
						<Icons.Delete />
					</button>
				)}
				<button type="button" className="cancel-selection-btn" onClick={cancelSelection}>
					Cancel
				</button>
			</div>
		</div>
	);
}
