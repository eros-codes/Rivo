// What a client may ask of messages, over the socket or REST (both go through
// the same schema and the same service).
import { z } from "zod";
import { BATCH_MAX, EMOJI_MAX_LENGTH, MESSAGE_MAX_LENGTH, MESSAGE_SEARCH_MAX } from "../limits.ts";
import { clientId, flag, id, nullableId, optionalId, toId, trimmed } from "./common.ts";

const INVALID = "Invalid data";

/** A message's text: trimmed, not empty, not too long. */
export const messageText = trimmed(INVALID).refine((t) => t.length > 0 && t.length <= MESSAGE_MAX_LENGTH, { error: INVALID });

/** When a time capsule opens: an ISO date or a timestamp (ms); only read for a capsule. */
const capsuleTime = z.union([z.string(), z.number()], { error: "scheduledFor invalid" }).nullish();

/** The date a capsule asks for: null when not given ("" and 0 count as not given), undefined when it is no date. */
function capsuleDate(v: string | number | null | undefined): Date | null | undefined {
	if (v === undefined || v === null || v === "" || v === 0) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * A new message, or a forward of one (`forwardOf`: the server copies that
 * message's text and author, so `text` is not needed). `replyToId` is quoted
 * by the server from the message itself.
 */
export const SendMessage = z
	.object({
		conversationId: id("Invalid conversationId"),
		forwardOf: nullableId("Invalid forwardOf"),
		text: trimmed(INVALID),
		isOneTime: flag,
		isTimeCapsule: flag,
		clientId,
		replyToId: optionalId("Invalid replyToId"),
		scheduledFor: capsuleTime,
	})
	.superRefine((m, ctx) => {
		const fail = (message: string) => ctx.addIssue({ code: "custom", message });
		if (!m.forwardOf && (!m.text || m.text.length > MESSAGE_MAX_LENGTH)) return fail(INVALID);
		if (m.isOneTime && m.isTimeCapsule) return fail(INVALID);
		if (m.forwardOf && (m.isOneTime || m.isTimeCapsule)) return fail(INVALID);
		if (m.isTimeCapsule) {
			const at = capsuleDate(m.scheduledFor);
			if (at === null) return fail("scheduledFor required");
			if (at === undefined) return fail("scheduledFor invalid");
		}
	})
	.transform((m) => ({
		...m,
		clientId: m.clientId ?? null,
		// (a date without the capsule means nothing)
		scheduledFor: m.isTimeCapsule ? (capsuleDate(m.scheduledFor) ?? null) : null,
	}));
export type SendMessageInput = z.input<typeof SendMessage>;
export type SendMessageData = z.output<typeof SendMessage>;

/** Several messages forwarded into one chat. */
export const ForwardMessages = z.object({
	conversationId: id("Invalid conversationId"),
	items: z
		.array(z.object({ forwardOf: id("Invalid forwardOf"), clientId }), { error: INVALID })
		.min(1, { error: INVALID })
		.max(BATCH_MAX, { error: INVALID }),
});
export type ForwardMessagesData = z.output<typeof ForwardMessages>;

export const EditMessage = z.object({
	messageId: id("Invalid messageId"),
	text: messageText,
});
export type EditMessageData = z.output<typeof EditMessage>;

/** One's own messages, deleted for both people (repeated ids count once). */
export const DeleteMessages = z.object({
	messageIds: z
		.array(id(INVALID), { error: INVALID })
		.min(1, { error: INVALID })
		.transform((ids) => [...new Set(ids)])
		.refine((ids) => ids.length <= BATCH_MAX, { error: INVALID }),
});
export type DeleteMessagesData = z.output<typeof DeleteMessages>;

export const MessageRef = z.object({ messageId: id("Invalid messageId") });

export const React = z.object({
	messageId: id(INVALID),
	emoji: z
		.string({ error: INVALID })
		.refine((e) => e.length > 0 && e.length <= EMOJI_MAX_LENGTH && !/\s/.test(e), { error: INVALID }),
});
export type ReactData = z.output<typeof React>;

/** Read up to `upToId` (or everything, when it is left out). */
export const MarkSeen = z.object({
	conversationId: id("Invalid conversationId"),
	upToId: nullableId(INVALID),
});
export type MarkSeenData = z.output<typeof MarkSeen>;

/** A chat the device shows / stops showing / types in. */
export const ConversationRef = z.object({ conversationId: id("Invalid conversationId") });

/** Whether the app is on screen (hidden tabs never mark messages read). */
export const Visibility = z.object({ visible: z.boolean({ error: INVALID }) });

/** Searching one's messages ("" or a single letter finds nothing). */
export const SearchMessages = z.object({
	q: z
		.unknown()
		.optional()
		.transform((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
		.refine((q) => q.length <= MESSAGE_SEARCH_MAX, { error: "Query too long" }),
});

// (the REST routes name the message in the address: /api/messages/:id)
export const MessageParam = z.object({ id: id("Invalid messageId") });

export { toId };
