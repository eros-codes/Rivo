// One's list of people (/api/contacts).
import { z } from "zod";
import { NICKNAME_MAX_LENGTH } from "../limits.ts";
import { id, pageSize, toId } from "./common.ts";

/** A row of the list (/api/contacts/:id). */
export const ContactParam = z.object({ id: id("Invalid contact id") });

/** A page of the list: how many, after how many. */
export const contactsPage = (fallback: number, max: number) =>
	z.object({
		limit: pageSize(fallback, max),
		skip: z.unknown().optional().transform((v) => toId(typeof v === "string" ? v : undefined) ?? 0),
	});

/** A name for someone: trimmed and cut to length; empty means none. */
const nickname = (error: string) =>
	z
		.string({ error })
		.nullable()
		.optional()
		.transform((v) => (v === undefined ? undefined : v?.trim().slice(0, NICKNAME_MAX_LENGTH) || null));

export const AddContact = z.object({
	username: z
		.string({ error: "Username is required" })
		.refine((u) => u.trim().length > 0, { error: "Username is required" }),
	name: nickname("Name must be a string"),
});
export type AddContactData = z.output<typeof AddContact>;

const bool = (key: string) => z.boolean({ error: `${key} must be a boolean` }).optional();

/** Pin, mute, block, archive, name; at least one of them. */
export const UpdateContact = z
	.object({
		isPinned: bool("isPinned"),
		pinOrder: z
			.number({ error: "pinOrder must be an integer between 0 and 9999" })
			.int({ error: "pinOrder must be an integer between 0 and 9999" })
			.min(0, { error: "pinOrder must be an integer between 0 and 9999" })
			.max(9999, { error: "pinOrder must be an integer between 0 and 9999" })
			.nullable()
			.optional(),
		isMuted: bool("isMuted"),
		isBlocked: bool("isBlocked"),
		isArchived: bool("isArchived"),
		// "" or null takes the name away
		nickname: nickname("nickname must be a string"),
	})
	.refine((c) => Object.values(c).some((v) => v !== undefined), { error: "Nothing to change" });
export type UpdateContactData = z.output<typeof UpdateContact>;
