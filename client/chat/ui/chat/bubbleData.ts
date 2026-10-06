// A message as one bubble shows it: server messages and messages still
// being sent look the same; labels are as the viewer should read them.
import type { LiveMessage, Reaction } from "../../../shared/api/types";
import type { Pending } from "../../state/types";

export interface BubbleData {
	key: string;
	id: number | null;
	clientId: string | null;
	mine: boolean;
	text: string | null;
	createdAt: string;
	isEdited: boolean;
	isPinned: boolean;
	isOneTime: boolean;
	isTimeCapsule: boolean;
	isLocked: boolean;
	scheduledFor: string | null;
	openedAt: string | null;
	reply: { id: number; label: string; text: string } | null;
	forwardedFrom: string | null;
	reactions: Reaction[];
	/** outgoing messages only */
	status: "sent" | "seen" | "pending" | "failed" | null;
	error: string | null;
	/** incoming and not read yet (marking read watches these) */
	unseen: boolean;
}

/**
 * A quote's label: "You" when it quotes the viewer, otherwise the other
 * person (as the viewer names them), whatever the sender stored.
 */
function replyLabel(m: LiveMessage, meId: number | null, otherName: string): string {
	if (m.replyToSenderId !== null) return m.replyToSenderId === meId ? "You" : otherName || m.replyToName || "";
	// (the quoted message is gone: the name stored with the reply)
	return m.replyToName || otherName || "";
}

/** `saved`: Saved Messages, where nobody else could see a message (no ticks). */
export function fromMessage(m: LiveMessage, meId: number | null, otherName: string, saved = false): BubbleData {
	const mine = m.senderId === meId;
	return {
		key: `m${m.id}`,
		id: m.id,
		clientId: m.clientId ?? null,
		mine,
		text: m.text,
		createdAt: m.createdAt,
		isEdited: m.isEdited,
		isPinned: m.isPinned,
		isOneTime: m.isOneTime,
		isTimeCapsule: m.isTimeCapsule,
		isLocked: m.isLocked,
		scheduledFor: m.scheduledFor,
		openedAt: m.openedAt,
		reply: m.replyToId !== null ? { id: m.replyToId, label: replyLabel(m, meId, otherName), text: m.replyToText ?? "" } : null,
		forwardedFrom: m.forwardedFrom,
		reactions: m.reactions,
		status: mine && !saved ? (m.isSeen ? "seen" : "sent") : null,
		error: null,
		unseen: !mine && !m.isSeen,
	};
}

export function fromPending(p: Pending, meId: number | null, otherName: string): BubbleData {
	return {
		key: `p${p.clientId}`,
		id: null,
		clientId: p.clientId,
		mine: true,
		text: p.text,
		createdAt: p.createdAt,
		isEdited: false,
		isPinned: false,
		isOneTime: p.isOneTime,
		isTimeCapsule: p.isTimeCapsule,
		isLocked: false,
		scheduledFor: p.scheduledFor,
		openedAt: null,
		reply: p.replyTo ? { id: p.replyTo.id, label: p.replyTo.senderId === meId ? "You" : otherName, text: p.replyTo.text } : null,
		forwardedFrom: p.forwardedFrom,
		reactions: [],
		status: p.status === "failed" ? "failed" : "pending",
		error: p.error,
		unseen: false,
	};
}
