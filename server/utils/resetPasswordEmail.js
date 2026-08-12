export function resetPasswordEmail({ link, appName = "Rivo", expiresMinutes = 30 } = {}) {
	return `
	<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a2e">
		<h2 style="margin:0 0 16px">${appName} — Reset your password</h2>
		<p style="line-height:1.7;margin:0 0 20px">
			We received a request to reset your password. Click the button below to choose a new one.
			This link expires in ${expiresMinutes} minutes and can only be used once.
		</p>
		<p style="margin:0 0 24px">
			<a href="${link}" style="display:inline-block;padding:12px 22px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:10px">Reset password</a>
		</p>
		<p style="line-height:1.7;margin:0;font-size:13px;color:#666">
			If you didn't request this, you can safely ignore this email — your password stays unchanged.
		</p>
	</div>`;
}

export default resetPasswordEmail;
