// Development: rebuilds the web clients on every change and restarts the
// server when its code changes.  npm run dev
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watchAll } from "./build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

await watchAll();

// nodemon's own script, run with this Node (works the same on Windows)
const nodemon = require.resolve("nodemon/bin/nodemon.js");
const server = spawn(process.execPath, [nodemon, "--watch", "server", "--watch", ".env", "--ext", "js,json", "server/index.js"], {
	cwd: ROOT,
	stdio: "inherit",
});
const stop = () => {
	server.kill("SIGINT");
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => process.exit(code ?? 0));
