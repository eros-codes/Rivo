// What the browser tests do over and over: people with accounts, signing in,
// opening a chat, finding a message, cutting a page's connection.
import { expect } from "@playwright/test";
import { Api, newUser, uniq } from "../../api/support/client.mjs";

export const base = () => process.env.E2E_BASE_URL;
export { uniq };

/** New accounts (signed up the real way, by email code). */
export async function people(...names) {
	const out = [];
	for (const name of names) out.push(await newUser(base(), name));
	return out;
}

/** `a` adds `b`; returns the chat's id. */
export async function connect(a, b) {
	const r = await a.post("/api/contacts", { username: b.username });
	expect(r.status).toBe(201);
	return r.data.conversationId;
}

/** A message sent over the API (to set the scene). */
export async function say(api, conversationId, text) {
	const r = await api.post("/api/messages", { conversationId, text, clientId: uniq("seed").padEnd(12, "x") });
	expect(r.status).toBe(201);
	return r.data;
}

export async function signIn(page, username, password = "password123") {
	await page.goto("/auth/");
	await page.fill("#login-username", username);
	await page.fill("#login-password", password);
	await page.click("button.form-submit");
	await page.waitForURL("**/chat/");
	await page.locator(".active-chat").first().waitFor();
}

/** A page signed in as a new person, in its own browser context. */
export async function open(browser, api, options = {}) {
	const context = await browser.newContext(options);
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await signIn(page, api.username);
	return { context, page, errors };
}

export async function openChat(page, name) {
	await page.locator(".active-chat, #main-content .contacts-card", { hasText: name }).first().click();
	await page.locator(".chat-header").waitFor();
}

/** The (last) bubble whose own text is exactly `text` (not a quote of it). */
export function bubble(page, text) {
	const exact = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
	return page.locator(".chat .chat-message").filter({ has: page.locator(".chat-message-text", { hasText: exact }) }).last();
}

export async function send(page, text) {
	await page.fill("textarea.message-input", text);
	await page.keyboard.press("Enter");
}

/**
 * Lets a test cut a page's connection: its live connection (WebSocket) is
 * passed through Playwright and can be dropped and refused, and HTTP fails
 * while "offline". (Browser offline mode alone keeps WebSockets open.)
 * Call before the page loads.
 */
export async function cuttable(page) {
	const state = { refuse: false, open: [] };
	await page.routeWebSocket(/.*/, (ws) => {
		if (state.refuse) {
			void ws.close();
			return;
		}
		const server = ws.connectToServer();
		state.open.push({ ws, server });
	});
	return {
		async cut() {
			state.refuse = true;
			await page.context().setOffline(true);
			for (const { ws, server } of state.open.splice(0)) {
				await server.close().catch(() => undefined);
				await ws.close().catch(() => undefined);
			}
		},
		async restore() {
			state.refuse = false;
			await page.context().setOffline(false);
		},
	};
}

export { Api };
