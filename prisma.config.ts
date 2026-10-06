// Settings for the `prisma` command (Prisma 7 reads them from here, not from
// schema.prisma or package.json): where the schema and the migrations are,
// and which database `migrate`, `db seed`… work on. The server connects on
// its own (server/prisma.ts).
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// .env, the way the server reads it (Prisma no longer does it by itself). A
// DATABASE_URL already set in the environment wins: `npm run test:api` points
// `migrate deploy` at the test database like that.
dotenv.config({ quiet: true });

export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	// (not needed by `prisma generate`: that works without a database)
	datasource: {
		url: process.env.DATABASE_URL,
	},
});
