// Reading what was thrown. In TypeScript a caught value is `unknown`: it is
// usually an Error, but anything can be thrown.

/** The error's message, or undefined when what was thrown has none. */
export function messageOf(e: unknown): string | undefined {
	const m = e !== null && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
	return typeof m === "string" ? m : undefined;
}

/** The error's `code` (Prisma: "P2002" for a unique constraint, "P2025" for a missing row…). */
export function codeOf(e: unknown): unknown {
	return e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
}
