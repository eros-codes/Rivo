// Things on screen: dialogs and what shows above them, the keyboard inside
// messages, the phone layout.
import { test, expect, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { bubble, connect, open, openChat, people, say } from "./support/app.mjs";

const FACE = fileURLToPath(new URL("./fixtures/face.png", import.meta.url));

test("a toast shows above an open dialog; Escape in the cropper closes only the cropper", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const { page } = await open(browser, ann);
	await page.hover(".settings-list");
	await page.click(".edit-section");
	await page.locator("dialog.edit-profile-dialog[open]").waitFor();

	await page.fill("#edit-username-input", ben.username);
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
	const ab = await connect(ann, ben);
	await say(ben, ab, "look https://example.com/rivo-test");
	const { context, page } = await open(browser, ann);
	await context.route("https://example.com/**", (r) => r.fulfill({ body: "ok" }));
	await openChat(page, "Ben");
	await page.locator(".chat .chat-message a.message-link").last().focus();
	const opened = context.waitForEvent("page");
	await page.keyboard.press("Enter");
	await (await opened).close();
	await expect(page.locator(".message-menu.visible")).toHaveCount(0);
});

test("on a phone a chat covers the list, and Back returns to it", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann, ben);
	await say(ben, ab, "hello phone");
	const { page } = await open(browser, ann, { ...devices["Pixel 7"] });
	await page.locator(".active-chat", { hasText: "Ben" }).first().tap();
	await expect(bubble(page, "hello phone")).toBeVisible();
	// (it slides in)
	await expect.poll(async () => (await page.locator(".chat-part").boundingBox())?.x).toBe(0);
	await page.goBack();
	await expect(page.locator(".chat-part")).toHaveCount(0);
	expect(page.url()).toMatch(/\/chat\/$/);
});
