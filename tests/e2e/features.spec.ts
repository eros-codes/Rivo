// The app's own features: one-time messages and time capsules, the pinned
// list, the scroll button, All contacts, removing a contact (undo), blocking.
import { expect } from "@playwright/test";
import { act, bubble, chatter, connect, jumpsTo, open, openChat, people, say, test } from "./support/app.ts";

test("a one-time message and a time capsule, chosen from the send button's menu", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	await connect(ann!, ben!);
	const A = await open(browser, ann!);
	const B = await open(browser, ben!);
	await openChat(A.page, "Ben");
	await openChat(B.page, "Ann");

	await A.page.fill("textarea.message-input", "secret once");
	await A.page.locator("button.send-btn").click({ button: "right" });
	await A.page.locator(".send-trigger-popup").waitFor();
	await A.page.locator(".onetime-trigger-btn[aria-label='One-time message']").click();
	await A.page.locator("button.send-btn").click();
	await expect(B.page.locator(".chat-message.onetime-message")).toBeVisible();

	await A.page.fill("textarea.message-input", "open me later");
	await A.page.locator("button.send-btn").click({ button: "right" });
	await A.page.locator(".onetime-trigger-btn[aria-label='Time Capsule']").click();
	await A.page.locator(".capsule-picker-wrap[open]").waitFor();
	await A.page.click(".capsule-confirm");
	await A.page.locator("button.send-btn").click();
	await expect(B.page.locator(".chat-message.capsule-locked"), "sealed for the other person").toBeVisible();
	await expect(B.page.locator(".chat-message", { hasText: "open me later" })).toHaveCount(0);
	expect([...A.errors, ...B.errors]).toEqual([]);
});

test("the pinned list jumps to a pinned message; the scroll-to-bottom button brings the newest back", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await chatter(ann!, ben!, ab, 25);
	const { page } = await open(browser, ann!);
	await openChat(page, "Ben");
	await expect(bubble(page, "msg 25")).toBeVisible();
	await bubble(page, "msg 3").scrollIntoViewIfNeeded();
	await act(page, "msg 3", "Pin");
	await page.locator(".pinned-message-container").waitFor();
	await page.click(".pinned-message-icon");
	await jumpsTo(page, "msg 3", () => page.locator(".pinned-view-dialog[open] .pinned-view-item").first().click());

	await expect(page.locator(".scroll-to-bottom-btn.visible"), "away from the bottom").toHaveCount(1);
	await page.click(".scroll-to-bottom-btn");
	await expect(page.locator(".scroll-to-bottom-btn.visible")).toHaveCount(0);
	await expect(bubble(page, "msg 25")).toBeInViewport();
});

test("All contacts: every contact, searchable, closed with Escape", async ({ browser }) => {
	const names = ["Sara", "Reza", "Mina", "Ali", "Neda", "Kian", "Parsa", "Hana", "Omid", "Taraneh", "Babak", "Yasmin"];
	const [ann, ...others] = await people("Ann", ...names);
	for (const other of others) await connect(ann!, other);
	const { page } = await open(browser, ann!);
	await page.click(".contacts-show-more");
	await page.locator(".all-contacts-section").waitFor();
	await expect(page.locator(".all-contacts-list .contacts-card")).toHaveCount(names.length);
	await page.fill(".all-contacts-search", "yas");
	await expect(page.locator(".all-contacts-list .contacts-card")).toHaveCount(1);
	await expect(page.locator(".all-contacts-list .contacts-card")).toContainText("Yasmin");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.locator(".all-contacts-section")).toHaveCount(0);
});

test("removing a contact can be undone", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ben!, ab, "still here?");
	const { page } = await open(browser, ann!);
	await openChat(page, "Ben");
	await page.click(".chat-name");
	await page.click("#delete-contact-btn");
	await page.click(".toaster .undo-btn");
	await page.waitForTimeout(3500);
	await expect(page.locator(".contacts-card, .active-chat", { hasText: "Ben" }).first()).toBeVisible();
	const row = (await ann!.get<"GET /api/contacts">("/api/contacts")).data.find((c) => c.conversationId === ab);
	expect(row, "the contact is still on the server").toBeTruthy();
});

test("blocking: the chat offers Unblock instead of the message box", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ben!, ab, "hello");
	const { page } = await open(browser, ann!);
	await openChat(page, "Ben");
	await page.click(".chat-name");
	await page.click("#block-contact-btn");
	await page.keyboard.press("Escape");
	await expect(page.locator(".unblock-action-btn")).toBeVisible();
	await expect(page.locator("textarea.message-input")).toHaveCount(0);
	// (the screen changes at once; the server's answer comes a moment later)
	await expect.poll(async () => (await ann!.get<"GET /api/contacts">("/api/contacts")).data.find((c) => c.conversationId === ab)?.isBlocked).toBe(true);
	await page.click(".unblock-action-btn");
	await expect(page.locator("textarea.message-input")).toBeVisible();
});
