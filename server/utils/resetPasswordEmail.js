import { emailLayout, emailStyle, escapeHtml } from "./emailLayout.js";

export function resetPasswordEmail({ link, appName = "Rivo", expiresMinutes = 30 } = {}) {
	return emailLayout({
		appName,
		title: "Reset your password",
		preheader: "Choose a new password for your account",
		bodyHtml: `
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#555555;">We received a request to reset your password. The button below lets you choose a new one. It works once and expires in ${expiresMinutes} minutes.</p>
<p style="margin:0 0 22px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 26px;border-radius:999px;background:${emailStyle.ACCENT};color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;">Reset password</a></p>
<p style="margin:0 0 8px;font-size:12px;line-height:1.7;color:#888888;">If the button does not work, open this link:</p>
<p style="margin:0 0 18px;font-size:12px;line-height:1.6;word-break:break-all;"><a href="${escapeHtml(link)}" style="color:${emailStyle.ACCENT};">${escapeHtml(link)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.7;color:#888888;">Didn't ask for this? Ignore this email — your password stays as it is.</p>`,
	});
}

export default resetPasswordEmail;
