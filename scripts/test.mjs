// Runs the test suites.
//   node scripts/test.mjs unit   the browser app's logic (no server, no database)   npm run test:unit
//   node scripts/test.mjs api    the server on a test database                      npm run test:api
//   node scripts/test.mjs e2e    the built app in a browser (same database)          npm run test:e2e
//   node scripts/test.mjs all    all three, in that order                           npm test
//   node scripts/test.mjs load   many people chatting at once, measured             npm run loadtest
//                                (not part of "all": it takes minutes and measures, it does not pass or fail;
//                                its options after "--": npm run loadtest -- --help)
//
// api, e2e and load need TEST_DATABASE_URL (in the environment or in .env): a
// PostgreSQL database used only for tests (its name must contain "test").
// Its migrations are brought up to date first. e2e also needs
// `npm run build` and a browser: Playwright's own (`npx playwright install
// chromium`: once, and again after an npm install that updates Playwright),
// or else a Chrome or Edge installed on the computer (see pickBrowser).
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
		const parsed = (await import("dotenv")).default.parse(readFileSync(join(ROOT, ".env")));
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
	// (without Prisma's "update available" box: a newer major version is not a test result)
	return run([bin("prisma"), "migrate", "deploy"], { ...process.env, DATABASE_URL: testDatabase(), PRISMA_HIDE_UPDATE_MESSAGE: "1" });
}

const INSTALLED = { chrome: "Google Chrome", msedge: "Microsoft Edge" };

/**
 * The browser the e2e tests run in, as a Playwright channel ("" for
 * Playwright's own Chromium), or null if there is none.
 *
 * Playwright's own Chromium is what CI uses. Each Playwright version needs its
 * own build of it, so after an npm install that updated Playwright it is
 * missing until `npx playwright install chromium`. Where that download does
 * not get through, a Chrome or Edge installed on this computer does the same
 * job (the same engine, driven the same way; Windows always has Edge).
 * E2E_CHANNEL (chrome, msedge, …) chooses one.
 */
async function pickBrowser() {
	const { chromium } = await import("@playwright/test");
	/** true, or why it did not start */
	const starts = async (channel) => {
		try {
			await (await chromium.launch(channel ? { channel } : {})).close();
			return true;
		} catch (e) {
			return String(e?.message ?? e);
		}
	};
	const asked = process.env.E2E_CHANNEL;
	if (asked) {
		const r = await starts(asked);
		if (r === true) return asked;
		console.error(`E2E_CHANNEL=${asked}: that browser does not start:\n${r}`);
		return null;
	}
	const own = await starts("");
	// (a problem other than it not being there: the tests show it)
	if (own === true || !/Executable doesn't exist/i.test(own)) return "";
	for (const channel of Object.keys(INSTALLED)) {
		if ((await starts(channel)) === true) {
			console.log(`· Playwright's own browser is not installed (npx playwright install chromium): using ${INSTALLED[channel]} from this computer`);
			return channel;
		}
	}
	console.error(
		"Playwright's browser is not installed (each Playwright version needs its own, so also after an npm install that updated Playwright), and there is no Chrome or Edge on this computer to use instead. Install it, once:\n  npx playwright install chromium",
	);
	return null;
}

const suites = {
	unit() {
		return run(["--import", "tsx", "--test", ...find(join(ROOT, "tests", "unit"), ".test.ts")]);
	},
	api() {
		testDatabase();
		const m = migrate();
		if (m !== 0) return m;
		// (TypeScript: Node runs it as it is, stripping the types)
		return run(["--test", "--test-concurrency=4", ...find(join(ROOT, "tests", "api"), ".test.ts")]);
	},
	async e2e() {
		testDatabase();
		if (!existsSync(join(ROOT, "public", "chat", "index.html"))) {
			console.error("The app is not built: run `npm run build` first.");
			return 2;
		}
		const channel = await pickBrowser();
		if (channel === null) return 2;
		const m = migrate();
		if (m !== 0) return m;
		// (the config reads E2E_CHANNEL)
		return run([bin("@playwright/test"), "test", "-c", "tests/e2e/playwright.config.ts", ...process.argv.slice(3)], { ...process.env, E2E_CHANNEL: channel });
	},
	load() {
		const args = process.argv.slice(3);
		if (!args.includes("--help") && !args.includes("-h")) {
			testDatabase();
			const m = migrate();
			if (m !== 0) return m;
		}
		// Ctrl+C reaches the load test too: it stops, reports the stages it
		// measured and stops its server. This waits for that.
		process.on("SIGINT", () => {});
		return run(["tests/load/loadtest.ts", ...args]);
	},
};

const which = process.argv[2] || "all";
const order = which === "all" ? ["unit", "api", "e2e"] : [which];
for (const name of order) {
	if (!suites[name]) {
		console.error(`unknown suite "${name}" (unit, api, e2e, all or load)`);
		process.exit(2);
	}
	console.log(`\n━━ ${name} tests ━━`);
	const code = await suites[name]();
	if (code !== 0) process.exit(code);
}
