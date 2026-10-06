// One message bubble: quote, forwarded label, text with links, time and
// status, reactions, time capsule lock, and the touch gestures on it
// (hold for the menu, swipe right to reply).
import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useClickSuppressor } from "../../../shared/lib/hooks";
import type { Reaction } from "../../../shared/api/types";
import { linkify } from "../../../shared/lib/text";
import { clock, dateAtTime } from "../../../shared/lib/time";
import { Icons } from "../../../shared/ui/icons";
import { isRevealed, markRevealed } from "../../services/capsules";
import type { BubbleData } from "./bubbleData";

const LONG_PRESS_MS = 500;
const SWIPE_REPLY_PX = 100;

/**
 * Lifting the finger after a long press makes a click where the finger is —
 * by then over the menu that opened. That one click is swallowed.
 */
function swallowNextClick(): void {
	const stop = (e: Event) => {
		e.stopPropagation();
		e.preventDefault();
	};
	window.addEventListener("click", stop, { capture: true, once: true });
	window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 600);
}

export interface BubbleHandlers {
	onMenu: (data: BubbleData, el: HTMLElement) => void;
	onReply: (data: BubbleData) => void;
	onToggle: (data: BubbleData) => void;
	onQuote: (messageId: number) => void;
	onReact: (data: BubbleData, emoji: string) => void;
	onRetry: (data: BubbleData) => void;
	onDiscard: (data: BubbleData) => void;
	onCopy: (data: BubbleData) => void;
}

export interface MessageBubbleProps {
	data: BubbleData;
	meId: number | null;
	selecting: boolean;
	selected: boolean;
	/** being deleted, the Undo window is running */
	fading: boolean;
	/** removed (read one-time message, deleted elsewhere): a short fade */
	vanishing: boolean;
	highlighted: boolean;
	/** this message may be replied to with a swipe */
	canReply: boolean;
	handlers: BubbleHandlers;
	/** a copy shown elsewhere (search results): no gestures, no animations */
	passive?: boolean;
}

function MessageText({ text, style, className, plain = false }: { text: string; style?: CSSProperties; className?: string; plain?: boolean }) {
	return (
		<p className={`chat-message-text${className ? ` ${className}` : ""}`} dir="auto" style={style}>
			{linkify(text).map((part, i) =>
				part.kind === "link" && plain ? (
					<span key={i} className="message-link">
						{part.text}
					</span>
				) : part.kind === "link" ? (
					<a key={i} className="message-link" href={part.href} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()}>
						{part.text}
					</a>
				) : (
					part.text
				),
			)}
		</p>
	);
}

/** Reaction badges, colored by who reacted (rules kept from the original design). */
function Reactions({
	reactions,
	meId,
	outgoing,
	onReact,
	passive,
}: {
	reactions: Reaction[];
	meId: number | null;
	outgoing: boolean;
	onReact: (emoji: string) => void;
	/** a copy (search results): not a button */
	passive: boolean;
}) {
	if (reactions.length === 0) return null;
	const counts = new Map<string, number>();
	for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
	const emojis = [...counts.keys()];
	const multi = emojis.length > 1;
	return (
		<div className="reaction-badge-wrap">
			{emojis.slice(0, 2).map((emoji) => {
				const count = counts.get(emoji) ?? 0;
				const mine = reactions.some((r) => r.userId === meId && r.emoji === emoji);
				const others = count - (mine ? 1 : 0) > 0;
				let cls = "reaction-badge";
				if (multi) cls += ` single ${mine ? "outgoing-reaction" : "incoming-reaction"}`;
				else if (count > 1 && mine && others) cls += outgoing ? " outgoing-reaction" : " incoming-reaction";
				else {
					cls += mine ? " outgoing-reaction" : " incoming-reaction";
					if (count === 1 && reactions.length === 1) cls += " single";
				}
				if (passive) {
					return (
						<span key={emoji} className={cls}>
							<span className="reaction-badge-emoji">{emoji}</span>
							{count > 1 && <span className="reaction-badge-count">{count}</span>}
						</span>
					);
				}
				return (
					<button
						key={emoji}
						type="button"
						className={cls}
						aria-label={`${emoji} ${count}${mine ? ", including you" : ""}`}
						onClick={(e) => {
							e.stopPropagation();
							onReact(emoji);
						}}
					>
						<span className="reaction-badge-emoji">{emoji}</span>
						{count > 1 && <span className="reaction-badge-count">{count}</span>}
					</button>
				);
			})}
		</div>
	);
}

type RevealStage = "locked" | "zoom" | "fade" | "done";

/**
 * Someone else's capsule that unlocked while this device was not looking
 * is shown locked first and unlocks with an animation once it is on screen.
 */
function useCapsuleReveal(data: BubbleData, el: RefObject<HTMLDivElement | null>, passive: boolean): RevealStage {
	const id = data.id;
	const needs = !passive && !data.mine && data.isTimeCapsule && !data.isLocked && id !== null && !isRevealed(id);
	const [stage, setStage] = useState<"zoom" | "fade" | null>(null);
	useEffect(() => {
		if (!needs || id === null || !el.current) return undefined;
		const timers: number[] = [];
		const run = () => {
			timers.push(window.setTimeout(() => setStage("zoom"), 1000));
			timers.push(window.setTimeout(() => setStage("fade"), 1500));
			timers.push(
				window.setTimeout(() => {
					markRevealed(id);
					setStage(null);
				}, 1900),
			);
		};
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting) && document.visibilityState === "visible") {
					io.disconnect();
					run();
				}
			},
			{ threshold: 0.2 },
		);
		io.observe(el.current);
		return () => {
			io.disconnect();
			timers.forEach((t) => window.clearTimeout(t));
		};
	}, [needs, id, el]);
	return needs ? (stage ?? "locked") : "done";
}

export const MessageBubble = memo(function MessageBubble({
	data,
	meId,
	selecting,
	selected,
	fading,
	vanishing,
	highlighted,
	canReply,
	handlers,
	passive = false,
}: MessageBubbleProps) {
	const el = useRef<HTMLDivElement>(null);
	const [swipeX, setSwipeX] = useState(0);
	const [failedOpen, setFailedOpen] = useState(false);
	const gesture = useRef<{ id: number; x: number; y: number; swiping: boolean; timer: number | null; menuOpened: boolean } | null>(null);
	const suppressClick = useClickSuppressor();
	const reveal = useCapsuleReveal(data, el, passive);

	const lockedView = (data.isTimeCapsule && data.isLocked && !data.mine) || reveal === "locked" || reveal === "zoom" || reveal === "fade";
	const pending = data.status === "pending";
	const failed = data.status === "failed";
	const interactive = data.id !== null && !passive;

	// a failed message's panel closes when it is sent again
	useEffect(() => {
		if (!failed) setFailedOpen(false);
	}, [failed]);

	const clearTimer = () => {
		const g = gesture.current;
		if (g?.timer !== null && g?.timer !== undefined) window.clearTimeout(g.timer);
		if (g) g.timer = null;
	};

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.pointerType === "mouse" || !interactive) return;
		const target = e.currentTarget;
		gesture.current = {
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			swiping: false,
			menuOpened: false,
			timer: selecting
				? null
				: window.setTimeout(() => {
						const g = gesture.current;
						if (!g || g.swiping) return;
						g.menuOpened = true;
						g.timer = null;
						handlers.onMenu(data, target);
					}, LONG_PRESS_MS),
		};
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const g = gesture.current;
		if (!g || g.id !== e.pointerId) return;
		const dx = e.clientX - g.x;
		const dy = e.clientY - g.y;
		if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimer();
		if (g.menuOpened || selecting || !canReply) return;
		if (!g.swiping) {
			if (dx > 10 && Math.abs(dx) > Math.abs(dy)) {
				g.swiping = true;
				e.currentTarget.setPointerCapture(e.pointerId);
			} else return;
		}
		setSwipeX(Math.max(0, dx));
	};
	const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
		const g = gesture.current;
		if (!g || g.id !== e.pointerId) return;
		clearTimer();
		gesture.current = null;
		if (g.menuOpened) swallowNextClick();
		if (g.swiping) {
			// (a mouse drag ends in a click; a finger that moved causes none)
			if (e.pointerType !== "touch") suppressClick.arm();
			const dx = e.clientX - g.x;
			setSwipeX(0);
			if (dx >= SWIPE_REPLY_PX && e.type === "pointerup") handlers.onReply(data);
		}
	};

	const onClick = () => {
		if (suppressClick.consume()) return;
		if (selecting && interactive) handlers.onToggle(data);
	};

	const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		// a long press already opened it
		if (gesture.current?.menuOpened || suppressClick.consume()) return;
		if (!interactive || selecting) return;
		handlers.onMenu(data, e.currentTarget);
	};

	const progress = Math.min(swipeX / SWIPE_REPLY_PX, 1);
	const classes = [
		"chat-message",
		data.mine ? "outgoing" : "incoming",
		pending && "pending",
		failed && "failed",
		data.isOneTime && "onetime-message",
		lockedView && "capsule-locked",
		selected && "selected",
		data.reactions.length > 0 && "has-reaction",
		highlighted && (data.mine ? "highlight-outgoing-reply" : "highlight-incoming-reply"),
		fading && "fading-slow",
		vanishing && "vanishing",
	]
		.filter(Boolean)
		.join(" ");

	const style: CSSProperties = {};
	if (swipeX) style.translate = `${Math.min(swipeX * 0.4, SWIPE_REPLY_PX * 0.4)}px 0`;
	if (fading) style.opacity = 0;

	const time = clock(data.createdAt);
	const pinIcon = data.isPinned ? (
		<span className="chat-pinned-icon">
			<Icons.PinSolid />
		</span>
	) : null;
	const edited = data.isEdited ? <span className="chat-edited-label">edited</span> : null;

	return (
		<div
			ref={el}
			className={classes}
			style={style}
			data-message-id={data.id ?? undefined}
			tabIndex={interactive ? -1 : undefined}
			data-unseen={data.unseen ? "true" : undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onClick={onClick}
			onContextMenu={onContextMenu}
		>
			{data.reply && (
				<div
					className="chat-reply"
					// (from the keyboard too: it jumps to the quoted message)
					role={interactive ? "button" : undefined}
					tabIndex={interactive ? 0 : undefined}
					aria-label={interactive ? `Go to the quoted message from ${data.reply.label}` : undefined}
					onClick={(e) => {
						if (selecting) return;
						e.stopPropagation();
						if (data.reply) handlers.onQuote(data.reply.id);
					}}
					onKeyDown={(e) => {
						if (!interactive || selecting || (e.key !== "Enter" && e.key !== " ")) return;
						e.preventDefault();
						e.stopPropagation();
						if (data.reply) handlers.onQuote(data.reply.id);
					}}
				>
					<span className="chat-reply-sender">{data.reply.label}</span>
					<span className="chat-reply-text" dir="auto">
						{data.reply.text}
					</span>
				</div>
			)}
			{data.forwardedFrom && <div className="chat-forwarded-label">Forwarded from {data.forwardedFrom}</div>}
			{data.isTimeCapsule && data.mine && (
				<div className="capsule-sender-label">
					<span className="capsule-sender-icon">{data.openedAt ? <Icons.CapsuleUnlock /> : <Icons.CapsuleLock />}</span>
					<span className="capsule-sender-text">
						{data.openedAt ? "Opened" : data.scheduledFor ? `Unlocks ${dateAtTime(data.scheduledFor)}` : "Time Capsule"}
					</span>
				</div>
			)}
			{lockedView ? (
				<MessageText
					text={data.text ?? ""}
					style={reveal === "fade" ? undefined : { filter: "blur(7px)", opacity: 0.18, userSelect: "none", pointerEvents: "none" }}
					className={reveal === "fade" ? "capsule-reveal" : undefined}
				/>
			) : (
				<MessageText text={data.text ?? ""} plain={passive} />
			)}
			<span className="chat-message-meta">
				{data.mine && pinIcon}
				{data.mine && edited}
				{data.isOneTime && (
					<span className="chat-onetime-meta">
						<Icons.OneTime />
					</span>
				)}
				<span className="chat-message-time">{time}</span>
				{!data.mine && edited}
				{data.mine &&
					(pending ? (
						<span className="chat-message-status">
							<Icons.Spinner className="msg-pending-spinner" />
						</span>
					) : failed ? (
						<button
							type="button"
							className="msg-failed-btn"
							aria-label="Not sent: options"
							onClick={(e) => {
								e.stopPropagation();
								setFailedOpen((v) => !v);
							}}
						>
							<Icons.Failed />
						</button>
					) : (
						<span className="chat-message-status">{data.status === "seen" ? <Icons.Seen /> : <Icons.Sent />}</span>
					))}
				{!data.mine && pinIcon}
			</span>
			{lockedView && (
				<>
					<div className={`capsule-lines${reveal === "fade" ? " capsule-fading" : ""}`}>
						{[82, 65, 90, 50].map((w) => (
							<div key={w} className="capsule-line" style={{ width: `${w}%` }} />
						))}
					</div>
					<div className={`capsule-center${reveal === "fade" ? " capsule-fading" : ""}`}>
						<div className={`capsule-lock-icon${reveal === "zoom" || reveal === "fade" ? " capsule-zoom" : ""}`}>
							{reveal === "fade" ? <Icons.CapsuleUnlock /> : <Icons.CapsuleLock />}
						</div>
						<div className="capsule-unlock-time">{data.scheduledFor ? `Opens ${dateAtTime(data.scheduledFor)}` : ""}</div>
					</div>
				</>
			)}
			<Reactions reactions={data.reactions} meId={meId} outgoing={data.mine} passive={passive} onReact={(emoji) => handlers.onReact(data, emoji)} />
			{swipeX > 0 && (
				<div className={`swipe-reply-icon visible${progress >= 1 ? " bounce" : ""}`} style={{ opacity: progress }}>
					<Icons.ReplyArrow />
				</div>
			)}
			{failed && failedOpen && (
				<div className="msg-failed-panel" role="menu" onClick={(e) => e.stopPropagation()}>
					{data.error && <p className="msg-failed-reason">{data.error}</p>}
					<button type="button" className="retry-btn" role="menuitem" onClick={() => handlers.onRetry(data)}>
						Retry
					</button>
					<button type="button" role="menuitem" onClick={() => handlers.onCopy(data)}>
						Copy
					</button>
					<button type="button" className="delete-btn" role="menuitem" onClick={() => handlers.onDiscard(data)}>
						Delete
					</button>
				</div>
			)}
		</div>
	);
});
