// Things on screen: dialogs and what shows above them, the keyboard inside
// messages.
import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { bubble, chatter, connect, open, openChat, people, say, test } from "./support/app.ts";

const FACE = fileURLToPath(new URL("./fixtures/face.png", import.meta.url));

test("a toast shows above an open dialog; Escape in the cropper closes only the cropper", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const { page } = await open(browser, ann!);
	await page.hover(".settings-list");
	await page.click(".edit-section");
	await page.locator("dialog.edit-profile-dialog[open]").waitFor();

	await page.fill("#edit-username-input", ben!.username);
	await page.click(".edit-profile-save");
	const toast = page.locator(".toaster .toast", { hasText: "already taken" });
	await expect(toast).toBeVisible();
	const onTop = await toast.evaluate((t) => {
		const r = t.getBoundingClientRect();
		return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".toaster");
	});
	expect(onTop, "nothing (the dialog's backdrop) covers the toast").toBe(true);

	const chooser = page.waitForEvent("filechooser");
	await page.click(".edit-profile-avatar-btn");
	await (await chooser).setFiles(FACE);
	await page.locator(".avatar-crop-dialog .avatar-crop-image").waitFor();
	await page.keyboard.press("Escape");
	await expect(page.locator(".avatar-crop-dialog")).toHaveCount(0);
	await expect(page.locator("dialog.edit-profile-dialog[open]"), "Edit Profile stays open").toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.locator("dialog.edit-profile-dialog[open]")).toHaveCount(0);
});

test("Enter on a link inside a message follows the link (not the message menu)", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await say(ben!, ab, "look https://example.com/rivo-test");
	const { context, page } = await open(browser, ann!);
	await context.route("https://example.com/**", (r) => r.fulfill({ body: "ok" }));
	await openChat(page, "Ben");
	await page.locator(".chat .chat-message a.message-link").last().focus();
	const opened = context.waitForEvent("page");
	await page.keyboard.press("Enter");
	await (await opened).close();
	await expect(page.locator(".message-menu.visible")).toHaveCount(0);
});

test("the keyboard in a chat: arrows move between messages, Enter opens the menu, Escape returns", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await chatter(ann!, ben!, ab, 6);
	const { page } = await open(browser, ben!);
	await openChat(page, "Ann");
	await expect(bubble(page, "msg 6")).toBeVisible();
	await page.focus(".chat");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowUp");
	const focused = () => page.evaluate(() => document.activeElement?.className ?? "");
	expect(await focused()).toContain("chat-message");
	await page.keyboard.press("Enter");
	await expect(page.locator(".message-menu.visible")).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	await expect(page.locator(".message-menu")).toHaveCount(0);
	expect(await focused(), "focus back on the message").toContain("chat-message");
});
