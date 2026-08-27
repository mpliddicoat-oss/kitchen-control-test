// /api/send-email.js
// GET  ?token=xxx  — email open tracking pixel (no auth required)
// POST             — send email (requires authentication)

import { requireAuth } from './_auth.js';
import { sendEmail } from './_email.js';
import { checkRateLimit } from './_ratelimit.js';
import { createClient } from '@supabase/supabase-js';

const ALLOWED_INTERNAL = ['support@kitchen-control.co.uk'];

// 1x1 transparent PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export default async function handler(req, res) {

  // ── GET: tracking pixel ──────────────────────────────────────
  if (req.method === 'GET') {
    const { token } = req.query;

    // Unauthenticated, token-guessable endpoint — cap attempts per IP so it
    // can't be used to brute-force valid unsubscribe tokens at volume. Still
    // always returns the pixel below either way, so email rendering never
    // breaks for a real recipient.
    if (token && checkRateLimit(req, { max: 30, windowMs: 60 * 60 * 1000, prefix: 'track-pixel' }).ok) {
      try {
        const supabase = createClient(
          process.env.supabase_url || process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY || process.env.supabase_service_key
        );
        await supabase
          .from('prospects')
          .update({ opened_at: new Date().toISOString() })
          .eq('unsubscribe_token', token)
          .is('opened_at', null);
      } catch (err) {
        console.error('Track open error:', err.message);
      }
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.status(200).send(PIXEL);
  }

  // ── POST: send email (authenticated) ────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) return res.status(400).json({ error: 'Missing fields' });

  const allowed = [user.email, ...ALLOWED_INTERNAL];
  if (!allowed.includes(to)) {
    return res.status(403).json({ error: 'Forbidden recipient' });
  }

  await sendEmail(to, subject, html);
  return res.status(200).json({ success: true });
}
