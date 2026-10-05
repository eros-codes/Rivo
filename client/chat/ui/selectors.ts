// Hooks that read derived views of the state (lists, the open chat).
import { useMemo } from "react";
import type { ContactRow } from "../../shared/api/types";
import { shallowEqual, useStore } from "../../shared/lib/store";
import { sectionOf, sortActive, sortContacts } from "../state/contactModel";
import { contacts, outbox, session, ui } from "../state/stores";
import type { Pending } from "../state/types";

/** The newest message being sent, per chat. */
export function useNewestPending(): Record<number, Pending> {
	const box = useStore(outbox, (s) => s);
	return useMemo(() => {
		const out: Record<number, Pending> = {};
		for (const p of Object.values(box)) {
			const cur = out[p.conversationId];
			if (!cur || p.createdAt > cur.createdAt) out[p.conversationId] = p;
		}
		return out;
	}, [box]);
}

export interface ChatLists {
	active: ContactRow[];
	contacts: ContactRow[];
	archived: ContactRow[];
}

/** Active Chats, Contacts and Archived, each in display order. */
export function useChatLists(): ChatLists {
	const byConv = useStore(contacts, (s) => s.byConv);
	const openConvId = useStore(ui, (s) => s.openConvId);
	const meId = useStore(session, (s) => s.me?.id ?? null);
	const pending = useNewestPending();
	return useMemo(() => {
		const active: ContactRow[] = [];
		const list: ContactRow[] = [];
		const archived: ContactRow[] = [];
		for (const row of Object.values(byConv)) {
			const section = sectionOf(row, openConvId, meId, pending[row.conversationId]);
			if (section === "active") active.push(row);
			else if (section === "contacts") list.push(row);
			else archived.push(row);
		}
		return {
			active: sortActive(active, pending),
			contacts: sortContacts(list),
			archived: archived.sort((a, b) => b.id - a.id),
		};
	}, [byConv, openConvId, meId, pending]);
}

export function useRow(convId: number | null): ContactRow | null {
	return useStore(contacts, (s) => (convId === null ? null : (s.byConv[convId] ?? null)));
}

export function useMeId(): number | null {
	return useStore(session, (s) => s.me?.id ?? null);
}

/** Sum of unread messages in every chat (the badge on the chat's back button). */
export function useTotalUnread(): number {
	return useStore(contacts, (s) => Object.values(s.byConv).reduce((n, r) => n + (r.unreadCount || 0), 0));
}

export function useUi<T>(pick: (s: ReturnType<typeof ui.get>) => T, eq: (a: T, b: T) => boolean = Object.is): T {
	return useStore(ui, pick, eq);
}

export { shallowEqual };
