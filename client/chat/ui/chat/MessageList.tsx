// The messages of the open chat: day labels, the "Unread messages" line,
// loading older pages at the top, staying at the bottom when new messages
// arrive, jumping to a message, and marking what was seen as read.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ContactRow, LiveMessage } from "../../../shared/api/types";
import { useEvent, usePageVisible } from "../../../shared/lib/hooks";
import { useStore } from "../../../shared/lib/store";
import { dayKey, dayLabel } from "../../../shared/lib/time";
import { Icons } from "../../../shared/ui/icons";
import { copyText, react, startReply } from "../../services/actions";
import { showToast } from "../../services/feedback";
import { openMenu, toggleSelected } from "../../services/navigation";
import { discard, retry, sendText } from "../../services/outbox";
import { sawMessage } from "../../services/seen";
import { loadOlder, loadUntil, prepareChat } from "../../services/sync";
import { getComposer } from "../../state/composerModel";
import { displayName, isDeletedAccount } from "../../state/contactModel";
import { chats, connection, outbox, ui, undoing, vanishing } from "../../state/stores";
import { useMeId, useUi } from "../selectors";
import { MessageSkeletons, TopMessageSkeleton } from "../people/Skeletons";
import { fromMessage, fromPending, type BubbleData } from "./bubbleData";
import { MessageBubble, type BubbleHandlers } from "./MessageBubble";

type Item = { kind: "day"; key: string; label: string } | { kind: "unread"; key: string } | { kind: "msg"; key: string; data: BubbleData };

const NEAR_BOTTOM_PX = 80;
const SHOW_DOWN_BUTTON_PX = 300;

export interface MessageListProps {
	convId: number;
	row: ContactRow;
	/** the message box (or what replaces it): its height is kept free at the bottom */
	composer: HTMLElement | null;
	/** the newest pinned message on screen changed */
	onPinnedInView: (messageId: number | null) => void;
	pinnedIds: number[];
	/** used by the "scroll to the bottom" button */
	scrollDownRef: RefObject<(() => void) | null>;
	onShowDownButton: (show: boolean) => void;
}

export function MessageList({ convId, row, composer, onPinnedInView, pinnedIds, scrollDownRef, onShowDownButton }: MessageListProps) {
	const cache = useStore(chats, (s) => s[convId] ?? null);
	const box = useStore(outbox, (s) => s);
	const hidden = useStore(undoing, (s) => s.messages);
	const clearing = useStore(undoing, (s) => !!s.clearedChats[convId]);
	const fadingOut = useStore(vanishing, (s) => s);
	const selection = useUi((s) => (s.selection?.conversationId === convId ? s.selection.ids : null));
	const focus = useUi((s) => (s.focus?.conversationId === convId ? s.focus : null));
	const connected = useStore(connection, (s) => s.status === "online");
	const pageVisible = usePageVisible();
	const meId = useMeId();
	const otherName = row.isSaved ? "" : displayName(row);

	const ready = cache?.status === "ready";
	const messages = cache?.messages;
	const pending = useMemo(
		() =>
			Object.values(box)
				.filter((p) => p.conversationId === convId)
				.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
		[box, convId],
	);

	// ─── Where "Unread messages" goes (fixed for this visit) ─────────────
	const [anchorId, setAnchorId] = useState<number | null | undefined>(undefined);
	// decided while rendering (before the first paint of the messages)
	if (ready && messages && anchorId === undefined) setAnchorId(messages.find((m) => m.senderId !== meId && !m.isSeen)?.id ?? null);
	// older pages can hold earlier unread messages: the line moves up to them (never down)
	if (ready && messages && typeof anchorId === "number" && messages[0] && messages[0].id < anchorId) {
		const first = messages.find((m) => m.senderId !== meId && !m.isSeen);
		if (first && first.id < anchorId) setAnchorId(first.id);
	}
	// a message arriving while the app is in the background starts the unread part
	useEffect(() => {
		if (anchorId !== null || pageVisible || !messages) return;
		const first = messages.find((m) => m.senderId !== meId && !m.isSeen);
		if (first) setAnchorId(first.id);
	}, [anchorId, pageVisible, messages, meId]);

	// ─── What is shown ───────────────────────────────────────────────────
	// a message that did not change keeps the same bubble data, so its bubble is not drawn again
	const bubbleCache = useRef(new WeakMap<LiveMessage, { sig: string; data: BubbleData }>());
	const items = useMemo<Item[]>(() => {
		const out: Item[] = [];
		const sig = `${meId}|${otherName}|${row.isSaved}`;
		const bubbleOf = (m: LiveMessage): BubbleData => {
			const hit = bubbleCache.current.get(m);
			if (hit && hit.sig === sig) return hit.data;
			const data = fromMessage(m, meId, otherName, row.isSaved);
			bubbleCache.current.set(m, { sig, data });
			return data;
		};
		if (!messages || clearing) return out;
		let lastDay = "";
		const push = (data: BubbleData) => {
			const day = dayKey(data.createdAt);
			if (day !== lastDay) {
				out.push({ kind: "day", key: `d${day}`, label: dayLabel(day) });
				lastDay = day;
			}
			if (data.id !== null && data.id === anchorId) out.push({ kind: "unread", key: "unread" });
			out.push({ kind: "msg", key: data.key, data });
		};
		for (const m of messages) push(bubbleOf(m));
		for (const p of pending) push(fromPending(p, meId, otherName));
		return out;
	}, [messages, pending, meId, otherName, anchorId, clearing, row.isSaved]);

	const byId = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);
	const lastKey = items.length ? items[items.length - 1]!.key : null;
	const lastMine = (() => {
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i]!;
			if (it.kind === "msg") return it.data.mine;
		}
		return false;
	})();

	// ─── Scrolling ───────────────────────────────────────────────────────
	const scroller = useRef<HTMLDivElement>(null);
	const positioned = useRef(false);
	const positionedAt = useRef(0);
	const snap = useRef({ firstId: null as number | null, firstTop: null as number | null, lastKey: null as string | null, top: 0, atBottom: true });
	const [showDown, setShowDown] = useState(false);

	/** Where a message starts in the list's content (null when it is not there). */
	const contentTop = (el: HTMLElement, id: number | null): number | null => {
		if (id === null) return null;
		const node = el.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
		return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : null;
	};

	const measure = () => {
		const el = scroller.current;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		// the first message on the list (the oldest loaded one that is shown)
		const first = el.querySelector<HTMLElement>(".chat-message[data-message-id]");
		const firstId = first ? Number(first.dataset.messageId) : null;
		snap.current = {
			firstId,
			firstTop: contentTop(el, firstId),
			lastKey,
			top: el.scrollTop,
			atBottom: fromBottom < NEAR_BOTTOM_PX,
		};
		const down = fromBottom > SHOW_DOWN_BUTTON_PX;
		setShowDown((v) => (v === down ? v : down));
	};

	const toBottom = (smooth = false) => {
		const el = scroller.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
	};

	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || !ready) return;
		if (!positioned.current) {
			if (anchorId === undefined) return;
			// opening: at the first unread message when there is more than a screen of them, else at the bottom
			const sep = el.querySelector<HTMLElement>(".unread-separator");
			if (sep) {
				// where the very first message would be (clear of the header that overlaps the list's top)
				const inset = parseFloat(getComputedStyle(el).paddingTop) || 0;
				const top = sep.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - inset;
				el.scrollTop = Math.min(top, el.scrollHeight - el.clientHeight);
			} else {
				el.scrollTop = el.scrollHeight;
			}
			positioned.current = true;
			positionedAt.current = Date.now();
		} else {
			const prev = snap.current;
			if (prev.lastKey !== lastKey && lastMine) {
				// the user's own new message
				el.scrollTop = el.scrollHeight;
			} else if (prev.atBottom) {
				el.scrollTop = el.scrollHeight;
			} else {
				// something was added or removed above (older messages, the
				// "loading" placeholder): what is on screen stays where it is
				const now = contentTop(el, prev.firstId);
				if (now !== null && prev.firstTop !== null && now !== prev.firstTop) el.scrollTop = prev.top + (now - prev.firstTop);
			}
		}
		measure();
	});

	useEffect(() => {
		scrollDownRef.current = () => toBottom(true);
		return () => {
			scrollDownRef.current = null;
		};
	});
	useEffect(() => onShowDownButton(showDown), [showDown, onShowDownButton]);

	// the message box grows and shrinks: the space under the messages follows it
	const measureLatest = useEvent(measure);
	useLayoutEffect(() => {
		const box = composer;
		const el = scroller.current;
		if (!box || !el) return undefined;
		const apply = () => {
			const atBottom = snap.current.atBottom;
			// the box sits 0.5rem above the edge, with as much again above it
			const gap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.5;
			el.style.paddingBottom = `${box.offsetHeight + gap * 2}px`;
			if (atBottom) el.scrollTop = el.scrollHeight;
			measureLatest();
		};
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(box);
		return () => ro.disconnect();
	}, [composer, ready, measureLatest]);

	const sayHello = () => {
		// a draft in the box is not replaced
		if (blocked || selecting || getComposer(convId).draft.trim()) return;
		sendText(convId, "hi");
	};

	const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const list = scroller.current;
		if (!list) return;
		const all = [...list.querySelectorAll<HTMLElement>(".chat-message[data-message-id]")];
		if (all.length === 0) return;
		const current = (e.target as HTMLElement).closest<HTMLElement>(".chat-message[data-message-id]");
		const at = current ? all.indexOf(current) : -1;
		let next: HTMLElement | undefined;
		if (e.key === "ArrowUp") next = at < 0 ? all[all.length - 1] : all[at - 1];
		else if (e.key === "ArrowDown") next = at < 0 ? all[all.length - 1] : all[at + 1];
		else if (e.key === "Home") next = all[0];
		else if (e.key === "End") next = all[all.length - 1];
		// Enter on a link, a reaction or the quote inside a message does what
		// that element does; on the message itself it opens its menu
		else if (current && ((e.key === "Enter" && e.target === current) || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
			e.preventDefault();
			// the same as a right click on it
			current.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			return;
		} else if (current && e.key === " " && selecting && e.target === current) {
			e.preventDefault();
			current.click();
			return;
		} else return;
		e.preventDefault();
		if (!next) return;
		next.focus({ preventScroll: true });
		next.scrollIntoView({ block: "nearest" });
	};

	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		measure();
		// older messages when near the top (not right after opening)
		if (positioned.current && Date.now() - positionedAt.current > 400 && el.scrollTop < Math.min(200, el.scrollHeight * 0.15)) {
			void loadOlder(convId);
		}
		reportPinned();
	};

	// ─── The pinned bar follows the newest pinned message on screen ──────
	const reportPinned = useEvent(() => {
		const el = scroller.current;
		if (!el || pinnedIds.length === 0) return;
		const box = el.getBoundingClientRect();
		for (let i = pinnedIds.length - 1; i >= 0; i--) {
			const node = el.querySelector(`[data-message-id="${pinnedIds[i]}"]`);
			if (!node) continue;
			const r = node.getBoundingClientRect();
			if (r.bottom >= box.top && r.top <= box.bottom) {
				onPinnedInView(pinnedIds[i]!);
				return;
			}
		}
	});

	// ─── Marking read what is on screen ──────────────────────────────────
	const markVisible = useEvent(() => {
		const el = scroller.current;
		if (!el || document.visibilityState !== "visible") return;
		const box = el.getBoundingClientRect();
		let newest = 0;
		el.querySelectorAll<HTMLElement>('[data-unseen="true"]').forEach((node) => {
			const r = node.getBoundingClientRect();
			// at least partly on screen, above the message box
			if (r.bottom > box.top + 4 && r.top < box.bottom - (composer?.offsetHeight ?? 0)) {
				const id = Number(node.dataset.messageId);
				if (id > newest) newest = id;
			}
		});
		if (newest) sawMessage(convId, newest);
	});

	useEffect(() => {
		const el = scroller.current;
		if (!el || !ready) return undefined;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) markVisible();
			},
			{ root: el, threshold: 0.6 },
		);
		el.querySelectorAll('[data-unseen="true"]').forEach((n) => io.observe(n));
		return () => io.disconnect();
	}, [items, ready, markVisible]);

	// back to the app, back online, or done positioning: look again
	useEffect(() => {
		if (pageVisible && connected && ready) {
			const t = window.setTimeout(markVisible, 400);
			return () => window.clearTimeout(t);
		}
		return undefined;
	}, [pageVisible, connected, ready, markVisible]);

	// ─── Jumping to a message ────────────────────────────────────────────
	const [highlighted, setHighlighted] = useState<number | null>(null);
	const byIdRef = useRef(byId);
	byIdRef.current = byId;
	useEffect(() => {
		if (!focus || !ready) return undefined;
		let alive = true;
		void (async () => {
			const found = byIdRef.current.get(focus.messageId) ?? (await loadUntil(convId, focus.messageId));
			if (!alive) return;
			if (!found) {
				showToast("This message is no longer available");
				return;
			}
			// rendered on the next frame (it may have just been loaded)
			requestAnimationFrame(() => {
				const node = scroller.current?.querySelector(`[data-message-id="${focus.messageId}"]`);
				if (!node) return;
				node.scrollIntoView({ block: "center", behavior: "smooth" });
				setHighlighted(focus.messageId);
				window.setTimeout(() => setHighlighted((h) => (h === focus.messageId ? null : h)), 500);
			});
		})();
		return () => {
			alive = false;
		};
		// a new request (seq) starts a jump; the request itself is read above
	}, [focus?.seq, ready, convId]);

	// ─── What a tap on a bubble does ─────────────────────────────────────
	const handlers = useMemo<BubbleHandlers>(() => {
		// read at the time of the tap, so the handlers (and the bubbles) stay the same
		const live = (data: BubbleData): LiveMessage | null => (data.id !== null ? (byIdRef.current.get(data.id) ?? null) : null);
		return {
			onMenu: (data, el) => {
				if (data.id === null) return;
				const r = el.getBoundingClientRect();
				openMenu(convId, data.id, r.left, r.top);
			},
			onReply: (data) => {
				const m = live(data);
				if (m) startReply(convId, m);
			},
			onToggle: (data) => {
				if (data.id !== null) toggleSelected(data.id);
			},
			onQuote: (id) => {
				ui.set((s) => ({ ...s, focus: { conversationId: convId, messageId: id, seq: Date.now() } }));
			},
			onReact: (data, emoji) => {
				const m = live(data);
				if (m) void react(convId, m, emoji);
			},
			onRetry: (data) => data.clientId && retry(data.clientId),
			onDiscard: (data) => data.clientId && discard(data.clientId),
			onCopy: (data) => data.text && void copyText(data.text),
		};
	}, [convId]);

	const selecting = selection !== null;
	const blocked = row.isBlocked || isDeletedAccount(row);

	// ─── Rendering ───────────────────────────────────────────────────────
	const empty = ready && items.length === 0;
	return (
		<div
			ref={scroller}
			className={`chat${selecting ? " selection-mode" : ""}`}
			onScroll={onScroll}
			role="log"
			aria-label="Messages"
			// the keyboard: Tab reaches the list, arrows move between messages,
			// Enter (or the menu key) opens a message's menu
			tabIndex={0}
			aria-keyshortcuts="ArrowUp ArrowDown Enter"
			onKeyDown={onListKey}
		>
			{cache?.loadingOlder && <TopMessageSkeleton />}
			{!ready && cache?.status !== "error" && <MessageSkeletons />}
			{cache?.status === "error" && cache.messages.length === 0 && (
				<button type="button" className="chat-empty chat-load-error" onClick={() => void prepareChat(convId).catch(() => undefined)}>
					<Icons.ChatBubble />
					<span className="chat-empty-text">Couldn&apos;t load the messages. Tap to try again.</span>
				</button>
			)}
			{items.map((it) =>
				it.kind === "day" ? (
					<div key={it.key} className="date-separator">
						<span>{it.label}</span>
					</div>
				) : it.kind === "unread" ? (
					<div key={it.key} className="unread-separator" role="separator" aria-label="Unread messages">
						<span>Unread messages</span>
					</div>
				) : (
					<MessageBubble
						key={it.key}
						data={it.data}
						meId={meId}
						selecting={selecting}
						selected={!!(selection && it.data.id !== null && selection.includes(it.data.id))}
						fading={it.data.id !== null && !!hidden[it.data.id]}
						vanishing={it.data.id !== null && !!fadingOut[it.data.id]}
						highlighted={highlighted !== null && it.data.id === highlighted}
						canReply={!selecting && !blocked && it.data.id !== null && !(!it.data.mine && (it.data.isLocked || it.data.isOneTime))}
						handlers={handlers}
					/>
				),
			)}
			{empty && (
				<div
					className="chat-empty"
					role="button"
					tabIndex={0}
					onClick={sayHello}
					onKeyDown={(e) => {
						if (e.key !== "Enter" && e.key !== " ") return;
						e.preventDefault();
						e.stopPropagation();
						sayHello();
					}}
				>
					<Icons.ChatBubble />
					<p className="chat-empty-text">Say hello!</p>
				</div>
			)}
		</div>
	);
}
