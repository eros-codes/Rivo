import { emailLayout, emailStyle, escapeHtml } from "./emailLayout.js";

// Sent instead of a verification code when someone starts signing up with an
// address that already has an account: the sign-up form answers the same way
// either way, so it cannot be used to find out who has an account.
export function accountExistsEmail({ appName = "Rivo", signInUrl, resetUrl } = {}) {
	const subject = `You already have a ${appName} account`;
	const html = emailLayout({
		appName,
		title: "You already have an account",
		preheader: `Someone tried to sign up to ${appName} with this address`,
		bodyHtml: `
<p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#555555;">Someone (hopefully you) tried to create a new ${escapeHtml(appName)} account with this email address. It already belongs to an account, so no new one was made.</p>
<p style="margin:0 0 22px;"><a href="${escapeHtml(signInUrl)}" style="display:inline-block;padding:12px 26px;border-radius:999px;background:${emailStyle.ACCENT};color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;">Sign in</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#888888;">Forgot your password? <a href="${escapeHtml(resetUrl)}" style="color:${emailStyle.ACCENT};text-decoration:none;">Reset it from the sign-in page</a>.</p>
<p style="margin:0;font-size:13px;line-height:1.7;color:#888888;">Wasn't you? You can ignore this email; nothing about your account changed.</p>`,
	});
	const text = `Someone tried to create a new ${appName} account with this email address, but it already has an account. Sign in: ${signInUrl}\nForgot your password? ${resetUrl}\n\nWasn't you? Ignore this email; nothing changed.`;
	return { subject, html, text };
}

export default accountExistsEmail;
