// What the browser tests do over and over: people with accounts, signing in,
// opening a chat, finding a message, cutting a page's connection, touching
// the screen like a finger.
import { test as playwrightTest, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";
import type { WireMessage } from "../../../shared/api.ts";
import { mails as mailsOf, type Mail } from "../../support/backend.ts";
import { newUser, ok, uniq, type Api, type TestUser } from "../../support/client.ts";

export { uniq };

// Every browser context a test opens (through context() or open()) is closed
// when it ends: nothing of one test (a signed-in page, its live connection)
// is left running into the next, and a failure's screenshots are of its own pages.
const opened = new Set<BrowserContext>();

/** Playwright's `test`, closing what the test opened. The specs use this one. */
export const test = playwrightTest.extend<{ closeContexts: void }>({
	closeContexts: [
		async ({}, use) => {
			await use();
			for (const c of opened) await c.close().catch(() => undefined);
			opened.clear();
		},
		{ auto: true },
	],
});

/**
 * A new browser context (a separate browser profile: its own cookies and storage).
 *
 * E2E_API_DELAY=<ms> makes every API answer that late, as a slower computer
 * or a real database would: a test that only passes on a fast machine (it
 * checks the server before the server could have answered) fails here too.
 */
export async function context(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
	const c = await browser.newContext(options);
	const delay = Number(process.env.E2E_API_DELAY) || 0;
	if (delay > 0) {
		await c.route(/\/api\//, async (route) => {
			await new Promise((r) => setTimeout(r, delay));
			await route.fallback();
		});
	}
	opened.add(c);
	return c;
}

/** The server the global setup started. */
export function base(): string {
	const url = process.env.E2E_BASE_URL;
	if (!url) throw new Error("E2E_BASE_URL is not set: run the browser tests with `npm run test:e2e`");
	return url;
}

/** The emails that server has "sent". */
export const mails = (): Promise<Mail[]> => mailsOf(base());

/** New accounts (signed up the real way, by email code). */
export async function people(...names: string[]): Promise<TestUser[]> {
	const out: TestUser[] = [];
	for (const name of names) out.push(await newUser(base(), name));
	return out;
}

/** `a` adds `b`; returns the chat's id. */
export async function connect(a: Api, b: TestUser): Promise<number> {
	const r = await a.post<"POST /api/contacts">("/api/contacts", { username: b.username });
	expect(r.status).toBe(201);
	return r.data.conversationId;
}

/** A message sent over the API (to set the scene). */
export async function say(api: Api, conversationId: number, text: string): Promise<WireMessage> {
	const r = await api.post<"POST /api/messages">("/api/messages", { conversationId, text, clientId: uniq("seed").padEnd(12, "x") });
	expect(r.status).toBe(201);
	return r.data;
}

/** `count` messages "msg 1" … "msg <count>", taking turns (b first), over live connections: a long chat quickly. */
export async function chatter(a: TestUser, b: TestUser, conversationId: number, count: number): Promise<void> {
	const [sa, sb] = await Promise.all([a.socket().ready, b.socket().ready]);
	try {
		for (let i = 1; i <= count; i++) {
			ok(await (i % 2 ? sb : sa).request("message:send", { conversationId, text: `msg ${i}`, clientId: uniq("chat").padEnd(12, "x") }));
		}
	} finally {
		sa.close();
		sb.close();
	}
}

export async function signIn(page: Page, username: string, password = "password123"): Promise<void> {
	await page.goto("/auth/");
	await page.fill("#login-username", username);
	await page.fill("#login-password", password);
	await page.click("button.form-submit");
	await page.waitForURL("**/chat/");
	await page.locator(".active-chat").first().waitFor();
}

export interface Opened {
	context: BrowserContext;
	page: Page;
	/** errors thrown in the page (each test checks there were none where it matters) */
	errors: string[];
}

/** A page signed in as `api`'s person, in its own browser context. */
export async function open(browser: Browser, api: TestUser, options: BrowserContextOptions = {}): Promise<Opened> {
	const ctx = await context(browser, options);
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await signIn(page, api.username);
	return { context: ctx, page, errors };
}

export async function openChat(page: Page, name: string): Promise<void> {
	await page.locator(".active-chat, #main-content .contacts-card", { hasText: name }).first().click();
	await page.locator(".chat-header").waitFor();
}

const literal = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** The (last) bubble whose own text is exactly `text` (not a quote of it). */
export function bubble(page: Page, text: string): Locator {
	return page
		.locator(".chat .chat-message")
		.filter({ has: page.locator(".chat-message-text", { hasText: literal(text) }) })
		.last();
}

/**
 * Does `jump` (whatever jumps to a message: a search result, a pin) and waits
 * until the message `text` is highlighted and on screen. The highlight lasts
 * half a second, so the wait starts before the jump and looks at every frame:
 * after a slow load, a check once a second could fall either side of it.
 */
export async function jumpsTo(page: Page, text: string, jump: () => Promise<void>): Promise<void> {
	const highlighted = page.waitForFunction(
		(t) =>
			[...document.querySelectorAll(".chat-message.highlight-incoming-reply, .chat-message.highlight-outgoing-reply")].some(
				(m) => m.querySelector(".chat-message-text")?.textContent?.trim() === t,
			),
		text,
		{ polling: "raf", timeout: 15_000 },
	);
	await jump();
	await highlighted;
	await expect(bubble(page, text)).toBeInViewport();
}

export async function send(page: Page, text: string): Promise<void> {
	await page.fill("textarea.message-input", text);
	await page.keyboard.press("Enter");
}

/** Opens a message's menu (right click) and chooses `action` ("Reply", "Edit", "Pin", …). */
export async function act(page: Page, text: string, action: string): Promise<void> {
	await bubble(page, text).click({ button: "right" });
	await page.locator(".message-menu li", { hasText: action }).click();
}

/** Settings, from the sidebar's menu (a computer). */
export async function openSettings(page: Page): Promise<void> {
	await page.hover(".settings-list");
	await page.click(".settings-section");
	await page.locator("dialog.settings-dialog[open]").waitFor();
}

/** The signed-in person as the server sees them now. */
export function me(page: Page): Promise<{ id: number; bio: string; profilePics: string[]; privacyOnline: string }> {
	return page.evaluate(() => fetch("/api/users/me").then((r) => r.json()));
}

/**
 * Lets a test cut a page's connection: its live connection (WebSocket) is
 * passed through Playwright and can be dropped and refused, and HTTP fails
 * while "offline". (Browser offline mode alone keeps WebSockets open.)
 * Call before the page loads.
 *
 * The live connection has a second way in: Socket.IO starts over plain HTTP
 * requests ("long polling", /socket.io/?transport=polling) and moves to a
 * WebSocket after. Those are refused too while the line is cut, or a page
 * with HTTP back would be connected again through them.
 */
export async function cuttable(page: Page): Promise<{ cut(): Promise<void>; httpOnly(): Promise<void>; restore(): Promise<void> }> {
	const state: { refuse: boolean; open: { close(): Promise<void> }[] } = { refuse: false, open: [] };
	await page.route(/\/socket\.io\//, (route) => (state.refuse ? route.abort("connectionrefused") : route.fallback()));
	await page.routeWebSocket(/.*/, (ws) => {
		if (state.refuse) {
			void ws.close();
			return;
		}
		const server = ws.connectToServer();
		state.open.push({
			async close() {
				await server.close().catch(() => undefined);
				await ws.close().catch(() => undefined);
			},
		});
	});
	return {
		async cut() {
			state.refuse = true;
			await page.context().setOffline(true);
			for (const link of state.open.splice(0)) await link.close();
		},
		/** the network is back, the live connection (both ways) still refused: a page can load, nothing can be sent */
		async httpOnly() {
			await page.context().setOffline(false);
		},
		async restore() {
			state.refuse = false;
			await page.context().setOffline(false);
		},
	};
}

/**
 * A finger on a phone page (touch events through the browser itself, as a
 * real screen sends them; Playwright's tap() is only a tap).
 */
export async function finger(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
		cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
	const centre = async (target: Locator) => {
		const box = await target.boundingBox();
		if (!box) throw new Error("not on screen");
		return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
	};
	return {
		/** press, wait `ms`, lift */
		async hold(target: Locator, ms = 700) {
			const { x, y } = await centre(target);
			await touch("touchStart", x, y);
			await page.waitForTimeout(ms);
			await touch("touchEnd", x, y);
		},
		/** a quick touch at a point */
		async tapAt(x: number, y: number) {
			await touch("touchStart", x, y);
			await page.waitForTimeout(50);
			await touch("touchEnd", x, y);
		},
		/** drags from `from` (a point inside the target, from its left edge) by dx, in small steps like a finger */
		async swipe(target: Locator, dx: number, { from = "left" as "left" | "right", steps = 12 } = {}) {
			const { y, box } = await centre(target);
			const x0 = from === "left" ? box.x + 30 : box.x + box.width - 60;
			await touch("touchStart", x0, y);
			for (let i = 1; i <= steps; i++) {
				await touch("touchMove", x0 + (dx * i) / steps, y);
				await page.waitForTimeout(16);
			}
			await touch("touchEnd", x0 + dx, y);
			// a finger takes a moment before the next gesture (a touch at once
			// would only stop the browser's own fling, and click nothing). Less
			// than the 600 ms in which a mouse drag's own click is ignored, so a
			// tap right after a swipe is tested too.
			await page.waitForTimeout(350);
			return { x0, y };
		},
	};
}

/** A phone (touch, small screen) for browser.newContext(). */
export const PHONE: BrowserContextOptions = {
	viewport: { width: 390, height: 844 },
	isMobile: true,
	hasTouch: true,
	deviceScaleFactor: 2,
	userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
};
