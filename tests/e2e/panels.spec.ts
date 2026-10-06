// Settings, devices, the password, contacts and their profiles, search, one's
// own profile and picture, deleting the account: the panels and dialogs on a
// computer.
import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { bubble, chatter, connect, context, jumpsTo, me, open, openChat, openSettings, people, say, signIn, test } from "./support/app.ts";

const FACE = fileURLToPath(new URL("./fixtures/face.png", import.meta.url));

test("settings: the dark theme and an accent are kept; a wallpaper; who sees one online is saved", async ({ browser }) => {
	const [ann] = await people("Ann");
	const { page, errors } = await open(browser, ann!);
	await openSettings(page);
	await page.click("#settings-theme-row");
	await expect(page.locator("html.dark-mode")).toHaveCount(1);
	expect(await page.evaluate(() => localStorage.getItem("rivo-theme"))).toBe("dark");

	await page.click("#settings-accent-row");
	await page.locator(".accent-swatch[aria-label='Purple']").click();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("rivo-accent"))).toBe("#7c3aed");
	// (a darker shade of it in dark mode)
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#6826d9");

	await page.click("#settings-wallpaper-row");
	const chooser = page.waitForEvent("filechooser");
	await page.locator(".settings-wallpaper-btn").first().click();
	await (await chooser).setFiles(FACE);
	await expect(page.locator(".toaster", { hasText: "Background updated" })).toBeVisible();
	expect(await page.evaluate(() => (localStorage.getItem("rivo-wallpaper") ?? "").startsWith("data:image/jpeg"))).toBe(true);

	await page.click("#settings-privacy-online");
	await page.locator(".settings-picker-option", { hasText: "Nobody" }).click();
	await expect(page.locator(".toaster", { hasText: "Saved" })).toBeVisible();
	expect((await me(page)).privacyOnline).toBe("nobody");

	// all of it still there after a reload
	await page.reload();
	await expect(page.locator("html.dark-mode")).toHaveCount(1);
	expect(errors).toEqual([]);
});

test("devices: another sign-in is listed; signing it out sends that tab to sign-in", async ({ browser }) => {
	const [ann] = await people("Ann");
	const { page } = await open(browser, ann!);
	const other = await context(browser);
	const otherPage = await other.newPage();
	await signIn(otherPage, ann!.username);

	await openSettings(page);
	await page.click("#settings-devices");
	const items = page.locator(".devices-dialog .device-item");
	await expect(items.first()).toBeVisible();
	const n = await items.count();
	expect(n, "this page, the other tab, the test's own sign-in").toBeGreaterThanOrEqual(3);
	// (the newest other device first)
	await page.locator(".device-signout").first().click();
	await expect(items).toHaveCount(n - 1);
	await otherPage.waitForURL("**/auth/**");
	await page.keyboard.press("Escape");
	await expect(page.locator(".devices-dialog")).toHaveCount(0);
	await other.close();
});

test("changing the password: a wrong current one is said, then it changes", async ({ browser }) => {
	const [ann] = await people("Ann");
	const { page } = await open(browser, ann!);
	await openSettings(page);
	await page.click("#settings-change-password");
	const form = page.locator(".settings-change-password-form");
	await form.locator("input[autocomplete='current-password']").fill("wrongpass1");
	await form.locator("input[placeholder='New password']").fill("newpassword9");
	await form.locator("input[placeholder='Confirm new password']").fill("newpassword9");
	await page.click(".settings-change-password-submit");
	await expect(page.locator(".settings-feedback--error", { hasText: "incorrect" })).toBeVisible();
	await form.locator("input[autocomplete='current-password']").fill("password123");
	await page.click(".settings-change-password-submit");
	await expect(page.locator(".toaster", { hasText: "Password changed" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("dialog.settings-dialog")).toHaveCount(0);
	expect((await ann!.post("/api/auth/login", { identifier: ann!.username, password: "newpassword9" })).status).toBe(200);
});

test("adding a contact: an unknown username is said; someone already in the list opens their chat", async ({ browser }) => {
	const [ann, cy] = await people("Ann", "Cyrus");
	await connect(ann!, cy!);
	const { page } = await open(browser, ann!);
	await page.click(".add-friends");
	await page.fill("#add-contact-username", "nobody_here_123");
	await page.click(".add-contact-submit");
	await expect(page.locator(".add-contact-error", { hasText: "No one" })).toBeVisible();
	await page.fill("#add-contact-username", cy!.username);
	await page.click(".add-contact-submit");
	await expect(page.locator(".chat-header")).toContainText("Cyrus");
});

test("a contact's profile: rename, archive (it leaves the lists), unarchive from Settings; mute from the list", async ({ browser }) => {
	const [ann, cy] = await people("Ann", "Cyrus");
	const ac = await connect(ann!, cy!);
	await say(cy!, ac, "hello from Cyrus");
	const { page } = await open(browser, ann!);
	await openChat(page, "Cyrus");
	// read first: an unread chat stays in Active Chats, and the end of this test
	// needs Cyrus among the contact cards (the chat's messages can take a moment
	// to arrive, and only what was on screen counts as read)
	await expect(bubble(page, "hello from Cyrus")).toBeVisible();
	await expect.poll(async () => (await ann!.get<"GET /api/contacts">("/api/contacts")).data.find((c) => c.conversationId === ac)?.unreadCount).toBe(0);
	await page.click(".chat-name");
	await page.locator("dialog.profile-dialog[open]").waitFor();
	await page.click("#edit-name-btn");
	await page.locator("h3.editing").waitFor();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.type("Cyrus the Great");
	await page.keyboard.press("Enter");
	await expect(page.locator(".chat-name")).toHaveText("Cyrus the Great");

	await page.click("#archive-contact-btn");
	await expect(page.locator(".chat-part")).toHaveCount(0);
	const listed = page.locator(".active-chat, .contacts-card", { hasText: "Cyrus the Great" });
	await expect(listed).toHaveCount(0);
	await openSettings(page);
	await page.click("#settings-archived");
	await page.locator(".archived-card").waitFor();
	await page.click(".archived-card-unarchive-btn");
	await expect(page.locator(".archived-dialog-empty")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(listed.first()).toBeVisible();

	const card = page.locator("#main-content .contacts-card", { hasText: "Cyrus the Great" }).first();
	await card.hover();
	await card.locator(".contact-menu-btn").click();
	await card.locator(".contact-menu-item").first().click(); // Mute
	await expect(card.locator(".contact-muted-icon")).toHaveCount(1);
	// (the screen changes at once; the server's answer comes a moment later)
	await expect
		.poll(async () => (await ann!.get<"GET /api/contacts">("/api/contacts")).data.find((c) => c.conversationId === ac))
		.toMatchObject({ nickname: "Cyrus the Great", isArchived: false, isMuted: true });
});

test("search finds a message and jumps to it; an active chat dragged with the mouse shows its actions", async ({ browser }) => {
	const [ann, ben] = await people("Ann", "Ben");
	const ab = await connect(ann!, ben!);
	await chatter(ann!, ben!, ab, 40);
	const { page } = await open(browser, ann!);
	await page.click(".search-bar");
	await page.keyboard.type("msg 7");
	await jumpsTo(page, "msg 7", () => page.locator(".search-message-result").first().click());
	await page.keyboard.press("Escape");
	await page.goBack();

	const card = page.locator(".active-chat", { hasText: "Ben" }).first();
	const box = (await card.boundingBox())!;
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + 200, y);
	await page.mouse.down();
	await page.mouse.move(box.x + 260, y, { steps: 5 });
	await page.mouse.move(box.x + 360, y, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => Math.abs((await card.boundingBox())!.x - box.x)).toBeGreaterThan(100);
});

test("one's profile: a bio and a new picture (cropped, uploaded, made a JPEG) are saved", async ({ browser }) => {
	const [ann] = await people("Ann");
	const { page, errors } = await open(browser, ann!);
	await page.hover(".settings-list");
	await page.click(".edit-section");
	await page.locator("dialog.edit-profile-dialog[open]").waitFor();
	await page.fill("#edit-bio-input", "Hello, I build Rivo");
	const chooser = page.waitForEvent("filechooser");
	await page.click(".edit-profile-avatar-btn");
	await (await chooser).setFiles(FACE);
	await page.locator(".avatar-crop-dialog .avatar-crop-image").waitFor();
	await page.click(".avatar-crop-confirm");
	await expect(page.locator(".avatar-crop-dialog")).toHaveCount(0);
	await expect(page.locator("img.edit-profile-avatar")).toHaveCount(1);
	await page.click(".edit-profile-save");
	await expect(page.locator(".toaster", { hasText: "Profile updated" })).toBeVisible();
	const saved = await me(page);
	expect(saved.bio).toBe("Hello, I build Rivo");
	expect(saved.profilePics).toHaveLength(1);
	// the stored picture is the server's re-encoded JPEG (no metadata from the upload)
	const picture = await page.request.get(saved.profilePics[0]!);
	expect(picture.status()).toBe(200);
	expect(picture.headers()["content-type"]).toContain("image/jpeg");
	expect([...(await picture.body()).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	expect(errors).toEqual([]);
});

test("deleting the account asks for the password", async ({ browser }) => {
	const [ann] = await people("Ann");
	const { page } = await open(browser, ann!);
	await openSettings(page);
	await page.click("#settings-delete-account");
	await page.fill(".confirm-dialog-input", "nope-nope");
	await page.click(".confirm-dialog-btn--danger");
	await expect(page.locator(".confirm-dialog-error", { hasText: "Incorrect" })).toBeVisible();
	await page.fill(".confirm-dialog-input", "password123");
	await page.click(".confirm-dialog-btn--danger");
	await page.waitForURL("**/auth/**");
	expect((await ann!.get("/api/users/me")).status).toBe(401);
});
