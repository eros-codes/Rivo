// The database client. Prisma 7 talks to PostgreSQL through a driver
// adapter: node-postgres (pg) and its connection pool, under the client
// generated from prisma/schema.prisma (server/generated/prisma).
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.ts";
import { PrismaClient } from "./generated/prisma/client.ts";

// The rest of the server takes the database's types from here, not from the
// generated folder.
export type { Message, Prisma, User } from "./generated/prisma/client.ts";

type LogLevel = "info" | "query" | "warn" | "error";

/**
 * A client for the database at `url` (the server's own is the default export,
 * on DATABASE_URL). `log`: what Prisma itself prints (a failed query is
 * thrown to the caller either way).
 */
export function createPrismaClient(
	url: string | undefined,
	{ log = ["warn", "error"] }: { log?: LogLevel[] } = {},
) {
	// pg ignores "?schema=" in the address; Prisma 6 used it for everything.
	// Now Prisma's own queries get it from the adapter, and SQL written by
	// hand ($queryRaw…) through the connection's search_path.
	const schema = schemaOf(url);
	const adapter = new PrismaPg(
		{
			connectionString: url,
			max: config.db.poolMax,
			// pg would wait forever, to connect or for a free connection: a
			// request fails after this instead (Prisma 6: 5 s to connect, 10 s
			// for a free connection; pg has one limit for both)
			connectionTimeoutMillis: config.db.connectTimeoutMs,
			...(schema ? { options: `-c search_path=${schema}` } : {}),
		},
		{ schema },
	);
	return new PrismaClient({ adapter, log });
}

/** The "?schema=" of a database address (only a plain name: it goes into a connection option). */
function schemaOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const schema = new URL(url).searchParams.get("schema");
		return schema && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)
			? schema
			: undefined;
	} catch {
		return undefined;
	}
}

const prisma = createPrismaClient(process.env.DATABASE_URL);

export default prisma;
