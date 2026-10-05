// Checking what a client sent against a schema from shared/schemas, for the
// REST routes and the socket handlers alike. The first problem found is the
// answer, in the words the schema gives it; a problem without words of its
// own is "Invalid data".
import type { Response } from "express";
import type { z } from "zod";

export const INVALID = "Invalid data";

export type Checked<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * The checked (and cleaned) value, or what is wrong with it. Nothing at all
 * (a request without a body, an event without a payload) is checked as {}:
 * the answer then names the field that is missing.
 */
export function check<S extends z.ZodType>(schema: S, input: unknown): Checked<z.output<S>> {
	const r = schema.safeParse(input ?? {}, { error: () => INVALID });
	return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.issues[0]?.message || INVALID };
}

/**
 * For a route: the checked value, or undefined after answering
 * 400 { error } (the handler then just returns).
 */
export function parse<S extends z.ZodType>(res: Response, schema: S, input: unknown): z.output<S> | undefined {
	const r = check(schema, input);
	if (r.ok) return r.data;
	res.status(400).json({ error: r.error });
	return undefined;
}
