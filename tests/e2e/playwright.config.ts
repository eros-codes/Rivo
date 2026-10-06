// Browser tests: the built app (npm run build) on a real server started by
// the global setup, against the test database (TEST_DATABASE_URL).
//   npm run test:e2e
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /.*\.spec\.ts$/,
	globalSetup: "./support/global-setup.ts",
	timeout: 90_000,
	expect: { timeout: 10_000 },
	// one server and a handful of users per test: in order is simplest and stable
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "../../playwright-report" }]] : "list",
	outputDir: "../../test-results",
	use: {
		baseURL: process.env.E2E_BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		// the app's offline cache would only get in the way here
		serviceWorkers: "block",
	},
	// Playwright's own Chromium; with E2E_CHANNEL (chrome, msedge), a browser
	// installed on the computer instead. (`npm run test:e2e` sets it when
	// Playwright's own is not installed: scripts/test.mjs → pickBrowser.)
	// E2E_ALL_BROWSERS=1 adds Firefox and WebKit (Safari's engine): CI runs
	// them (npm run test:e2e -- --project=firefox --project=webkit).
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}) } },
		...(process.env.E2E_ALL_BROWSERS === "1"
			? [
					{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
					{ name: "webkit", use: { ...devices["Desktop Safari"] } },
				]
			: []),
	],
});
