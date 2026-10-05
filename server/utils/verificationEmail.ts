import { emailLayout, emailStyle, escapeHtml } from "./emailLayout.ts";

/** A ready email: what nodemailer's sendMail takes besides the addresses. */
export interface Email {
	subject: string;
	html: string;
	text: string;
}

/**
 * The bare address of a sender. SMTP_FROM is often written with a name,
 * `Rivo <support@rivo.ir>`, but a mailto: link (and the text "write to …")
 * takes only the address.
 */
export function addressOf(sender: unknown): string {
	const s = String(sender || "").trim();
	const m = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(s);
	return m && m[1] ? m[1] : s;
}

export interface VerificationEmailOptions {
	code: string | number;
	appName?: string;
	expiresMinutes?: number;
	/** where "write to …" points (default: SMTP_FROM) */
	supportEmail?: string;
	/** the recipient (not shown in the email) */
	email?: string;
}

export function verificationEmail({ code, appName = "Rivo", expiresMinutes = 10, supportEmail: sender = process.env.SMTP_FROM || "support@rivo.ir" }: VerificationEmailOptions): Email {
	const supportEmail = addressOf(sender) || "support@rivo.ir";
	const minutes = `${expiresMinutes} minute${expiresMinutes === 1 ? "" : "s"}`;
	const subject = `${appName} verification code`;
	const html = emailLayout({
		appName,
		title: "Your verification code",
		preheader: `Your ${appName} verification code is ${code}`,
		bodyHtml: `
<p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#555555;">Enter this code to verify your email address.</p>
<div style="margin:0 0 18px;"><span style="display:inline-block;padding:14px 22px;border-radius:12px;background:${emailStyle.CREAM};font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:${emailStyle.DARK};">${escapeHtml(code)}</span></div>
<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#888888;">It expires in ${minutes}.</p>
<p style="margin:0;font-size:13px;line-height:1.7;color:#888888;">Didn't ask for it? You can ignore this email, or write to <a href="mailto:${escapeHtml(supportEmail)}" style="color:${emailStyle.ACCENT};text-decoration:none;">${escapeHtml(supportEmail)}</a>.</p>`,
	});
	const text = `Your ${appName} verification code is ${code}. It expires in ${minutes}.\n\nIf you did not request it, ignore this email or contact ${supportEmail}.`;
	return { subject, html, text };
}

export default verificationEmail;
