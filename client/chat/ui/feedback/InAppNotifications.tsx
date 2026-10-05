// The banner at the top for a message in another chat: tap to open it,
// swipe up to dismiss. One at a time; the rest wait in line.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { prefersReducedMotion } from "../../../shared/lib/hooks";
import { useStore } from "../../../shared/lib/store";
import { Avatar } from "../../../shared/ui/Avatar";
import { dismissNotice } from "../../services/feedback";
import { openChat } from "../../services/navigation";
import { displayName, isDeletedAccount } from "../../state/contactModel";
import { notices } from "../../state/stores";
import type { InAppNotice } from "../../state/types";
import { useRow } from "../selectors";

const SHOW_MS = 3000;
const SLIDE_MS = 320;
const DISMISS_DRAG = 40;

type Phase = "enter" | "shown" | "leaving";

function Banner({ notice }: { notice: InAppNotice }) {
	const row = useRow(notice.conversationId);
	const [phase, setPhase] = useState<Phase>("enter");
	const [drag, setDrag] = useState<number | null>(null);
	const start = useRef<{ id: number; y: number; moved: boolean } | null>(null);
	const suppressClick = useRef(false);

	// slide in on the frame after it is first drawn
	useEffect(() => {
		let r2 = 0;
		const r1 = requestAnimationFrame(() => {
			r2 = requestAnimationFrame(() => setPhase("shown"));
		});
		return () => {
			cancelAnimationFrame(r1);
			cancelAnimationFrame(r2);
		};
	}, []);

	// shown for a few seconds; a newer message from the same chat restarts it
	useEffect(() => {
		if (phase !== "shown" || drag !== null) return undefined;
		const t = window.setTimeout(() => setPhase("leaving"), SHOW_MS);
		return () => window.clearTimeout(t);
	}, [phase, drag, notice.text, notice.messageId]);

	useEffect(() => {
		if (phase !== "leaving") return undefined;
		const t = window.setTimeout(() => dismissNotice(notice.id), prefersReducedMotion() ? 0 : SLIDE_MS);
		return () => window.clearTimeout(t);
	}, [phase, notice.id]);

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		start.current = { id: e.pointerId, y: e.clientY, moved: false };
		suppressClick.current = false;
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const s = start.current;
		if (!s || s.id !== e.pointerId) return;
		const dy = e.clientY - s.y;
		// a drag is not a tap
		if (Math.abs(dy) > 8) {
			s.moved = true;
			suppressClick.current = true;
		}
		// only upwards
		setDrag(Math.min(0, dy));
	};
	const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
		const s = start.current;
		if (!s || s.id !== e.pointerId) return;
		start.current = null;
		const dy = drag ?? 0;
		setDrag(null);
		if (dy < -DISMISS_DRAG) dismissNotice(notice.id);
	};

	const open = () => {
		if (suppressClick.current) {
			suppressClick.current = false;
			return;
		}
		// (this clears the chat's banners)
		openChat(notice.conversationId, { focusMessageId: notice.messageId });
	};

	const title = notice.title || (row ? displayName(row) : "");
	const classes = ["in-app-notif"];
	if (phase === "shown" || drag !== null) classes.push("show");
	if (drag !== null) classes.push("dragging");

	return (
		<div
			className={classes.join(" ")}
			style={drag !== null ? { transform: `translateY(${drag}px)` } : undefined}
			role="button"
			tabIndex={0}
			aria-label={`New message from ${title}: ${notice.text}. Open chat.`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onClick={open}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				} else if (e.key === "Escape") dismissNotice(notice.id);
			}}
		>
			<div className="notif-card">
				<Avatar name={title} picture={row?.contact?.profilePics[0]} className="notif-avatar" deleted={row ? isDeletedAccount(row) : false} />
				<div className="notif-body">
					<div className="notif-title" dir="auto">
						{title}
					</div>
					<div className="notif-text" dir="auto">
						{notice.text}
					</div>
				</div>
			</div>
		</div>
	);
}

export function InAppNotifications() {
	const current = useStore(notices, (s) => s.list[0] ?? null);
	return <div className="in-app-notif-wrap">{current && <Banner key={current.id} notice={current} />}</div>;
}
