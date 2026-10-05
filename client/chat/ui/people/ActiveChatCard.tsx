// A chat in Active Chats. Dragged sideways it reveals its actions: delete
// and archive on the left, mute and pin on the right (Saved Messages: delete).
import { memo, useLayoutEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useClickSuppressor } from "../../../shared/lib/hooks";
import type { ContactRow } from "../../../shared/api/types";
import { listTime } from "../../../shared/lib/time";
import { Avatar } from "../../../shared/ui/Avatar";
import { Icons } from "../../../shared/ui/icons";
import { deleteChat, setArchived, toggleMute, togglePinChat } from "../../services/actions";
import { openChat } from "../../services/navigation";
import { displayName, effectiveLast, isDeletedAccount, isOnline, type EffectiveLast } from "../../state/contactModel";
import type { Pending } from "../../state/types";

export type SwipeSide = "closed" | "left" | "right";

const SNAP_PX = 70;
const REVEAL_PX = 140;
const SAVED_REVEAL_PX = 70;

function offsetOf(side: SwipeSide, saved: boolean): number {
	if (side === "left") return -REVEAL_PX;
	if (side === "right") return saved ? SAVED_REVEAL_PX : REVEAL_PX;
	return 0;
}

export interface ActiveChatCardProps {
	row: ContactRow;
	/** the newest message being sent to this chat */
	pending: Pending | undefined;
	meId: number | null;
	swipe: SwipeSide;
	onSwipe: (convId: number, side: SwipeSide) => void;
	fading?: boolean;
}

function StatusIcon({ last, saved }: { last: EffectiveLast; saved: boolean }) {
	if (!last.mine) return null;
	// Saved Messages: only "still sending" or "not sent" mean anything
	if (saved && !last.pending && !last.failed) return null;
	return (
		<span className="active-chat-status">
			{last.failed ? <Icons.Failed size={16} /> : last.pending ? <Icons.Spinner size={14} className="msg-pending-spinner" /> : last.seen ? <Icons.Seen size={16} /> : <Icons.Sent size={16} />}
		</span>
	);
}

export const ActiveChatCard = memo(function ActiveChatCard({ row, pending, meId, swipe, onSwipe, fading = false }: ActiveChatCardProps) {
	const last = effectiveLast(row, pending, meId);
	const cardRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{ id: number; x: number; y: number; base: number; horizontal: boolean | null; moved: number } | null>(null);
	const suppressClick = useClickSuppressor();
	const saved = row.isSaved;
	const name = displayName(row);
	const unread = row.unreadCount;

	// the resting position follows the state (when not being dragged)
	useLayoutEffect(() => {
		const el = cardRef.current;
		if (!el || drag.current?.horizontal) return;
		el.style.transition = "transform 0.25s ease";
		el.style.transform = `translateX(${offsetOf(swipe, saved)}px)`;
	}, [swipe, saved]);

	const clamp = (v: number) => Math.max(saved ? 0 : -REVEAL_PX, Math.min(saved ? SAVED_REVEAL_PX : REVEAL_PX, v));

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, base: offsetOf(swipe, saved), horizontal: null, moved: 0 };
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		const el = cardRef.current;
		if (!d || d.id !== e.pointerId || !el) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (d.horizontal === null) {
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			d.horizontal = Math.abs(dx) > Math.abs(dy);
			if (!d.horizontal) {
				drag.current = null;
				return;
			}
			el.setPointerCapture(e.pointerId);
			el.style.transition = "none";
		}
		d.moved = dx;
		el.style.transform = `translateX(${clamp(d.base + dx)}px)`;
	};
	const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		drag.current = null;
		const el = cardRef.current;
		if (!d || d.id !== e.pointerId || !el || !d.horizontal) return;
		if (Math.abs(d.moved) > 5) suppressClick.arm();
		const total = d.base + d.moved;
		let side: SwipeSide = "closed";
		if (total < -SNAP_PX && !saved) side = "left";
		else if (total > SNAP_PX) side = "right";
		el.style.transition = "transform 0.25s ease";
		el.style.transform = `translateX(${offsetOf(side, saved)}px)`;
		onSwipe(row.conversationId, side);
	};

	const onCardClick = () => {
		if (suppressClick.consume()) return;
		// tapping an opened card closes it
		if (swipe !== "closed") {
			onSwipe(row.conversationId, "closed");
			return;
		}
		openChat(row.conversationId);
	};

	const action = (fn: () => void) => (e: MouseEvent) => {
		e.stopPropagation();
		onSwipe(row.conversationId, "closed");
		fn();
	};

	return (
		<div
			className={`active-chat-wrapper${fading ? " fading-slow" : ""}`}
			data-saved={saved ? "true" : "false"}
			data-conv={row.conversationId}
			style={fading ? { opacity: 0, pointerEvents: "none" } : undefined}
		>
			<div className="card-actions card-actions--left">
				<button type="button" className="card-action-btn card-action-btn--delete" title="Delete" tabIndex={swipe === "right" ? 0 : -1} onClick={action(() => deleteChat(row))}>
					<Icons.Delete />
				</button>
				{!saved && (
					<button type="button" className="card-action-btn card-action-btn--archive" title="Archive" tabIndex={swipe === "right" ? 0 : -1} onClick={action(() => void setArchived(row, true))}>
						<Icons.Archive />
					</button>
				)}
			</div>
			<div
				ref={cardRef}
				className={`active-chat${row.isPinned ? " pinned" : ""}`}
				role="button"
				tabIndex={0}
				aria-label={`Open chat with ${name}${unread ? `, ${unread} unread` : ""}`}
				aria-keyshortcuts="ArrowLeft ArrowRight"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={(e) => {
					if (drag.current?.horizontal) onPointerEnd(e);
					else drag.current = null;
				}}
				onClick={onCardClick}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						openChat(row.conversationId);
					} else if (e.key === "ArrowRight") {
						// the keyboard's swipe: reveals the actions (Tab reaches them)
						e.preventDefault();
						onSwipe(row.conversationId, swipe === "left" ? "closed" : "right");
					} else if (e.key === "ArrowLeft") {
						e.preventDefault();
						onSwipe(row.conversationId, swipe === "right" || saved ? "closed" : "left");
					} else if (e.key === "Escape" && swipe !== "closed") {
						onSwipe(row.conversationId, "closed");
					}
				}}
			>
				{saved ? (
					<div className="active-chat-profile active-chat-saved-icon">
						<Icons.Saved />
					</div>
				) : (
					<Avatar
						name={name}
						picture={row.contact?.profilePics[0]}
						className={`active-chat-profile${isOnline(row) ? " online" : ""}`}
						online={isOnline(row)}
						deleted={isDeletedAccount(row)}
					/>
				)}
				<span className="active-chat-info">
					<span className="active-chat-name" dir="auto">
						<span className="active-chat-name-text">{name}</span>
						{row.isPinned && (
							<span className="active-chat-pin">
								<Icons.PinSolid />
							</span>
						)}
					</span>
					<span className="active-chat-last-message">
						{last && <StatusIcon last={last} saved={saved} />}
						<span className="active-chat-last-text" dir="auto">
							{last?.text ?? ""}
						</span>
						{row.isMuted && (
							<span className="active-chat-mute">
								<Icons.Mute />
							</span>
						)}
					</span>
				</span>
				<span className="active-chat-meta">
					<span className="active-chat-message-time">{listTime(last?.at)}</span>
					<span className={`active-chat-unread-messages ${unread > 0 ? "opacity-1" : "opacity-0"}`}>
						<p>{unread > 999 ? "999+" : unread}</p>
					</span>
				</span>
			</div>
			{!saved && (
				<div className="card-actions card-actions--right">
					<button type="button" className="card-action-btn card-action-btn--mute" title={row.isMuted ? "Unmute" : "Mute"} tabIndex={swipe === "left" ? 0 : -1} onClick={action(() => toggleMute(row))}>
						{row.isMuted ? <Icons.Unmute /> : <Icons.Mute />}
					</button>
					<button type="button" className="card-action-btn card-action-btn--pin" title={row.isPinned ? "Unpin" : "Pin"} tabIndex={swipe === "left" ? 0 : -1} onClick={action(() => togglePinChat(row))}>
						{row.isPinned ? <Icons.Unpin /> : <Icons.PinSolid />}
					</button>
				</div>
			)}
		</div>
	);
});
