// The site's own address and contact email, for what the build writes into
// the pages: link previews (og:image needs a full address), canonical
// addresses, the privacy page's contact. Read the way the server reads its
// settings: from the environment, else from .env.
//   APP_URL        the site's address, e.g. https://chat.example.com
//   CONTACT_EMAIL  the privacy page's contact address (else SMTP_FROM's address)
// A server at a new address needs a new build (scripts/deploy.sh does one).
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let fromFile = {};
try {
	fromFile = dotenv.parse(readFileSync(join(ROOT, ".env")));
} catch {
	/* no .env: the environment only */
}
const setting = (name) => process.env[name] || fromFile[name] || "";
/** "Rivo <me@example.com>" → "me@example.com" */
const addressOf = (from) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();

function siteUrl() {
	const raw = (setting("APP_URL") || "http://localhost:3000").replace(/\/+$/, "");
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`APP_URL is not an address: "${raw}" (e.g. https://chat.example.com)`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`APP_URL must start with https:// ("${raw}")`);
	return url.origin;
}

function contactEmail() {
	const email = setting("CONTACT_EMAIL") || addressOf(setting("SMTP_FROM")) || "privacy@rivo.ir";
	if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(email)) throw new Error(`CONTACT_EMAIL (or SMTP_FROM) is not an email address: "${email}"`);
	return email;
}

export const site = { url: siteUrl(), contactEmail: contactEmail() };
