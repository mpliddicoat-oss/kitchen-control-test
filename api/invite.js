// /api/invite.js

import { requireAuth, getCallerProfile, requireOwner } from './_auth.js';
import { checkRateLimit } from './_ratelimit.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Guards against a compromised/scripted owner session hammering Supabase's
  // invite endpoint (and its outbound email quota) with invite spam.
  const rl = checkRateLimit(req, { max: 20, windowMs: 60 * 60 * 1000, prefix: 'invite' });
  if (!rl.ok) return res.status(429).json({ error: 'Too many requests. Please try again later.' });

  // 1. Verify caller is authenticated
  const user = await requireAuth(req, res);
  if (!user) return;

  // 2. Verify caller is an owner
  const callerProfile = await getCallerProfile(user.id);
  if (!requireOwner(callerProfile, res)) return;

  const { email, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const validRoles = ['head_chef', 'sous_chef', 'chef'];
  const assignedRole = validRoles.includes(role) ? role : 'chef';
  // Owners cannot be invited — only created via signup

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/invite?redirect_to=https://kitchen-control.co.uk/accept-invite.html`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          email,
          data: {
            role: assignedRole,
            company_name: callerProfile.company_name || '',
            company_id: callerProfile.company_id || '',
            invited_by_name: callerProfile.full_name || 'Your team owner'
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.msg || data.message || data.error || 'Invite failed');

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Invite error:', e);
    return res.status(500).json({ error: e.message || 'Invite failed' });
  }
}
