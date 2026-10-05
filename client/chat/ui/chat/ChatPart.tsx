// The open chat: header, pinned bar, messages and the message box (or what
// replaces it: Unblock, "account deleted", the selection toolbar). On a
// phone it slides in over the lists.
import { useCallback, useMemo, useRef, useState } from "react";
import { useIsDark, usePresence } from "../../../shared/lib/hooks";
import { useStore } from "../../../shared/lib/store";
import { Icons } from "../../../shared/ui/icons";
import { toggleBlock } from "../../services/actions";
import { focusMessage, openDialog } from "../../services/navigation";
import { isDeletedAccount } from "../../state/contactModel";
import { chats } from "../../state/stores";
import { useMeId, useRow, useUi } from "../selectors";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { MessageMenu } from "./MessageMenu";
import { PinnedBar } from "./PinnedBar";
import { PinnedViewDialog } from "./PinnedViewDialog";
import { SelectionToolbar } from "./SelectionToolbar";
import { bottomBarRef } from "../refs";

const NO_PINS: never[] = [];

function ChatView({ convId }: { convId: number }) {
	const row = useRow(convId);
	const meId = useMeId();
	const dark = useIsDark();
	const pinned = useStore(chats, (s) => s[convId]?.pinned ?? NO_PINS);
	const messages = useStore(chats, (s) => s[convId]?.messages);
	const selection = useUi((s) => (s.selection?.conversationId === convId ? s.selection.ids : null));
	const menu = useUi((s) => (s.menu?.conversationId === convId ? s.menu : null));
	const dialog = useUi((s) => s.dialog);
	const [bottomEl, setBottomElState] = useState<HTMLElement | null>(null);
	const setBottomEl = useCallback((el: HTMLElement | null) => {
		bottomBarRef.current = el;
		setBottomElState(el);
	}, []);
	const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
	const [pinnedCurrent, setPinnedCurrent] = useState<number | null>(null);
	const [showDown, setShowDown] = useState(false);
	const scrollDown = useRef<(() => void) | null>(null);
	const quietPinnedUntil = useRef(0);
	// the messages' scroll box (the message menu lifts a bubble inside it)
	const sectionRef = useCallback((el: HTMLElement | null) => setScrollerEl(el?.querySelector<HTMLElement>(".chat") ?? null), []);

	const pinnedIds = useMemo(() => pinned.map((p) => p.id), [pinned]);
	const onPinnedInView = useCallback((id: number | null) => {
		if (Date.now() < quietPinnedUntil.current) return;
		setPinnedCurrent(id);
	}, []);
	const selected = useMemo(() => {
		if (!selection || !messages) return [];
		const ids = new Set(selection);
		return messages.filter((m) => ids.has(m.id));
	}, [selection, messages]);
	const menuMessage = menu ? (messages?.find((m) => m.id === menu.messageId) ?? null) : null;

	if (!row) return null;
	const deleted = isDeletedAccount(row);
	const blocked = row.isBlocked && !deleted;

	return (
		<section className="chat-section" ref={sectionRef}>
			<ChatHeader row={row} withPinnedBar={pinned.length > 0} />
			<PinnedBar
				pinned={pinned}
				currentId={pinnedCurrent}
				onJump={(current, next) => {
					// jump to the one shown, then show the one before it
					quietPinnedUntil.current = Date.now() + 1200;
					focusMessage(convId, current.id);
					setPinnedCurrent(next.id);
				}}
				onOpenList={() => openDialog("pinned")}
			/>
			<button type="button" className={`scroll-to-bottom-btn${showDown ? " visible" : ""}`} aria-label="Scroll to the newest message" onClick={() => scrollDown.current?.()}>
				<Icons.ChevronDown />
			</button>
			{menu && menuMessage && <MessageMenu row={row} message={menuMessage} meId={meId} scroller={scrollerEl} />}
			<MessageList
				convId={convId}
				row={row}
				composer={bottomEl}
				onPinnedInView={onPinnedInView}
				pinnedIds={pinnedIds}
				scrollDownRef={scrollDown}
				onShowDownButton={setShowDown}
			/>
			{selection ? (
				<SelectionToolbar row={row} selected={selected} meId={meId} refCallback={setBottomEl} />
			) : deleted ? (
				<div ref={setBottomEl} className="chat-unavailable-notice" role="status">
					This account was deleted
				</div>
			) : blocked ? (
				<button ref={setBottomEl} type="button" className="unblock-action-btn" onClick={() => void toggleBlock(row)}>
					Unblock
				</button>
			) : (
				<Composer row={row} refCallback={setBottomEl} dark={dark} />
			)}
			{dialog === "pinned" && <PinnedViewDialog row={row} pinned={pinned} meId={meId} />}
		</section>
	);
}

export function ChatPart({ phone }: { phone: boolean }) {
	const openConvId = useUi((s) => s.openConvId);
	const { mounted, state } = usePresence(openConvId !== null, phone ? 300 : 0);
	// the chat being closed stays on screen while it slides away
	const shown = useRef<number | null>(null);
	if (openConvId !== null) shown.current = openConvId;
	const convId = openConvId ?? shown.current;
	if (!mounted || convId === null) return null;
	const anim = phone ? (state === "enter" ? " slide-in" : state === "exit" ? " slide-out" : "") : "";
	return (
		<div className={`chat-part${anim}`} id="chat-part">
			<ChatView key={convId} convId={convId} />
		</div>
	);
}
