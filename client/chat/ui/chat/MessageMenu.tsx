// The menu of a message (long press / right click): reactions above it, the
// actions below it, the rest of the chat dimmed. The message is lifted above
// the dimming, and moved up when there is no room for the menu below it.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ContactRow, LiveMessage } from "../../../shared/api/types";
import { Icons } from "../../../shared/ui/icons";
import { copyText, deleteMessages, forwardSource, react, startEdit, startReply, togglePin } from "../../services/actions";
import { closeMenu, openDialog, startSelection } from "../../services/navigation";
import { displayName, isDeletedAccount } from "../../state/contactModel";
import { ui } from "../../state/stores";

const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const BAR_GAP = 10;
const MENU_GAP = 5;
const EDGE = 8;

interface Layout {
	bar: CSSProperties;
	menu: CSSProperties;
	lift: number;
}

export function MessageMenu({ row, message, meId, scroller }: { row: ContactRow; message: LiveMessage; meId: number | null; scroller: HTMLElement | null }) {
	const bar = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const [layout, setLayout] = useState<Layout | null>(null);
	const [shown, setShown] = useState(false);
	const openedAt = useRef(Date.now());
	const convId = row.conversationId;

	const mine = message.senderId === meId;
	const sealed = message.isTimeCapsule && !message.openedAt;
	const hiddenContent = !mine && (message.isLocked || message.isOneTime);
	const cannotSend = row.isBlocked || isDeletedAccount(row);
	const canEdit = mine && !message.forwardedFrom && !message.isOneTime && !sealed;
	const canPin = !(message.isLocked && !mine);

	// position everything around the message, then show it
	useLayoutEffect(() => {
		const bubble = scroller?.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
		const barEl = bar.current;
		const menuEl = menu.current;
		if (!bubble || !menuEl) {
			closeMenu();
			return undefined;
		}
		const r = bubble.getBoundingClientRect();
		const vh = window.innerHeight;
		const vw = window.innerWidth;
		const menuH = menuEl.offsetHeight;
		const barH = barEl?.offsetHeight ?? 0;
		let lift = 0;
		let menuTop = r.bottom + MENU_GAP;
		if (vh - r.bottom < menuH + EDGE * 3) {
			lift = menuH + r.bottom - vh + EDGE * 3;
			// a very tall message: the menu covers its lower part instead
			if (r.top - lift - barH - BAR_GAP < EDGE) lift = Math.max(0, r.top - barH - BAR_GAP - EDGE);
			menuTop = Math.min(r.bottom - lift + MENU_GAP, vh - menuH - EDGE);
		}
		const side: CSSProperties = mine ? { right: Math.max(EDGE, vw - r.right), left: "auto" } : { left: Math.max(EDGE, r.left), right: "auto" };
		setLayout({
			lift,
			bar: { top: Math.max(EDGE, r.top - lift - barH - BAR_GAP), ...side },
			menu: { top: menuTop, ...side },
		});
		bubble.style.zIndex = "500";
		bubble.style.transform = lift ? `translateY(-${lift}px)` : "";
		const t = window.setTimeout(() => setShown(true), 100);
		return () => {
			window.clearTimeout(t);
			bubble.style.zIndex = "";
			bubble.style.transform = "";
		};
	}, [message.id, mine, scroller]);

	// the chat does not scroll under the menu
	useEffect(() => {
		const stop = (e: Event) => {
			if (menu.current?.contains(e.target as Node)) return;
			e.preventDefault();
		};
		document.addEventListener("wheel", stop, { passive: false, capture: true });
		document.addEventListener("touchmove", stop, { passive: false, capture: true });
		return () => {
			document.removeEventListener("wheel", stop, { capture: true });
			document.removeEventListener("touchmove", stop, { capture: true });
		};
	}, []);

	// the keyboard: the first action is focused, arrows move, Escape closes
	useEffect(() => {
		if (!shown) return undefined;
		const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
		// focus goes back where it was when the menu closes (a message, with the keyboard)
		const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		items()[0]?.focus({ preventScroll: true });
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				closeMenu();
				return;
			}
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
			const list = items();
			if (list.length === 0) return;
			e.preventDefault();
			const at = list.indexOf(document.activeElement as HTMLElement);
			const next =
				e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : e.key === "ArrowDown" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
			list[next]?.focus({ preventScroll: true });
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			const now = document.activeElement;
			if (before?.isConnected && (!now || now === document.body || menu.current?.contains(now))) before.focus({ preventScroll: true });
		};
	}, [shown]);

	const run = (fn: () => void) => () => {
		closeMenu();
		fn();
	};

	const items: { key: string; label: string; icon: ReactNode; onClick: () => void; danger?: boolean }[] = [];
	if (!hiddenContent && !cannotSend) items.push({ key: "reply", label: "Reply", icon: <Icons.Reply />, onClick: run(() => startReply(convId, message)) });
	if (!hiddenContent) {
		items.push({
			key: "forward",
			label: "Forward",
			icon: <Icons.Forward />,
			onClick: run(() => {
				ui.set((s) => ({ ...s, forwarding: { items: [forwardSource(convId, message)], fromName: mine || row.isSaved ? "You" : displayName(row) } }));
				openDialog("forward");
			}),
		});
		items.push({ key: "copy", label: "Copy", icon: <Icons.Copy />, onClick: run(() => void copyText(message.text ?? "")) });
	}
	if (canEdit) items.push({ key: "edit", label: "Edit", icon: <Icons.Edit />, onClick: run(() => startEdit(convId, message)) });
	if (canPin)
		items.push({
			key: "pin",
			label: message.isPinned ? "Unpin" : "Pin",
			icon: <span className="pin-icon">{message.isPinned ? <Icons.Unpin /> : <Icons.Pin />}</span>,
			onClick: () => void togglePin(convId, message),
		});
	items.push({ key: "select", label: "Select Message", icon: <Icons.Select />, onClick: run(() => startSelection(convId, message.id)) });
	if (mine) items.push({ key: "delete", label: "Delete Message", icon: <Icons.Delete />, onClick: run(() => deleteMessages(convId, [message.id])), danger: true });

	const hidden: CSSProperties = layout ? {} : { visibility: "hidden" };

	return (
		<>
			<div
				className="chat-overlay visible"
				onClick={() => {
					// the tap that opened it (lifting the finger) does not close it
					if (Date.now() - openedAt.current > 350) closeMenu();
				}}
			/>
			{!cannotSend && (
				<div ref={bar} className="reaction-bar" style={{ display: "flex", ...hidden, ...layout?.bar }} role="toolbar" aria-label="Reactions">
					{REACTIONS.map((emoji) => (
						<button key={emoji} type="button" className="reaction-bar-btn" aria-label={`React ${emoji}`} onClick={run(() => void react(convId, message, emoji))}>
							{emoji}
						</button>
					))}
				</div>
			)}
			<div ref={menu} className={`message-menu${shown ? " visible" : ""}`} style={{ display: "block", ...hidden, ...layout?.menu }} role="menu">
				<ul>
					{items.map((it) => (
						<li
							key={it.key}
							className={`${it.key}-message${it.danger ? " delete-message" : ""}`}
							role="menuitem"
							tabIndex={-1}
							onClick={it.onClick}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									it.onClick();
								}
							}}
						>
							{it.icon}
							<p>{it.label}</p>
						</li>
					))}
				</ul>
			</div>
		</>
	);
}
