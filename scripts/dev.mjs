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

// nodemon's own script, run with this Node (works the same on Windows). The
// command is given (--exec): left to itself nodemon runs a .ts file with
// ts-node, not with Node, which runs TypeScript itself. instrument.ts starts
// error reporting first, as `npm start` does (it does nothing without SENTRY_DSN).
const nodemon = require.resolve("nodemon/bin/nodemon.js");
const watch = ["--watch", "server", "--watch", "shared", "--watch", ".env", "--ext", "js,ts,json"];
const server = spawn(process.execPath, [nodemon, ...watch, "--exec", "node --import ./server/instrument.ts", "server/index.ts"], {
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
