// Shared look of Rivo's emails: the app's cream background, dark header and
// orange accent. Inline styles only (mail clients drop <style> blocks).
const ACCENT = "#fa5f1a";
const DARK = "#252525";
const CREAM = "#f7f0f0";

export function escapeHtml(v: unknown): string {
	return String(v ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export interface EmailLayoutOptions {
	appName?: string;
	/** the line mail apps show next to the subject */
	preheader?: string;
	title: string;
	/** trusted HTML (escape anything that came from a user) */
	bodyHtml: string;
}

export function emailLayout({ appName = "Rivo", preheader = "", title, bodyHtml }: EmailLayoutOptions): string {
	const name = escapeHtml(appName);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${CREAM};font-family:Poppins,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${DARK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="background:${DARK};border-radius:16px 16px 0 0;padding:20px 28px;">
<span style="font-size:22px;font-weight:700;color:${CREAM};letter-spacing:-0.5px;">${name}<span style="color:${ACCENT};">.</span></span>
</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,0.08);">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:${DARK};">${escapeHtml(title)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 8px;text-align:center;font-size:12px;color:#999999;">${name} — Conversations, Uninterrupted.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export const emailStyle = { ACCENT, DARK, CREAM };
