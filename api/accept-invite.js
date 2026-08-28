// /api/accept-invite.js

import { requireAuth, serviceHeaders, isValidUuid } from './_auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;

// Same whitelist invite.js itself enforces when creating the invite — never
// trust the "owner" role here even if it appears to come from an
// invite.js-set field, because Supabase's user_metadata is editable by the
// signed-in user themselves via the client SDK (auth.updateUser({data:...})).
// Clamping this server-side is what actually closes the escalation, not
// just moving the write off the client.
const VALID_ROLES = ['head_chef', 'sous_chef', 'chef'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller — the invite sign-in itself already proved they control
  // the invited email address (Supabase issued this JWT via the invite link)
  const user = await requireAuth(req, res);
  if (!user) return;

  const { fullName } = req.body || {};
  if (!fullName) return res.status(400).json({ error: 'Full name required' });

  const meta = user.user_metadata || {};
  const role = VALID_ROLES.includes(meta.role) ? meta.role : 'chef';
  const companyId = meta.company_id;
  const companyName = meta.company_name || '';

  if (!companyId || !isValidUuid(companyId)) {
    return res.status(400).json({ error: 'Invalid or missing invite data. Please ask your team owner to resend the invite.' });
  }

  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        full_name: fullName,
        company_name: companyName,
        company_id: companyId,
        role: role,
        scans_used: 0,
        billing_start_date: new Date().toISOString().split('T')[0]
      })
    });

    if (!profileRes.ok) {
      const errText = await profileRes.text();
      console.error('accept-invite: failed to create profile', profileRes.status, errText, { userId: user.id, companyId });
      return res.status(502).json({ error: 'Could not finish setting up your account. Please try again or contact support.' });
    }

    // Mark the invite accepted — best-effort, the profile write above is
    // what actually matters so a failure here isn't fatal to the signup.
    if (user.email) {
      await fetch(`${SUPABASE_URL}/rest/v1/invites?email=eq.${encodeURIComponent(user.email)}`, {
        method: 'PATCH',
        headers: serviceHeaders,
        body: JSON.stringify({ accepted: true })
      }).catch(e => console.error('accept-invite: failed to mark invite accepted', e.message));
    }

    return res.status(200).json({ success: true, company_id: companyId, role: role });
  } catch (e) {
    console.error('accept-invite error:', e);
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
