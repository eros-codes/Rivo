// Two people chatting: what each sees, live, and what survives a lost connection.
import { test, expect } from "@playwright/test";
import { bubble, connect, cuttable, open, openChat, people, say, send, signIn } from "./support/app.mjs";

test("two people chat live: send, seen, typing, reply, edit, delete with undo", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	await connect(ann, ben);
	const A = await open(browser, ann);
	const B = await open(browser, ben);
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

	await bubble(B.page, "Hello Ben").click({ button: "right" });
	await B.page.locator(".message-menu li", { hasText: "Reply" }).click();
	await B.page.keyboard.type("Hi Ann");
	await B.page.keyboard.press("Enter");
	await expect(bubble(A.page, "Hi Ann").locator(".chat-reply-text")).toHaveText("Hello Ben");

	await bubble(A.page, "Hello Ben").click({ button: "right" });
	await A.page.locator(".message-menu li", { hasText: "Edit" }).click();
	await A.page.fill("textarea.message-input", "Hello Ben (edited)");
	await A.page.keyboard.press("Enter");
	await expect(bubble(B.page, "Hello Ben (edited)").locator(".chat-edited-label")).toBeVisible();

	await send(A.page, "to be deleted");
	await expect(bubble(B.page, "to be deleted")).toBeVisible();
	await bubble(A.page, "to be deleted").click({ button: "right" });
	await A.page.locator(".message-menu li", { hasText: "Delete" }).click();
	await A.page.click(".toaster .undo-btn");
	await A.page.waitForTimeout(3500);
	await expect(bubble(B.page, "to be deleted"), "Undo kept it").toBeVisible();
	await bubble(A.page, "to be deleted").click({ button: "right" });
	await A.page.locator(".message-menu li", { hasText: "Delete" }).click();
	await expect(bubble(B.page, "to be deleted"), "gone for both after the Undo window").toHaveCount(0);
	await expect(bubble(A.page, "to be deleted")).toHaveCount(0);

	expect([...A.errors, ...B.errors]).toEqual([]);
});

test("a forward names the original author", async ({ browser }) => {
	const [ann, ben, cy] = await people("Ann", "Ben", "Cyrus");
	const ab = await connect(ann, ben);
	await connect(ann, cy);
	await say(ben, ab, "from Ben with love");
	const A = await open(browser, ann);
	await openChat(A.page, "Ben");
	await bubble(A.page, "from Ben with love").click({ button: "right" });
	await A.page.locator(".message-menu li", { hasText: "Forward" }).click();
	await A.page.locator(".forwarded-contact-card", { hasText: "Cyrus" }).click();
	await A.page.click("button.send-btn");
	await expect(A.page.locator(".chat-header")).toContainText("Cyrus");
	await expect(bubble(A.page, "from Ben with love").locator(".chat-forwarded-label")).toHaveText("Forwarded from Ben");
});

test("deleting a chat keeps a message that arrives while it can still be undone", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann, ben);
	await say(ann, ab, "old one");
	await say(ben, ab, "old two");
	const A = await open(browser, ann);
	const B = await open(browser, ben);
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
	await connect(ann, ben);
	const context = await browser.newContext();
	const page = await context.newPage();
	const line = await cuttable(page);
	await signIn(page, ann.username);
	const B = await open(browser, ben);
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
