// /api/_email.js — shared transporter, avoids self-calling HTTP pattern

import { createTransport } from 'nodemailer';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = createTransport({
    host: process.env.SMTP_HOST,
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return _transporter;
}

/**
 * Send an email. Logs but does NOT throw on failure — callers should not
 * fail a user action because an email didn't send.
 */
export async function sendEmail(to, subject, html) {
  if (!to || !process.env.SMTP_HOST) {
    console.warn('sendEmail: missing recipient or SMTP config');
    return;
  }
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"Kitchen Control" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html
    });
    console.log('Email sent:', subject, '->', to);
  } catch (e) {
    console.error('sendEmail failed:', e.message);
  }
}

// ── Shared template helpers ──────────────────────────────────────────────────

/**
 * Escape a value before interpolating it into an email's HTML body. Names
 * and company names are free text set by the account holder at signup —
 * without this, a company name containing an <a> tag rides along into
 * every later transactional email sent from our own domain.
 */
export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function emailHeader() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
<tr><td style="background:#16222c;border-radius:12px 12px 0 0;padding:24px 32px;text-align:center;">
<img src="https://kitchen-control.co.uk/logo.png" alt="Kitchen Control" style="height:40px;width:auto;display:block;margin:0 auto;">
</td></tr>
<tr><td style="background:#ffffff;padding:40px 32px;">`;
}

export function emailFooter() {
  return `</td></tr>
<tr><td style="background:#16222c;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
<p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0;">Kitchen Control &copy; 2026 &middot;
<a href="mailto:support@kitchen-control.co.uk" style="color:rgba(255,255,255,0.4);text-decoration:none;">support@kitchen-control.co.uk</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

export function emailButton(text, url) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
<tr><td style="background:#7fbf3f;border-radius:8px;text-align:center;">
<a href="${url}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${text}</a>
</td></tr></table>`;
}
