// Getting in: signing up with the emailed code (and what sign-up must not
// reveal), signing in, a forgotten password; the landing page.
import { expect } from "@playwright/test";
import { base, context, mails, open, people, PHONE, test, uniq } from "./support/app.ts";

/** The newest email to `to` (the code, the reset link, …). */
async function lastMailTo(to: string) {
	const mail = (await mails()).filter((m) => m.to === to).pop();
	expect(mail, `an email to ${to}`).toBeTruthy();
	return mail!;
}

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

	const code = /(\d{6})/.exec((await lastMailTo(email)).text)?.[1];
	expect(code, "a code was emailed").toBeTruthy();
	await page.locator(".code-digit").first().fill(code!);
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

test("sign-up says what is wrong: each field, a wrong code, passwords that differ", async ({ browser }) => {
	const ctx = await context(browser, PHONE);
	const page = await ctx.newPage();
	const username = uniq("fix");
	const email = `${username}@test.io`;
	await page.goto("/auth/");
	await page.click(".signuplink");
	await page.fill("#name", "N");
	await page.fill("#email", "bad");
	await page.fill("#username", "x");
	await page.click("form.signup button.form-submit");
	await expect(page.locator(".input-error"), "name, email and username").toHaveCount(3);

	await page.fill("#name", "New User");
	await page.fill("#email", email);
	await page.fill("#username", username);
	await page.click("form.signup button.form-submit");
	await page.locator(".code-digit").first().waitFor();
	const code = /(\d{6})/.exec((await lastMailTo(email)).text)![1]!;
	const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
	await page.locator(".code-digit").first().fill(wrong);
	await page.click("form.verify button.form-submit");
	await expect(page.locator(".code-error")).toBeVisible();
	await page.locator(".code-digit").first().fill(code);
	await page.click("form.verify button.form-submit");

	await page.fill("#password", "secretpass1");
	await page.fill("#confirm-password", "secretpass2");
	await page.click("form.password button.form-submit");
	await expect(page.locator(".input-error", { hasText: "match" })).toHaveCount(1);
	await page.fill("#confirm-password", "secretpass1");
	await page.click("form.password button.form-submit");
	await expect(page.locator(".auth-notice", { hasText: "account is ready" })).toBeVisible();
	await expect(page.locator("#login-username")).toHaveValue(username);
	await ctx.close();
});

test("sign-up with an address that has an account: same steps, help by email", async ({ page }) => {
	const [ann] = await people("Ann");
	await page.goto("/auth/");
	await page.click(".signuplink");
	await page.fill("#name", "Someone Else");
	await page.fill("#email", ann!.email);
	await page.fill("#username", uniq("other"));
	const before = (await mails()).length;
	await page.click("form.signup button.form-submit");
	await page.locator("form.verify").waitFor();
	await expect(page.locator("#code-help")).toContainText("already has a Rivo account");
	const sent = (await mails()).slice(before).filter((m) => m.to === ann!.email);
	expect(sent).toHaveLength(1);
	expect(sent[0]!.subject).toContain("already have");
});

test("a wrong password is said; signed in, /auth/ goes straight to the chat", async ({ page }) => {
	const [ann] = await people("Ann");
	await page.goto("/auth/");
	await page.fill("#login-username", ann!.username);
	await page.fill("#login-password", "wrongwrong");
	await page.click("button.form-submit");
	await expect(page.locator(".input-error", { hasText: "Invalid" })).toBeVisible();
	await page.fill("#login-password", "password123");
	await page.click("button.form-submit");
	await page.waitForURL("**/chat/");
	await page.goto("/auth/");
	await page.waitForURL("**/chat/");
});

test("forgot password: the emailed link, the token leaves the address bar, the new password works", async ({ browser }) => {
	const [ann] = await people("Ann");
	const { page } = await open(browser, ann!);
	// signing out first, from the menu
	await page.hover(".settings-list");
	await page.click(".logout-section");
	await page.waitForURL("**/auth/**");

	await page.click("text=Forgot Password?");
	await page.fill("#forgot-identifier", ann!.username);
	await page.click("button.form-submit");
	await expect(page.locator(".auth-notice", { hasText: "reset link" })).toBeVisible();
	let link: string | undefined;
	await expect
		.poll(async () => {
			link = /(\/reset-password\.html\?token=\S+)/.exec((await mails()).filter((m) => m.to === ann!.email).pop()?.text ?? "")?.[1];
			return link;
		})
		.toBeTruthy();
	await page.goto(link!);
	await page.locator("#new-password").waitFor();
	expect(page.url(), "the token is not left in the address bar (or the history)").not.toContain("token");
	await page.fill("#new-password", "brandnew99");
	await page.fill("#confirm-password", "brandnew99");
	await page.click("button.form-submit");
	await page.waitForURL("**/auth/**");
	await expect(page.locator(".auth-notice", { hasText: "password was changed" })).toBeVisible();
	await page.fill("#login-username", ann!.username);
	await page.fill("#login-password", "brandnew99");
	await page.click("button.form-submit");
	await page.waitForURL("**/chat/");
});

test("the landing page and the privacy page load (nothing from other servers, the headings in Syne); the demo phone and the phone menu work", async ({ browser, page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	// everything comes from Rivo itself (the privacy page says so)
	const elsewhere: string[] = [];
	const own = new URL(base()).host;
	page.on("request", (r) => {
		const url = new URL(r.url());
		if (/^https?:$/.test(url.protocol) && url.host !== own) elsewhere.push(r.url());
	});
	await page.goto("/");
	await expect(page.locator("section.hero")).toBeVisible();
	await expect(page.locator("a.nav-cta")).toBeVisible();
	// the heading typeface is our own copy, and it loaded
	expect(await page.evaluate(async () => (await document.fonts.load('800 32px "Syne"', "Rivo")).length)).toBeGreaterThan(0);
	expect(await page.evaluate(() => document.fonts.check('800 32px "Syne"', "Rivo"))).toBe(true);
	// the phone in the page is a small working demo
	await page.locator(".pm-back-btn").click();
	await page.locator(".pm-contact-card", { hasText: "Jake" }).click();
	await expect(page.locator(".phone-name")).toHaveText("Jake");
	await page.goto("/landing/privacy.html");
	await expect(page.locator("h1").first()).toBeVisible();
	expect(elsewhere, "requests to other servers").toEqual([]);

	const phone = await context(browser, PHONE);
	const small = await phone.newPage();
	small.on("pageerror", (e) => errors.push(String(e)));
	await small.goto("/");
	await small.locator(".nav-burger").tap();
	await expect(small.locator(".nav-mobile.open")).toHaveCount(1);
	await phone.close();
	expect(errors).toEqual([]);
});
