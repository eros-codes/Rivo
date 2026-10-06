// Prints a database address for the PostgreSQL tools (pg_dump, pg_restore,
// psql): the variable named on the command line (DATABASE_URL by default),
// from the environment or from .env, without the options only Prisma
// understands (the tools refuse them).
//   node scripts/db-url.mjs [VARIABLE]
const name = process.argv[2] || "DATABASE_URL";
if (!process.env[name]) {
	try {
		(await import("dotenv")).default.config({ quiet: true });
	} catch {
		/* no dotenv: the environment only */
	}
}
const raw = process.env[name];
if (!raw) {
	console.error(`${name} is not set (in the environment or in .env)`);
	process.exit(1);
}
let url;
try {
	url = new URL(raw);
} catch {
	console.error(`${name} is not a valid postgresql:// address`);
	process.exit(1);
}
const PRISMA_ONLY = ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size", "socket_timeout"];
const schema = url.searchParams.get("schema");
if (schema && schema !== "public") console.error(`note: ${name} uses the schema "${schema}"; the tools work on the whole database`);
for (const key of PRISMA_ONLY) url.searchParams.delete(key);
console.log(url.toString());
