// Runs the test suites.
//   node scripts/test.mjs unit   the browser app's logic (no server, no database)   npm run test:unit
//   node scripts/test.mjs api    the server on a test database                      npm run test:api
//   node scripts/test.mjs e2e    the built app in a browser (same database)          npm run test:e2e
//   node scripts/test.mjs all    all three, in that order                           npm test
//
// api and e2e need TEST_DATABASE_URL (in the environment or in .env): a
// PostgreSQL database used only for tests (its name must contain "test").
// Its migrations are brought up to date first. e2e also needs
// `npm run build` and the browser (`npx playwright install chromium`, once).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

if (!process.env.TEST_DATABASE_URL) {
	try {
		// (only TEST_DATABASE_URL is used from it: the test servers get their own settings)
		const parsed = (await import("dotenv")).parse(readFileSync(join(ROOT, ".env")));
		if (parsed.TEST_DATABASE_URL) process.env.TEST_DATABASE_URL = parsed.TEST_DATABASE_URL;
	} catch {
		/* no .env (or no dotenv): the environment only */
	}
}

function find(dir, suffix) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...find(full, suffix));
		else if (entry.name.endsWith(suffix)) out.push(relative(ROOT, full));
	}
	return out.sort();
}

/** The command-line entry of an installed package (its "bin"). */
function bin(pkg) {
	const manifest = require.resolve(`${pkg}/package.json`);
	const { bin: entry } = require(manifest);
	return join(manifest, "..", typeof entry === "string" ? entry : Object.values(entry)[0]);
}

function run(args, env = process.env) {
	const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: "inherit" });
	if (r.error) throw r.error;
	return r.status ?? 1;
}

function testDatabase() {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		console.error("TEST_DATABASE_URL is not set: a PostgreSQL database used only for tests, e.g.\n  TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/rivo_test");
		process.exit(2);
	}
	const name = new URL(url).pathname.slice(1);
	if (!/test/i.test(name)) {
		console.error(`TEST_DATABASE_URL names the database "${name}". The tests write to it, so its name must contain "test".`);
		process.exit(2);
	}
	return url;
}

let migrated = false;
function migrate() {
	if (migrated) return 0;
	migrated = true;
	console.log("· bringing the test database's migrations up to date");
	return run([bin("prisma"), "migrate", "deploy"], { ...process.env, DATABASE_URL: testDatabase() });
}

const suites = {
	unit() {
		return run(["--import", "tsx", "--test", ...find(join(ROOT, "tests", "unit"), ".test.ts")]);
	},
	api() {
		testDatabase();
		const m = migrate();
		if (m !== 0) return m;
		return run(["--test", "--test-concurrency=4", ...find(join(ROOT, "tests", "api"), ".test.mjs")]);
	},
	e2e() {
		testDatabase();
		if (!existsSync(join(ROOT, "public", "chat", "index.html"))) {
			console.error("The app is not built: run `npm run build` first.");
			return 2;
		}
		const m = migrate();
		if (m !== 0) return m;
		return run([bin("@playwright/test"), "test", "-c", "tests/e2e/playwright.config.mjs", ...process.argv.slice(3)]);
	},
};

const which = process.argv[2] || "all";
const order = which === "all" ? ["unit", "api", "e2e"] : [which];
for (const name of order) {
	if (!suites[name]) {
		console.error(`unknown suite "${name}" (unit, api, e2e or all)`);
		process.exit(2);
	}
	console.log(`\n━━ ${name} tests ━━`);
	const code = suites[name]();
	if (code !== 0) process.exit(code);
}
