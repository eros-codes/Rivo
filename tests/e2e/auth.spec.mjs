// Getting in: signing up with the emailed code, and what sign-up must not
// reveal; the landing page.
import { test, expect } from "@playwright/test";
import { mails } from "../api/support/backend.mjs";
import { base, people, uniq } from "./support/app.mjs";

test("sign up with the emailed code, then sign in", async ({ page }) => {
	const username = uniq("new");
	const email = `${username}@test.io`;
	await page.goto("/auth/");
	await page.click(".signuplink");
	await page.fill("#name", "New Person");
	await page.fill("#email", email);
	await page.fill("#username", username);
	await page.click("form.signup button.form-submit");
	await page.locator("form.verify").waitFor();

	const mail = (await mails(base())).filter((m) => m.to === email).pop();
	const code = /(\d{6})/.exec(mail?.text ?? "")?.[1];
	expect(code, "a code was emailed").toBeTruthy();
	await page.locator(".code-digit").first().fill(code);
	await page.click("form.verify button.form-submit");

	await page.fill("#password", "password123");
	await page.fill("#confirm-password", "password123");
	await page.click("form.password button.form-submit");
	await expect(page.locator("#login-username")).toHaveValue(username);
	await page.fill("#login-password", "password123");
	await page.click("button.form-submit");
	await page.waitForURL("**/chat/");
	await expect(page.locator(".active-chat", { hasText: "Saved Messages" })).toBeVisible();
});

test("sign-up with an address that has an account: same steps, help by email", async ({ page }) => {
	const [ann] = await people("Ann");
	await page.goto("/auth/");
	await page.click(".signuplink");
	await page.fill("#name", "Someone Else");
	await page.fill("#email", ann.email);
	await page.fill("#username", uniq("other"));
	const before = (await mails(base())).length;
	await page.click("form.signup button.form-submit");
	await page.locator("form.verify").waitFor();
	await expect(page.locator("#code-help")).toContainText("already has a Rivo account");
	const sent = (await mails(base())).slice(before).filter((m) => m.to === ann.email);
	expect(sent).toHaveLength(1);
	expect(sent[0].subject).toContain("already have");
});

test("the landing page and the privacy page load", async ({ page }) => {
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto("/");
	await expect(page.locator("section.hero")).toBeVisible();
	await expect(page.locator("a.nav-cta")).toBeVisible();
	await page.goto("/landing/privacy.html");
	await expect(page.locator("h1").first()).toBeVisible();
	expect(errors).toEqual([]);
});
