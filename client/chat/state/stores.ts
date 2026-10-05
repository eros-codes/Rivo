// The chat app's state, split by how often each part changes so a typing
// indicator does not re-render the contact list and a keystroke does not
// re-render the messages.
import { createStore } from "../../shared/lib/store";
import type { ContactRow, Me } from "../../shared/api/types";
import type { ComposerAction, ConvCache, ForwardSource, InAppNotice, Pending, SendMode, Toast } from "./types";

export const session = createStore<{ me: Me | null }>({ me: null });

export const contacts = createStore<{
	/** contact rows by conversation id (one row per chat) */
	byConv: Record<number, ContactRow>;
	loaded: boolean;
	failed: boolean;
}>({ byConv: {}, loaded: false, failed: false });

/** Loaded messages by conversation id. */
export const chats = createStore<Record<number, ConvCache>>({});

/** Messages this device is sending, by clientId. */
export const outbox = createStore<Record<string, Pending>>({});

/** Who is typing: conversation id → until when (ms). */
export const typing = createStore<Record<number, number>>({});

export type ConnectionStatus = "connecting" | "online" | "offline";
export const connection = createStore<{ status: ConnectionStatus; everConnected: boolean }>({
	status: "connecting",
	everConnected: false,
});

export type Panel = "profile" | "settings" | "editProfile";
export type Dialog = "addContact" | "archived" | "forward" | "pinned" | "deleteAccount" | "devices";

export interface UiState {
	openConvId: number | null;
	/** a request to scroll to a message and highlight it */
	focus: { conversationId: number; messageId: number; seq: number } | null;
	panel: Panel | null;
	dialog: Dialog | null;
	allContactsOpen: boolean;
	search: { open: boolean; query: string };
	/** messages picked in selection mode */
	selection: { conversationId: number; ids: number[] } | null;
	/** what the forward dialog is about to forward */
	forwarding: { items: ForwardSource[]; fromName: string } | null;
	/** the long-press menu of a message */
	menu: { conversationId: number; messageId: number; x: number; y: number } | null;
}

export const ui = createStore<UiState>({
	openConvId: null,
	focus: null,
	panel: null,
	dialog: null,
	allContactsOpen: false,
	search: { open: false, query: "" },
	selection: null,
	forwarding: null,
	menu: null,
});

export interface ComposerState {
	draft: string;
	action: ComposerAction | null;
	mode: SendMode;
	/** the unlock time chosen for a time capsule (ISO) */
	scheduledFor: string | null;
}

export const EMPTY_COMPOSER: ComposerState = { draft: "", action: null, mode: "normal", scheduledFor: null };

/** The message box of each chat (drafts survive switching chats). */
export const composers = createStore<Record<number, ComposerState>>({});

/** Things hidden while their undo window runs (deleted only when it ends). */
export const undoing = createStore<{
	messages: Record<number, true>;
	clearedChats: Record<number, true>;
	removedContacts: Record<number, true>;
}>({ messages: {}, clearedChats: {}, removedContacts: {} });

export const toasts = createStore<{ current: Toast | null }>({ current: null });

export const notices = createStore<{ list: InAppNotice[] }>({ list: [] });

/** Messages fading out right before they are removed (one-time messages read, deleted elsewhere). */
export const vanishing = createStore<Record<number, true>>({});
