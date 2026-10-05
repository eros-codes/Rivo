// The pinned-messages bar under the chat header. It shows the newest pinned
// message on screen (or the newest one); a tap jumps to it and then shows
// the one before it. The pin icon opens the list of all of them.
import type { PinnedItem } from "../../../shared/api/types";
import { Icons } from "../../../shared/ui/icons";
import { LOCKED_CAPSULE_PREVIEW } from "../../state/contactModel";

export function pinnedText(p: PinnedItem): string {
	return p.text === null ? LOCKED_CAPSULE_PREVIEW : p.text.replace(/\s+/g, " ").trim();
}

/** Which of (at most) three bars is the long one. */
function activeBar(pos: number, total: number): number {
	if (total <= 3) return pos;
	if (pos === 0) return 0;
	if (pos === total - 1) return 2;
	return 1;
}

export function PinnedBar({
	pinned,
	currentId,
	onJump,
	onOpenList,
}: {
	pinned: PinnedItem[];
	currentId: number | null;
	onJump: (current: PinnedItem, next: PinnedItem) => void;
	onOpenList: () => void;
}) {
	if (pinned.length === 0) return null;
	let pos = currentId === null ? -1 : pinned.findIndex((p) => p.id === currentId);
	if (pos < 0) pos = pinned.length - 1;
	const current = pinned[pos]!;
	const bars = Math.min(pinned.length, 3);
	const active = activeBar(pos, pinned.length);
	const jump = () => onJump(current, pinned[(pos - 1 + pinned.length) % pinned.length]!);
	return (
		<div className="pinned-message-container" onClick={jump}>
			<div className="pinned-message-count" aria-hidden="true">
				{Array.from({ length: bars }, (_, i) => (
					<span key={i} className={`pinned-dot-bar${i === active ? " active" : ""}`} />
				))}
			</div>
			<div className="pinned-message">
				<span className="pinned-label">Pinned Message</span>
				<p className="pinned-message-text" dir="auto">
					{pinnedText(current)}
				</p>
			</div>
			{/* the bar is clickable as a whole; this is its keyboard way in */}
			<button
				type="button"
				className="visually-hidden"
				onClick={(e) => {
					e.stopPropagation();
					jump();
				}}
			>
				Go to pinned message: {pinnedText(current)}
			</button>
			<button
				type="button"
				className="pinned-message-icon"
				aria-label="All pinned messages"
				onClick={(e) => {
					e.stopPropagation();
					onOpenList();
				}}
			>
				<Icons.Pin />
			</button>
		</div>
	);
}
