// On a phone: a chat and the panels open as pages and Back closes them; touch
// gestures (holding a message, swiping to reply, swiping a chat in the list).
import { expect, devices } from "@playwright/test";
import { bubble, chatter, connect, finger, open, people, PHONE, say, test } from "./support/app.ts";

test("on a phone a chat covers the list, and Back returns to it", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ben!, ab, "hello phone");
	const { page } = await open(browser, ann!, { ...devices["Pixel 7"] });
	await page.locator(".active-chat", { hasText: "Ben" }).first().tap();
	await expect(bubble(page, "hello phone")).toBeVisible();
	// (it slides in)
	await expect.poll(async () => (await page.locator(".chat-part").boundingBox())?.x).toBe(0);
	await page.goBack();
	await expect(page.locator(".chat-part")).toHaveCount(0);
	expect(page.url()).toMatch(/\/chat\/$/);
});

test("on a phone the panels are pages: settings, a profile over its chat, edit profile; Back closes each", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ben!, ab, "hi there");
	const { page, errors } = await open(browser, ann!, PHONE);

	await page.locator(".settings-list").tap();
	await page.locator(".settings-section").tap();
	await expect(page.locator(".settings-panel")).toBeVisible();
	await page.locator("#settings-accent-row").tap();
	await page.locator("#settings-change-password").tap();
	await page.goBack();
	await expect(page.locator(".settings-panel")).toHaveCount(0);

	await page.locator(".active-chat", { hasText: "Ben" }).first().tap();
	await page.locator(".chat-header").waitFor();
	await page.locator(".chat-name").tap();
	await expect(page.locator(".contact-profile-details")).toBeVisible();
	await page.goBack();
	await expect(page.locator(".contact-profile-details")).toHaveCount(0);
	await expect(page.locator(".chat-part"), "the chat is still open under it").toHaveCount(1);

	await page.locator("textarea.message-input").tap();
	await page.keyboard.type("Hi from the phone");
	await page.locator("button.send-btn").tap();
	await expect(bubble(page, "Hi from the phone")).toBeVisible();

	await page.goBack();
	await page.locator(".settings-list").tap();
	await page.locator(".edit-section").tap();
	await expect(page.locator(".edit-profile-panel")).toBeVisible();
	await page.goBack();
	await expect(page.locator(".edit-profile-panel")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("touch: holding a message opens its menu (a tap outside closes it); swiping it right starts a reply", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await chatter(ann!, ben!, ab, 12);
	const { page } = await open(browser, ann!, PHONE);
	const touch = await finger(page);
	await page.locator(".active-chat", { hasText: "Ben" }).first().tap();
	await expect(bubble(page, "msg 12")).toBeVisible();
	// (once it has slid in: a finger lands where the message is)
	await expect.poll(async () => (await page.locator(".chat-part").boundingBox())?.x).toBe(0);

	await touch.hold(bubble(page, "msg 11"));
	await expect(page.locator(".message-menu.visible")).toBeVisible();
	await page.waitForTimeout(400);
	await page.locator(".chat-overlay").tap({ position: { x: 30, y: 400 } });
	await expect(page.locator(".message-menu")).toHaveCount(0);

	await touch.swipe(bubble(page, "msg 9"), 144);
	await expect(page.locator(".message-action-preview", { hasText: "Replying" })).toBeVisible();
});

test("touch: a chat in the list swiped left shows its actions (Pin works); the next tap closes them", async ({ browser }) => {
	const [ann, ben, cy] = await people("Ann", "Ben", "Cyrus");
	const ab = await connect(ann!, ben!);
	const ac = await connect(ann!, cy!);
	await say(ben!, ab, "from Ben");
	await say(cy!, ac, "from Cyrus");
	const { page } = await open(browser, ann!, PHONE);
	const touch = await finger(page);
	const card = (name: string) => page.locator(".active-chat", { hasText: name }).first();
	const x = async (name: string) => (await card(name).boundingBox())!.x;

	const benAt = await x("Ben");
	await touch.swipe(card("Ben"), -168, { from: "right" });
	await expect.poll(() => x("Ben"), "moved aside").toBeLessThan(benAt - 100);
	await page.locator(".active-chat-wrapper").filter({ has: card("Ben") }).locator(".card-action-btn--pin").tap();
	await expect(page.locator(".active-chat.pinned", { hasText: "Ben" })).toHaveCount(1);

	const cyAt = await x("Cyrus");
	const { y } = await touch.swipe(card("Cyrus"), -168, { from: "right" });
	await expect.poll(() => x("Cyrus")).toBeLessThan(cyAt - 100);
	// a finger on what is still showing of the card: the first tap only closes it
	await touch.tapAt(120, y);
	await expect.poll(async () => Math.abs((await x("Cyrus")) - cyAt)).toBeLessThan(5);
	await expect(page.locator(".chat-part")).toHaveCount(0);
});
