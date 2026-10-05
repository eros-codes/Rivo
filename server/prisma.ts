import { PrismaClient } from "@prisma/client";

// Configure Prisma client with explicit logging to surface slow queries
// and errors early. Datasource URL uses env DATABASE_URL as-is; if you
// need to limit connections, add `?connection_limit=10` (or similar)
// to your DATABASE_URL in environment configuration.
const prisma = new PrismaClient({
	log: ["warn", "error"],
	datasources: {
		db: {
			url: process.env.DATABASE_URL,
		},
	},
});

export default prisma;
