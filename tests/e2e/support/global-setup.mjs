// Starts one server for the whole browser test run; the tests find it (and
// its "sent" emails) through the environment.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { closeDb, ROOT, startServer } from "../../api/support/backend.mjs";

export default async function globalSetup() {
	if (!existsSync(join(ROOT, "public", "chat", "index.html"))) {
		throw new Error("The app is not built: run `npm run build` first.");
	}
	const server = await startServer({ HTTP_RATE_MAX: "100000", SOCKET_RATE_MAX: "1000" });
	process.env.E2E_BASE_URL = server.base;
	process.env.E2E_MAIL_FILE = server.mailFile;
	return async () => {
		await server.stop();
		await closeDb();
	};
}
