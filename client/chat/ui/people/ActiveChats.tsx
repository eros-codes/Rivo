// The Active Chats list.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContactRow } from "../../../shared/api/types";
import { useStore } from "../../../shared/lib/store";
import { contacts, undoing } from "../../state/stores";
import { useMeId, useNewestPending } from "../selectors";
import { ActiveChatCard, type SwipeSide } from "./ActiveChatCard";
import { ActiveChatSkeletons } from "./Skeletons";

export function ActiveChats({ rows }: { rows: ContactRow[] }) {
	const loaded = useStore(contacts, (s) => s.loaded);
	const meId = useMeId();
	const pending = useNewestPending();
	const cleared = useStore(undoing, (s) => s.clearedChats);
	const removed = useStore(undoing, (s) => s.removedContacts);
	const [swipe, setSwipe] = useState<{ convId: number; side: SwipeSide } | null>(null);
	const section = useRef<HTMLElement>(null);

	const onSwipe = useCallback((convId: number, side: SwipeSide) => {
		setSwipe(side === "closed" ? (s) => (s?.convId === convId ? null : s) : { convId, side });
	}, []);

	// a tap anywhere else closes an opened card
	useEffect(() => {
		if (!swipe) return undefined;
		const onDown = (e: PointerEvent) => {
			const wrapper = (e.target as Element | null)?.closest?.(".active-chat-wrapper");
			// the opened card itself handles its own taps (its buttons, or closing)
			if (wrapper && wrapper.getAttribute("data-conv") === String(swipe.convId)) return;
			setSwipe(null);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [swipe]);

	return (
		<section ref={section} className="active-chats-container" aria-busy={!loaded} aria-label="Active chats">
			<h4 className="guid">Active Chats</h4>
			{!loaded ? (
				<ActiveChatSkeletons />
			) : (
				rows.map((row) => (
					<ActiveChatCard
						key={row.conversationId}
						row={row}
						pending={pending[row.conversationId]}
						meId={meId}
						swipe={swipe?.convId === row.conversationId ? swipe.side : "closed"}
						onSwipe={onSwipe}
						fading={!!cleared[row.conversationId] || !!removed[row.conversationId]}
					/>
				))
			)}
		</section>
	);
}
