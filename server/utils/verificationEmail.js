// Simple verification email HTML template generator
export function verificationEmail({ code, email, appName = 'Rivo', expiresMinutes = 10, supportEmail = process.env.SMTP_FROM || 'support@rivo.ir' } = {}) {
  const subject = `${appName} verification code`;
  const preheader = `Your ${appName} verification code is ${code}`;
  const html = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${subject}</title>
    <style>
      body { background-color: #f6f9fc; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,Helvetica,sans-serif; color: #0f172a; margin: 0; padding: 24px; }
      .email-wrapper { max-width: 600px; margin: 0 auto; }
      .card { background: #ffffff; border-radius: 8px; padding: 28px; box-shadow: 0 6px 18px rgba(15,23,42,0.06); }
      .brand { color: #0b74ff; font-weight: 700; font-size: 20px; margin-bottom: 8px; }
      h1 { margin: 0 0 12px 0; font-size: 18px; }
      p { margin: 0 0 12px 0; color: #475569; }
      .code { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Roboto Mono", "Courier New", monospace; background: #f1f5f9; padding: 14px 18px; font-size: 28px; letter-spacing: 4px; border-radius: 8px; color: #0b1220; }
      .muted { color: #94a3b8; font-size: 13px; }
      .footer { margin-top: 18px; font-size: 12px; color: #9aa4b2; }
      a.support { color: #0b74ff; text-decoration: none; }
      @media (max-width: 420px) { .code { font-size: 24px; padding: 12px 14px; } }
    </style>
  </head>
  <body>
    <div style="display:none;max-height:0;overflow:hidden">${preheader}</div>
    <div class="email-wrapper">
      <div class="card">
        <div class="brand">${appName}</div>
        <h1>Your verification code</h1>
        <p class="muted">Use the code below to verify your email address.</p>
        <div style="margin:18px 0;text-align:left;"><span class="code">${String(code)}</span></div>
        <p class="muted">This code expires in ${expiresMinutes} minute${expiresMinutes === 1 ? '' : 's'}.</p>
        <p>If you did not request this code, you can safely ignore this email or contact <a class="support" href="mailto:${supportEmail}">${supportEmail}</a>.</p>
        <div class="footer">If you're having trouble, reply to this email and we'll help.</div>
      </div>
    </div>
  </body>
  </html>`;

  const text = `Your verification code is ${code}. It expires in ${expiresMinutes} minute${expiresMinutes === 1 ? '' : 's'}.

If you did not request this, ignore this email or contact ${supportEmail}.`;

  return { subject, html, text };
}

export default verificationEmail;
