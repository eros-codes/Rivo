// Chats and their pages (/api/conversations/…).
import { z } from "zod";
import { id, nullableId, optionalId, pageSize, queryDate } from "./common.ts";

export const ConversationIdParam = z.object({ id: id("Invalid conversation id") });

/** A page of a chat: up to `limit` messages older than (before, beforeId). */
export const messagesPage = (fallback: number, max: number) =>
	z.object({
		limit: pageSize(fallback, max),
		before: queryDate("Invalid before date"),
		beforeId: optionalId("Invalid beforeId"),
	});
export type PageQuery = z.output<ReturnType<typeof messagesPage>>;

/** What changed in a chat since a moment (the cursor of an earlier answer). */
export const ChangesSince = z.object({
	since: z
		.string({ error: "Invalid since" })
		.transform((v, ctx) => {
			const d = new Date(v);
			if (Number.isNaN(d.getTime())) {
				ctx.issues.push({ code: "custom", message: "Invalid since", input: v });
				return z.NEVER;
			}
			return d;
		}),
});

/**
 * Clearing a chat: everything up to `upToId` (the newest one the person
 * saw), or all of it when it is left out. Given but empty is refused: this
 * one deletes, so a blank must not mean "everything".
 */
export const ClearChat = z.object({ upToId: nullableId("Invalid upToId") });
