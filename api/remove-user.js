// /api/remove-user.js

import { requireAuth, getCallerProfile, requireOwner, requireSameCompany, serviceHeaders, isValidUuid } from './_auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller is authenticated
  const user = await requireAuth(req, res);
  if (!user) return;

  // 2. Verify caller is an owner
  const callerProfile = await getCallerProfile(user.id);
  if (!requireOwner(callerProfile, res)) return;

  const { targetUserId } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (!isValidUuid(targetUserId)) return res.status(400).json({ error: 'Invalid targetUserId' });

  // 3. Cannot remove yourself
  if (targetUserId === user.id) {
    return res.status(400).json({ error: 'Cannot remove yourself. Cancel your subscription instead.' });
  }

  // 4. Target must be in the same company
  if (!await requireSameCompany(callerProfile, targetUserId, res)) return;

  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  try {
    // Delete profile first (FK constraint), then auth user — checked, since
    // proceeding to delete the auth user after a failed profile delete would
    // leave an orphaned auth user with no profile.
    const profileDelRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${targetUserId}`, {
      method: 'DELETE',
      headers: serviceHeaders
    });
    if (!profileDelRes.ok) {
      const errText = await profileDelRes.text().catch(() => '');
      throw new Error(`Could not delete profile (${profileDelRes.status}): ${errText}`);
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, {
      method: 'DELETE',
      headers: serviceHeaders
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.msg || data.message || 'Could not delete user');
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Remove user error:', e);
    return res.status(500).json({ error: e.message || 'Could not remove user' });
  }
}
