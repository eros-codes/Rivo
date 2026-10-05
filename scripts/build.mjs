// Builds the web clients into public/:
//   public/app/…                 scripts and styles, named by content hash
//   public/chat/index.html       the chat app
//   public/auth/index.html       sign in / sign up
//   public/reset-password.html   new password from an email link
//   public/landing/…             landing page and privacy policy (pre-rendered)
//   public/404.html
//   public/service-worker.js
//
//   node scripts/build.mjs            production build
//   node scripts/build.mjs --dev      readable output
//   node scripts/build.mjs --watch    rebuild on every change (readable output)
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pages } from "./pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const OUT = join(PUBLIC, "app");

// browsers the app supports (the stylesheets need :has() and dvh units)
const TARGET = ["es2020", "chrome105", "edge105", "firefox110", "safari15.4"];

const APPS = {
	chat: "client/chat/main.tsx",
	auth: "client/auth/main.tsx",
	reset: "client/reset/main.tsx",
	landing: "client/landing/main.tsx",
};

function sharedOptions({ dev, alias }) {
	return {
		absWorkingDir: ROOT,
		bundle: true,
		minify: !dev,
		sourcemap: true,
		target: TARGET,
		jsx: "automatic",
		alias,
		legalComments: "linked",
		logLevel: "warning",
		define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
		// fonts and images are served from /assets as they are
		external: ["/assets/*"],
	};
}

function appOptions(opts) {
	return {
		...sharedOptions(opts),
		entryPoints: APPS,
		outdir: OUT,
		format: "esm",
		splitting: true,
		entryNames: "[name]-[hash]",
		chunkNames: "chunks/[name]-[hash]",
		assetNames: "assets/[name]-[hash]",
		metafile: true,
	};
}

/**
 * One full build.
 * @param {{ dev?: boolean, alias?: Record<string, string>, log?: boolean }} [opts]
 *   `alias` replaces packages (the test harness swaps in stubs).
 */
export async function buildAll({ dev = false, alias = {}, log = true } = {}) {
	const started = Date.now();
	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const apps = await esbuild.build(appOptions({ dev, alias }));
	const result = await finish(apps.metafile, { dev, alias });
	if (log) report(apps.metafile, result, started);
	return result;
}

/** Rebuilds on every change until the process ends. */
export async function watchAll({ alias = {} } = {}) {
	const opts = { dev: true, alias };
	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	let started = Date.now();
	const ctx = await esbuild.context({
		...appOptions(opts),
		plugins: [
			{
				name: "rivo-pages",
				setup(b) {
					b.onStart(() => {
						started = Date.now();
					});
					b.onEnd(async (r) => {
						if (r.errors.length || !r.metafile) return;
						try {
							const result = await finish(r.metafile, opts);
							await prune(r.metafile, result);
							report(r.metafile, result, started);
						} catch (e) {
							console.error(e?.message || e);
						}
					});
				},
			},
		],
	});
	await ctx.watch();
	console.log("watching client/ for changes…");
}

/** Everything that depends on the app bundle: boot script, pages, service worker. */
async function finish(appMeta, opts) {
	const shared = sharedOptions(opts);

	// the theme script runs before the first paint (a classic, blocking script)
	const boot = await esbuild.build({
		...shared,
		entryPoints: { boot: "client/boot/theme.ts" },
		outdir: OUT,
		format: "iife",
		entryNames: "[name]-[hash]",
		metafile: true,
	});

	const assets = collectAssets(appMeta, boot.metafile);
	const prerendered = await prerender(shared);
	const html = pages({ assets, prerendered });
	for (const [file, content] of Object.entries(html)) {
		const full = join(PUBLIC, file);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content);
	}

	// the service worker keeps the chat's files for offline starts; its
	// version changes with them, so browsers pick up every new build
	const shell = [...new Set([assets.boot, ...assets.chat.js, ...assets.chat.css])];
	const version = createHash("sha256").update(shell.join("|")).update(html["chat/index.html"]).digest("hex").slice(0, 12);
	await esbuild.build({
		...shared,
		entryPoints: ["client/sw/service-worker.ts"],
		outfile: join(PUBLIC, "service-worker.js"),
		format: "iife",
		sourcemap: false,
		define: {
			...shared.define,
			__SW_VERSION__: JSON.stringify(version),
			__SHELL_ASSETS__: JSON.stringify(shell),
		},
	});
	return { assets, version, pages: Object.keys(html), bootFiles: Object.keys(boot.metafile.outputs) };
}

/** For each app: its entry script, every script it imports up front, and its stylesheets. */
function collectAssets(appMeta, bootMeta) {
	const url = (file) => "/" + relative(PUBLIC, resolve(ROOT, file)).split("\\").join("/");
	const outputs = appMeta.outputs;
	const byEntry = {};
	for (const [file, out] of Object.entries(outputs)) {
		if (!out.entryPoint || !file.endsWith(".js")) continue;
		const name = Object.entries(APPS).find(([, src]) => src === out.entryPoint)?.[0];
		if (!name) continue;
		// static imports, transitively: preloaded so they download in parallel
		const js = [];
		const seen = new Set();
		const walk = (f) => {
			if (seen.has(f)) return;
			seen.add(f);
			js.push(url(f));
			for (const imp of outputs[f]?.imports || []) if (imp.kind === "import-statement" && !imp.external) walk(imp.path);
		};
		walk(file);
		const css = [];
		for (const f of seen) if (outputs[f]?.cssBundle) css.push(url(outputs[f].cssBundle));
		byEntry[name] = { entry: js[0], js, css };
	}
	for (const name of Object.keys(APPS)) if (!byEntry[name]) throw new Error(`no output for the ${name} app`);
	const bootFile = Object.keys(bootMeta.outputs).find((f) => f.endsWith(".js"));
	return { ...byEntry, boot: url(bootFile) };
}

/** Renders the landing and privacy pages with the same components the browser hydrates. */
async function prerender(shared) {
	const cacheDir = join(ROOT, "node_modules", ".cache", "rivo");
	await mkdir(cacheDir, { recursive: true });
	const outfile = join(cacheDir, `prerender-${process.pid}-${Date.now()}.mjs`);
	await esbuild.build({
		...shared,
		minify: false,
		sourcemap: false,
		entryPoints: ["client/landing/prerender.tsx"],
		outfile,
		platform: "node",
		format: "esm",
		target: "node18",
		// styles belong to the browser build
		loader: { ".css": "empty" },
		banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
	});
	try {
		const mod = await import(pathToFileURL(outfile).href);
		return mod.render();
	} finally {
		await rm(outfile, { force: true });
	}
}

/** Removes files of earlier watch builds (their names had other hashes). */
async function prune(appMeta, result) {
	const keep = new Set(
		[...Object.keys(appMeta.outputs), ...result.bootFiles].map((f) => resolve(ROOT, f)),
	);
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (!keep.has(full) && !keep.has(full.replace(/\.map$/, "")) && !keep.has(full.replace(/\.LEGAL\.txt$/, ""))) {
				await rm(full, { force: true });
			}
		}
	};
	await walk(OUT);
}

function report(appMeta, result, started) {
	const size = Object.entries(appMeta.outputs)
		.filter(([f]) => !f.endsWith(".map"))
		.reduce((n, [, o]) => n + o.bytes, 0);
	console.log(`built ${result.pages.length} pages and ${(size / 1024).toFixed(0)} KB of scripts and styles in ${Date.now() - started} ms`);
}

// ─── Command line ─────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		if (process.argv.includes("--watch")) await watchAll();
		else await buildAll({ dev: process.argv.includes("--dev") });
	} catch (e) {
		console.error(e?.message || e);
		process.exit(1);
	}
}
