// The message box: text (growing up to seven lines), emoji, reply / edit /
// forward in progress, and the send button. Holding the send button offers
// the other ways to send: a one-time message or a time capsule.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useClickSuppressor } from "../../../shared/lib/hooks";
import type { ContactRow } from "../../../shared/api/types";
import { useStore } from "../../../shared/lib/store";
import { oneLine, textDirection } from "../../../shared/lib/text";
import { Icons } from "../../../shared/ui/icons";
import { editMessage } from "../../services/actions";
import { forwardTo, MAX_LENGTH, sendText } from "../../services/outbox";
import { stopTyping, userTyped } from "../../services/typing";
import { getComposer, patchComposer } from "../../state/composerModel";
import { displayName } from "../../state/contactModel";
import { composers, EMPTY_COMPOSER, session } from "../../state/stores";
import type { SendMode } from "../../state/types";
import { CapsulePicker } from "./CapsulePicker";
import { EmojiPicker } from "./EmojiPicker";

const MAX_LINES = 7;
const LONG_PRESS_MS = 500;

const MODE_LABEL: Record<SendMode, string> = {
	normal: "Send normally",
	"one-time": "One-time message",
	"time-capsule": "Time Capsule",
};

function ModeIcon({ mode }: { mode: SendMode }): ReactNode {
	if (mode === "one-time") return <Icons.OneTime size={18} />;
	if (mode === "time-capsule") return <Icons.CapsuleLock size={20} />;
	return <Icons.Send />;
}

/** Enter sends on computers; on touch screens it is a new line. */
const enterSends = () => window.matchMedia("(pointer: fine)").matches;

export function Composer({ row, refCallback, dark }: { row: ContactRow; refCallback: (el: HTMLDivElement | null) => void; dark: boolean }) {
	const convId = row.conversationId;
	const state = useStore(composers, (s) => s[convId] ?? EMPTY_COMPOSER);
	const { draft, action, mode } = state;
	const input = useRef<HTMLTextAreaElement>(null);
	const selection = useRef({ start: 0, end: 0 });
	const [emojiOpen, setEmojiOpen] = useState(false);
	const [popup, setPopup] = useState(false);
	const [picker, setPicker] = useState<{ slot: 1 | 2 } | null>(null);
	// [main, top, bottom]: holding send shows the other two
	const [slots, setSlots] = useState<[SendMode, SendMode, SendMode]>(["normal", "time-capsule", "one-time"]);
	const pressTimer = useRef<number | null>(null);
	const suppressClick = useClickSuppressor();
	const longPressed = useRef(false);
	const emojiArea = useRef<HTMLDivElement>(null);

	// the main slot always matches the chosen mode
	useEffect(() => {
		if (slots[0] === mode) return;
		const at = slots.indexOf(mode);
		if (at > 0) {
			const next = [...slots] as typeof slots;
			[next[0], next[at]] = [next[at]!, next[0]];
			setSlots(next);
		} else setSlots(["normal", "time-capsule", "one-time"]);
	}, [mode, slots]);

	// an edit or reply puts the cursor in the box
	useEffect(() => {
		if (!action || action.kind === "forward") return;
		const ta = input.current;
		if (!ta) return;
		ta.focus({ preventScroll: true });
		const end = ta.value.length;
		ta.setSelectionRange(end, end);
	}, [action]);

	// the box grows with its text, up to seven lines
	useLayoutEffect(() => {
		const ta = input.current;
		if (!ta) return;
		const cs = getComputedStyle(ta);
		const line = parseFloat(cs.lineHeight) || 22.4;
		const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
		const max = line * MAX_LINES + chrome;
		ta.style.height = "auto";
		const want = ta.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
		ta.style.height = `${Math.min(want, max)}px`;
		ta.style.overflowY = want > max ? "auto" : "hidden";
	}, [draft]);

	// a tap outside closes the emoji panel and the send options
	useEffect(() => {
		if (!emojiOpen && !popup) return undefined;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (emojiOpen && !emojiArea.current?.contains(t)) setEmojiOpen(false);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [emojiOpen, popup]);

	const setDraft = (value: string) => {
		patchComposer(convId, { draft: value });
		if (value.trim()) userTyped(convId);
		else stopTyping();
	};

	const cancelAction = () => {
		if (action?.kind === "edit") patchComposer(convId, { action: null, draft: "" });
		else patchComposer(convId, { action: null });
	};

	const send = () => {
		const c = getComposer(convId);
		if (c.action?.kind === "edit") {
			const target = c.action.message;
			patchComposer(convId, { action: null, draft: "" });
			void editMessage(convId, target, c.draft);
			return;
		}
		if (c.action?.kind === "forward") {
			const items = c.action.items;
			patchComposer(convId, { action: null, draft: "" });
			forwardTo(convId, items, c.draft);
			return;
		}
		if (!c.draft.trim()) return;
		const ok = sendText(convId, c.draft, {
			replyTo: c.action?.kind === "reply" ? c.action.message : null,
			isOneTime: c.mode === "one-time",
			scheduledFor: c.mode === "time-capsule" ? c.scheduledFor : null,
		});
		if (!ok) return;
		// a special way of sending is used once
		patchComposer(convId, { draft: "", action: null, mode: "normal", scheduledFor: null });
	};

	const insertEmoji = (emoji: string) => {
		const { start, end } = selection.current;
		const value = getComposer(convId).draft;
		const next = value.slice(0, start) + emoji + value.slice(end);
		if (next.length > MAX_LENGTH) return;
		setDraft(next);
		const caret = start + emoji.length;
		selection.current = { start: caret, end: caret };
		setEmojiOpen(false);
		requestAnimationFrame(() => {
			const ta = input.current;
			if (!ta) return;
			ta.focus({ preventScroll: true });
			ta.setSelectionRange(caret, caret);
		});
	};

	const chooseSlot = (slot: 1 | 2) => {
		const chosen = slots[slot];
		if (chosen === "time-capsule") {
			setPopup(false);
			setPicker({ slot });
			return;
		}
		const next = [...slots] as typeof slots;
		[next[0], next[slot]] = [next[slot], next[0]];
		setSlots(next);
		setPopup(false);
		patchComposer(convId, { mode: chosen, scheduledFor: null });
	};

	const canChooseMode = !action || action.kind === "reply";
	const showSend = !!draft.trim() || action?.kind === "forward";

	let preview: { name: string; text: string } | null = null;
	if (action?.kind === "edit") preview = { name: "Edit", text: oneLine(action.message.text ?? "") };
	else if (action?.kind === "reply") {
		const mine = action.message.senderId === session.get().me?.id || row.isSaved;
		preview = { name: `Replying to ${mine ? "You" : displayName(row)}`, text: oneLine(action.message.text ?? "") };
	} else if (action?.kind === "forward") {
		preview =
			action.items.length === 1
				? { name: `Forwarding message from ${action.fromName}`, text: oneLine(action.items[0]!.text) }
				: { name: `Forwarding from: ${action.fromName}`, text: `${action.items.length} messages` };
	}

	return (
		<div ref={refCallback} className="chat-send-message" style={popup ? { zIndex: 501 } : undefined}>
			{popup && <div className="send-mode-overlay" onClick={() => setPopup(false)} />}
			{preview && (
				<div className="message-action-preview">
					<span className="action-preview">
						<span className="action-name">{preview.name}</span>
						<span className="action-message-preview" dir="auto">
							{preview.text}
						</span>
					</span>
					<button type="button" className="cancel-edit-btn" aria-label="Cancel" onClick={cancelAction}>
						<Icons.CloseThin />
					</button>
				</div>
			)}
			<div ref={emojiArea} className="emoji-area">
				<button type="button" className="emoji-btn" aria-label="Emoji" aria-expanded={emojiOpen} onClick={() => setEmojiOpen((v) => !v)}>
					<Icons.Emoji />
				</button>
				{emojiOpen && <EmojiPicker onPick={insertEmoji} dark={dark} />}
			</div>
			<textarea
				ref={input}
				rows={1}
				placeholder="Message..."
				className={`message-input${preview ? " input-rounded-bottom" : ""}`}
				name="msg"
				aria-label="Message"
				dir={textDirection(draft)}
				maxLength={MAX_LENGTH}
				value={draft}
				enterKeyHint={enterSends() ? "send" : "enter"}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={(e) => {
					selection.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
				}}
				onSelect={(e) => {
					selection.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && enterSends()) {
						e.preventDefault();
						send();
					} else if (e.key === "Escape" && action) {
						e.preventDefault();
						cancelAction();
					}
				}}
			/>
			{showSend && (
				<button
					type="button"
					className="send-btn"
					aria-label={mode === "normal" ? "Send" : `Send as ${MODE_LABEL[mode]}`}
					// keeps the keyboard open on phones
					onMouseDown={(e) => e.preventDefault()}
					onPointerDown={(e) => {
						if (e.pointerType === "mouse" && e.button !== 0) return;
						if (!canChooseMode || popup) return;
						pressTimer.current = window.setTimeout(() => {
							pressTimer.current = null;
							longPressed.current = true;
							setPopup(true);
						}, LONG_PRESS_MS);
					}}
					onPointerUp={() => {
						if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
						pressTimer.current = null;
						// releasing a long press is not a tap on Send
						if (longPressed.current) suppressClick.arm();
						longPressed.current = false;
					}}
					onPointerLeave={() => {
						if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
						pressTimer.current = null;
					}}
					onContextMenu={(e) => {
						e.preventDefault();
						if (canChooseMode) setPopup(true);
					}}
					onClick={() => {
						if (suppressClick.consume()) return;
						if (popup) setPopup(false);
						send();
					}}
				>
					<ModeIcon mode={action && action.kind !== "reply" ? "normal" : mode} />
				</button>
			)}
			{popup && (
				<div className="send-trigger-popup" role="menu">
					{([1, 2] as const).map((slot) => (
						<div key={slot} className={`onetime-trigger${slots[slot] === "time-capsule" ? " capsule-trigger" : ""}`} onClick={() => chooseSlot(slot)}>
							<span className="onetime-trigger-label">{MODE_LABEL[slots[slot]]}</span>
							<button
								type="button"
								role="menuitem"
								className={`onetime-trigger-btn${slots[slot] === "time-capsule" ? " capsule-trigger-btn" : ""}`}
								aria-label={MODE_LABEL[slots[slot]]}
								onClick={(e) => {
									e.stopPropagation();
									chooseSlot(slot);
								}}
							>
								<ModeIcon mode={slots[slot]} />
							</button>
						</div>
					))}
				</div>
			)}
			{picker && (
				<CapsulePicker
					onCancel={() => setPicker(null)}
					onConfirm={(iso) => {
						const next = [...slots] as typeof slots;
						const prevMain = next[0];
						next[0] = "time-capsule";
						next[picker.slot] = prevMain;
						setSlots(next);
						setPicker(null);
						patchComposer(convId, { mode: "time-capsule", scheduledFor: iso });
					}}
				/>
			)}
		</div>
	);
}
