// Two people chatting: what each sees, live, and what survives a lost
// connection, a reload, or sending faster than the server allows.
import { expect } from "@playwright/test";
import { startServer } from "../support/backend.ts";
import { newUser } from "../support/client.ts";
import { act, bubble, chatter, connect, context, cuttable, open, openChat, people, say, send, signIn, test } from "./support/app.ts";

test("two people chat live: send, seen, typing, reply, edit, delete with undo", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	await connect(ann!, ben!);
	const A = await open(browser, ann!);
	const B = await open(browser, ben!);
	await openChat(A.page, "Ben");
	await openChat(B.page, "Ann");

	await send(A.page, "Hello Ben");
	await expect(B.page.locator(".chat-message.incoming", { hasText: "Hello Ben" })).toBeVisible();
	// read on the other side: the "seen" mark
	await expect(bubble(A.page, "Hello Ben").locator(".chat-message-status svg circle")).toHaveCount(1);

	await B.page.click("textarea.message-input");
	await B.page.keyboard.type("typing...", { delay: 50 });
	await expect(A.page.locator(".chat-typing-status")).toContainText("typing");
	await B.page.fill("textarea.message-input", "");

	await act(B.page, "Hello Ben", "Reply");
	await B.page.keyboard.type("Hi Ann");
	await B.page.keyboard.press("Enter");
	await expect(bubble(A.page, "Hi Ann").locator(".chat-reply-text")).toHaveText("Hello Ben");

	await act(A.page, "Hello Ben", "Edit");
	await A.page.fill("textarea.message-input", "Hello Ben (edited)");
	await A.page.keyboard.press("Enter");
	await expect(bubble(B.page, "Hello Ben (edited)").locator(".chat-edited-label")).toBeVisible();

	await send(A.page, "to be deleted");
	await expect(bubble(B.page, "to be deleted")).toBeVisible();
	await act(A.page, "to be deleted", "Delete");
	await A.page.click(".toaster .undo-btn");
	await A.page.waitForTimeout(3500);
	await expect(bubble(B.page, "to be deleted"), "Undo kept it").toBeVisible();
	await act(A.page, "to be deleted", "Delete");
	await expect(bubble(B.page, "to be deleted"), "gone for both after the Undo window").toHaveCount(0);
	await expect(bubble(A.page, "to be deleted")).toHaveCount(0);

	expect([...A.errors, ...B.errors]).toEqual([]);
});

test("a long chat opens at the newest page; scrolling up loads the older ones, back to the first", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await chatter(ann!, ben!, ab, 120);
	const { page } = await open(browser, ann!);
	await openChat(page, "Ben");
	await expect(bubble(page, "msg 120")).toBeVisible();
	const all = page.locator(".chat .chat-message:not(.skeleton-placeholder)");
	const first = await all.count();
	expect(first, "one page, not the whole chat").toBeLessThan(120);
	await expect
		.poll(
			async () => {
				await page.evaluate(() => document.querySelector(".chat")?.scrollTo({ top: 0 }));
				return bubble(page, "msg 1").count();
			},
			{ timeout: 30_000, intervals: [800] },
		)
		.toBe(1);
	expect(await all.count()).toBeGreaterThan(first);
});

test("reactions and pins reach the other person", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ann!, ab, "react to me");
	await say(ben!, ab, "pin me");
	const A = await open(browser, ann!);
	const B = await open(browser, ben!);
	await openChat(A.page, "Ben");
	await openChat(B.page, "Ann");

	await bubble(B.page, "react to me").click({ button: "right" });
	await B.page.locator(".reaction-bar-btn").first().click();
	await expect(bubble(A.page, "react to me").locator(".reaction-badge")).toBeVisible();

	await act(A.page, "pin me", "Pin");
	await expect(A.page.locator(".pinned-message-container")).toBeVisible();
	await expect(B.page.locator(".pinned-message-container")).toBeVisible();
	expect([...A.errors, ...B.errors]).toEqual([]);
});

test("a forward names the original author", async ({ browser }) => {
	const [ann, ben, cy] = await people("Ann", "Ben", "Cyrus");
	const ab = await connect(ann!, ben!);
	await connect(ann!, cy!);
	await say(ben!, ab, "from Ben with love");
	const A = await open(browser, ann!);
	await openChat(A.page, "Ben");
	await act(A.page, "from Ben with love", "Forward");
	await A.page.locator(".forwarded-contact-card", { hasText: "Cyrus" }).click();
	await A.page.click("button.send-btn");
	await expect(A.page.locator(".chat-header")).toContainText("Cyrus");
	await expect(bubble(A.page, "from Ben with love").locator(".chat-forwarded-label")).toHaveText("Forwarded from Ben");
});

test("selection: two messages chosen and deleted at once, for both", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	for (const text of ["keep this", "first to go", "keep that", "second to go"]) await say(ann!, ab, text);
	const A = await open(browser, ann!);
	const B = await open(browser, ben!);
	await openChat(A.page, "Ben");
	await openChat(B.page, "Ann");
	await act(A.page, "first to go", "Select");
	await A.page.locator(".selection-toolbar").waitFor();
	await bubble(A.page, "second to go").click();
	await expect(A.page.locator(".selection-count")).toHaveText(/^2/);
	await A.page.click(".selection-delete-btn");
	// (after the Undo window)
	await expect(bubble(B.page, "first to go")).toHaveCount(0, { timeout: 15_000 });
	await expect(bubble(B.page, "second to go")).toHaveCount(0);
	await expect(bubble(B.page, "keep this")).toBeVisible();
	await expect(bubble(B.page, "keep that")).toBeVisible();
});

test("a message in another chat shows a banner; tapping it opens that chat", async ({ browser }) => {
	const [ann, ben, cy] = await people("Ann", "Ben", "Cyrus");
	await connect(ann!, ben!);
	const ac = await connect(ann!, cy!);
	const A = await open(browser, ann!);
	await openChat(A.page, "Ben");
	await say(cy!, ac, "Ping from Cyrus");
	const banner = A.page.locator(".in-app-notif.show", { hasText: "Ping from Cyrus" });
	await expect(banner).toBeVisible();
	await banner.click();
	await expect(A.page.locator(".chat-header")).toContainText("Cyrus");
	await expect(bubble(A.page, "Ping from Cyrus")).toBeVisible();
});

test("deleting a chat keeps a message that arrives while it can still be undone", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ann!, ab, "old one");
	await say(ben!, ab, "old two");
	const A = await open(browser, ann!);
	const B = await open(browser, ben!);
	await openChat(A.page, "Ben");
	await openChat(B.page, "Ann");
	await expect(bubble(B.page, "old two")).toBeVisible();

	await A.page.click(".chat-name");
	await A.page.click("#delete-chat-btn");
	await send(B.page, "sent during your undo");
	await A.page.waitForTimeout(4500);

	const left = B.page.locator(".chat .chat-message:not(.skeleton-placeholder)");
	await expect(left).toHaveCount(1);
	await expect(bubble(B.page, "sent during your undo")).toBeVisible();
	await openChat(A.page, "Ben");
	await expect(A.page.locator(".chat .chat-message:not(.skeleton-placeholder)")).toHaveCount(1);
	await expect(bubble(A.page, "sent during your undo")).toBeVisible();
});

test("offline: messages wait and then go; what came meanwhile arrives, once", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	await connect(ann!, ben!);
	const ctx = await context(browser);
	const page = await ctx.newPage();
	const line = await cuttable(page);
	await signIn(page, ann!.username);
	const B = await open(browser, ben!);
	await openChat(page, "Ben");
	await openChat(B.page, "Ann");

	await line.cut();
	await expect(page.locator(".connection-status.visible")).toBeVisible();
	await send(page, "sent while offline");
	await expect(bubble(page, "sent while offline")).toHaveClass(/pending/);
	await send(B.page, "while you were away");
	await page.waitForTimeout(800);

	await line.restore();
	await expect(bubble(B.page, "sent while offline")).toBeVisible({ timeout: 20_000 });
	await expect(bubble(page, "while you were away")).toBeVisible({ timeout: 20_000 });
	await expect(bubble(page, "sent while offline")).not.toHaveClass(/pending/);
	await expect(page.locator(".chat .chat-message", { hasText: "sent while offline" })).toHaveCount(1);
	await expect(B.page.locator(".chat .chat-message", { hasText: "sent while offline" })).toHaveCount(1);
});

test("a message waiting to be sent survives a reload, and goes once the connection is back", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	await connect(ann!, ben!);
	const ctx = await context(browser);
	const page = await ctx.newPage();
	const line = await cuttable(page);
	await signIn(page, ann!.username);
	const B = await open(browser, ben!);
	await openChat(page, "Ben");
	await openChat(B.page, "Ann");

	await line.cut();
	await send(page, "written before the reload");
	await expect(bubble(page, "written before the reload")).toHaveClass(/pending/);
	// the page loads again, still without its live connection
	await line.httpOnly();
	await page.reload();
	await openChat(page, "Ben");
	await expect(bubble(page, "written before the reload"), "kept on the device").toHaveClass(/pending/);
	await line.restore();
	await expect(bubble(B.page, "written before the reload")).toBeVisible({ timeout: 20_000 });
	await expect(bubble(page, "written before the reload")).not.toHaveClass(/pending/, { timeout: 20_000 });
	await expect(B.page.locator(".chat .chat-message", { hasText: "written before the reload" })).toHaveCount(1);
});

test("what changed while the connection was down (a new message, an edit) arrives without a reload", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ben!, ab, "before the blip");
	const ctx = await context(browser);
	const page = await ctx.newPage();
	const line = await cuttable(page);
	await signIn(page, ann!.username);
	const B = await open(browser, ben!);
	await openChat(page, "Ben");
	await openChat(B.page, "Ann");
	await expect(bubble(page, "before the blip")).toBeVisible();

	await line.cut();
	await send(B.page, "during the blip");
	await act(B.page, "before the blip", "Edit");
	await B.page.fill("textarea.message-input", "before the blip (edited)");
	await B.page.keyboard.press("Enter");
	await expect(bubble(B.page, "before the blip (edited)")).toBeVisible();
	await page.waitForTimeout(500);
	await expect(bubble(page, "during the blip"), "nothing arrives while it is down").toHaveCount(0);

	await line.restore();
	await expect(bubble(page, "during the blip")).toBeVisible({ timeout: 20_000 });
	await expect(bubble(page, "before the blip (edited)")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator(".connection-status.visible")).toHaveCount(0);
});

test("sending faster than the server allows: every message arrives, in order, none failed", async ({ browser }) => {
	test.setTimeout(120_000);
	// a server of its own, with the real (tight) limit on actions
	const srv = await startServer({ HTTP_RATE_MAX: "100000", SOCKET_RATE_MAX: "20" });
	try {
		const ann = await newUser(srv.base, "Ann");
		const ben = await newUser(srv.base, "Ben");
		const r = await ann.post<"POST /api/contacts">("/api/contacts", { username: ben.username });
		expect(r.status).toBe(201);
		const A = await context(browser, { baseURL: srv.base });
		const B = await context(browser, { baseURL: srv.base });
		const a = await A.newPage();
		const b = await B.newPage();
		await signIn(a, ann.username);
		await signIn(b, ben.username);
		await openChat(a, "Ben");
		await openChat(b, "Ann");
		for (let i = 1; i <= 30; i++) await send(a, `burst ${i}`);
		const arrived = b.locator(".chat .chat-message .chat-message-text", { hasText: /^burst \d+$/ });
		await expect(arrived).toHaveCount(30, { timeout: 60_000 });
		expect(await arrived.allInnerTexts()).toEqual(Array.from({ length: 30 }, (_, i) => `burst ${i + 1}`));
		await expect(a.locator(".chat-message.failed")).toHaveCount(0);
		await A.close();
		await B.close();
	} finally {
		await srv.stop();
	}
});
