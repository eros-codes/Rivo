// The HTML pages, filled with the built asset names. Kept as plain templates:
// every page is a shell the React app mounts into (the landing pages also
// carry their pre-rendered markup, which the app hydrates).
import { site } from "./site.mjs";

const esc = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICONS = `<link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/Favicon-32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/assets/icons/Favicon-16.png" />
<link rel="apple-touch-icon" href="/assets/icons/Icon-180.png" />
<link rel="manifest" href="/manifest.webmanifest" />`;

// Poppins (regular and bold) and Vazirmatn: the app's own fonts
const FONT_PRELOAD = `<link rel="preload" href="/assets/fonts/Poppins/Poppins-Regular.ttf" as="font" type="font/ttf" crossorigin />`;

// Syne, the landing pages' heading typeface (served from here: client/landing/landing.css)
const SYNE_PRELOAD = `<link rel="preload" href="/assets/fonts/Syne/Syne-wght-latin.woff2" as="font" type="font/woff2" crossorigin />`;

function scripts(app) {
	const css = app.css.map((href) => `<link rel="stylesheet" href="${href}" />`).join("\n");
	const preload = app.js
		.slice(1)
		.map((href) => `<link rel="modulepreload" href="${href}" />`)
		.join("\n");
	return `${css}\n${preload}\n<script type="module" src="${app.entry}"></script>`.replace(/\n+/g, "\n");
}

function shell({ title, description = "", viewport, head = "", body, bodyClass = "", assets, app, boot = true, robots = "noindex" }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="${viewport}" />
<meta name="theme-color" content="#f7f0f0" />
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}" />\n` : ""}<meta name="robots" content="${robots}" />
${ICONS}
${boot ? `<script src="${assets.boot}"></script>\n` : ""}${head}
${app ? scripts(app) : ""}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
${body}
</body>
</html>
`;
}

const APP_VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content";
const PAGE_VIEWPORT = "width=device-width, initial-scale=1";
const NOSCRIPT = `<noscript><p class="noscript">Rivo needs JavaScript. Please turn it on and reload the page.</p></noscript>`;

const LANDING_TITLE = "Rivo — Conversations, Uninterrupted";
const LANDING_DESCRIPTION = "A fast, warm messaging app that works in your browser — real-time, private and ad-free. Install Rivo on your device.";

// (link previews need full addresses: the site's own, from APP_URL)
const ICON_URL = `${site.url}/assets/icons/Icon-1028.png`;

function landingHead(url) {
	const ld = JSON.stringify({
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "Rivo",
		url: `${site.url}/`,
		image: ICON_URL,
		description: "A messaging app designed with intention — fast, warm, and genuinely different.",
		applicationCategory: "CommunicationApplication",
		operatingSystem: "Web",
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
	}).replace(/</g, "\\u003c");
	return `<link rel="canonical" href="${esc(url)}" />
<meta property="og:title" content="${esc(LANDING_TITLE)}" />
<meta property="og:description" content="${esc(LANDING_DESCRIPTION)}" />
<meta property="og:image" content="${esc(ICON_URL)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Rivo" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(LANDING_TITLE)}" />
<meta name="twitter:description" content="${esc(LANDING_DESCRIPTION)}" />
<meta name="twitter:image" content="${esc(ICON_URL)}" />
<script type="application/ld+json">${ld}</script>
${SYNE_PRELOAD}`;
}

const NOT_FOUND_STYLE = `<style>
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--background-color, #f7f0f0); color: var(--text-main-color, #000); font-family: Poppins, Vazirmatn, system-ui, sans-serif; }
.nf { text-align: center; padding: 2rem; }
.nf h1 { font-size: 4rem; margin: 0; color: #fa5f1a; letter-spacing: .1em; }
.nf p { margin: .5rem 0 1.5rem; color: #777; font-size: 1rem; }
.nf a { display: inline-block; padding: .7rem 1.6rem; border-radius: 2rem; background: #fa5f1a; color: #fff; text-decoration: none; font-weight: 600; font-size: 1rem; }
html.dark-mode body { background: #1a1a1a; color: #f0f0f0; }
</style>`;

/** @returns {Record<string, string>} path under public/ → HTML */
export function pages({ assets, prerendered }) {
	return {
		"chat/index.html": shell({
			title: "Rivo",
			viewport: APP_VIEWPORT,
			head: `<meta name="mobile-web-app-capable" content="yes" />\n<meta name="apple-mobile-web-app-capable" content="yes" />\n${FONT_PRELOAD}`,
			body: `<div id="root" class="root"></div>\n${NOSCRIPT}`,
			assets,
			app: assets.chat,
		}),
		"auth/index.html": shell({
			title: "Sign in — Rivo",
			description: "Sign in to Rivo or create an account.",
			viewport: PAGE_VIEWPORT,
			head: FONT_PRELOAD,
			body: `<div id="root" class="root"></div>\n${NOSCRIPT}`,
			assets,
			app: assets.auth,
			robots: "index,follow",
		}),
		"reset-password.html": shell({
			title: "Reset password — Rivo",
			viewport: PAGE_VIEWPORT,
			head: `<meta name="referrer" content="no-referrer" />\n${FONT_PRELOAD}`,
			body: `<div id="root" class="root"></div>\n${NOSCRIPT}`,
			assets,
			app: assets.reset,
		}),
		"landing/index.html": shell({
			title: LANDING_TITLE,
			description: LANDING_DESCRIPTION,
			viewport: PAGE_VIEWPORT,
			head: landingHead(`${site.url}/`),
			body: `<div id="root" data-page="landing">${prerendered.landing}</div>`,
			assets,
			app: assets.landing,
			boot: false,
			robots: "index,follow",
		}),
		"landing/privacy.html": shell({
			title: "Privacy Policy — Rivo",
			description: "What Rivo stores, why, and what it never does with your data.",
			viewport: PAGE_VIEWPORT,
			head: `<link rel="canonical" href="${esc(site.url)}/landing/privacy.html" />\n${SYNE_PRELOAD}`,
			body: `<div id="root" data-page="privacy">${prerendered.privacy}</div>`,
			assets,
			app: assets.landing,
			boot: false,
			robots: "index,follow",
		}),
		"404.html": shell({
			title: "Page not found — Rivo",
			viewport: PAGE_VIEWPORT,
			head: NOT_FOUND_STYLE,
			body: `<main class="nf"><h1>404</h1><p>This page doesn’t exist.</p><a href="/">Back to Rivo</a></main>`,
			assets,
			app: null,
		}),
	};
}
