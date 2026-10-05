// Building blocks for the input schemas. Every schema is checked by the
// server (nothing a client sends is trusted); the app uses their types.
//
// Messages: a field whose error the person may see says so itself
// ({ error: "…" }); everything else falls back to "Invalid data".
import { z } from "zod";
import { USERNAME_PATTERN } from "../limits.ts";

const MAX_INT = 2_147_483_647;

/**
 * A database id from outside: a whole number from 1 to 2³¹−1, given as a
 * number or as digits ("12"). Never "12abc", "1.5", "1e3" or -1: those would
 * reach the database and fail there.
 */
export function toId(v: unknown): number | null {
	if (typeof v === "number") return Number.isInteger(v) && v > 0 && v <= MAX_INT ? v : null;
	if (typeof v !== "string" || !/^\d{1,10}$/.test(v.trim())) return null;
	const n = Number(v.trim());
	return n > 0 && n <= MAX_INT ? n : null;
}

/** A required id; `error` is the answer when it is missing or not an id. */
export const id = (error: string) =>
	z.union([z.number(), z.string()], { error }).transform((v, ctx) => {
		const n = toId(v);
		if (n === null) {
			ctx.issues.push({ code: "custom", message: error, input: v });
			return z.NEVER;
		}
		return n;
	});

/** An id that may be left out: missing or null mean none (a blank "" is refused). */
export const nullableId = (error: string) =>
	id(error)
		.nullish()
		.transform((v) => v ?? null);

/** An id that may be left out, where a blank "" means none too (a quote, a page cursor). */
export const optionalId = (error: string) =>
	z
		.union([z.number(), z.string(), z.null()], { error })
		.optional()
		.transform((v, ctx) => {
			if (v === undefined || v === null || v === "") return null;
			const n = toId(v);
			if (n === null) {
				ctx.issues.push({ code: "custom", message: error, input: v });
				return z.NEVER;
			}
			return n;
		});

/** true, false, or left out (false). Anything else is refused, not read as false. */
export const flag = z
	.boolean()
	.nullish()
	.transform((v) => v === true);

/** true / false when given, undefined when left out (a change that may not be asked for). */
export const optionalFlag = (error: string) => z.boolean({ error }).optional();

/** A string that is trimmed; missing / null become "". */
export const trimmed = (error: string) =>
	z
		.string({ error })
		.nullish()
		.transform((v) => (v ?? "").trim());

/** The id a sending device gives a message, so a retry is stored once. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const clientId = z.string({ error: "Invalid clientId" }).regex(CLIENT_ID_PATTERN, { error: "Invalid clientId" }).nullish();

/** A username as typed: spaces around it and a leading @ are ignored. */
export const usernameLike = (error: string) =>
	z
		.string({ error })
		.transform((v) => v.trim().replace(/^@/, ""))
		.refine((v) => USERNAME_PATTERN.test(v), { error });

/**
 * A page size from a query string: anything that is not a whole number
 * gives `fallback`, and it is kept within 1…max (a link with a strange
 * limit still works).
 */
export const pageSize = (fallback: number, max: number) =>
	z.unknown().optional().transform((v) => Math.min(Math.max(toId(typeof v === "string" ? v : undefined) ?? fallback, 1), max));

/** An ISO date from a query string, or null when left out. */
export const queryDate = (error: string) =>
	z
		.string({ error })
		.optional()
		.transform((v, ctx) => {
			if (!v) return null;
			const d = new Date(v);
			if (Number.isNaN(d.getTime())) {
				ctx.issues.push({ code: "custom", message: error, input: v });
				return z.NEVER;
			}
			return d;
		});
