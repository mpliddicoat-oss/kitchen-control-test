// /api/change-role.js

import { requireAuth, getCallerProfile, requireOwner, requireSameCompany, serviceHeaders, isValidUuid } from './_auth.js';
import { sendEmail, emailHeader, emailFooter, emailButton, escHtml } from './_email.js';

const SUPABASE_URL = process.env.SUPABASE_URL;

const roleLabels = { owner: 'Owner', head_chef: 'Head Chef', sous_chef: 'Sous Chef', chef: 'Chef' };
const validRoles = ['owner', 'head_chef', 'sous_chef', 'chef'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller is authenticated
  const user = await requireAuth(req, res);
  if (!user) return;

  // 2. Verify caller is an owner
  const callerProfile = await getCallerProfile(user.id);
  if (!requireOwner(callerProfile, res)) return;

  const { targetUserId, newRole } = req.body || {};
  if (!targetUserId || !newRole) return res.status(400).json({ error: 'Missing fields' });
  if (!isValidUuid(targetUserId)) return res.status(400).json({ error: 'Invalid targetUserId' });
  if (!validRoles.includes(newRole)) return res.status(400).json({ error: 'Invalid role' });

  // 3. Verify target is in the same company
  if (!await requireSameCompany(callerProfile, targetUserId, res)) return;

  // Prevent demoting/changing self — owner must transfer ownership separately
  if (targetUserId === user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  try {
    // Update role
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${targetUserId}`, {
      method: 'PATCH',
      headers: serviceHeaders,
      body: JSON.stringify({ role: newRole })
    });
    if (!updateRes.ok) {
      const data = await updateRes.json();
      throw new Error(data.message || 'Update failed');
    }

    // Fetch target user's email and profile for the notification
    const [profileRes, userRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${targetUserId}&select=full_name,company_name`, { headers: serviceHeaders }),
      fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, { headers: serviceHeaders })
    ]);
    const profiles = await profileRes.json();
    const userData = await userRes.json();
    const profile = profiles && profiles[0];
    const email = userData && userData.email;
    const name = escHtml((profile && profile.full_name) || 'there');
    const company = escHtml((profile && profile.company_name) || 'your team');
    const roleLabel = roleLabels[newRole] || newRole;

    // Send notification directly via shared utility (no self-calling HTTP)
    await sendEmail(
      email,
      `Your Kitchen Control role has been updated to ${roleLabel}`,
      `${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Your role has been updated</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 20px;">Your role in <strong>${company}</strong> on Kitchen Control has been updated.</p>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin:20px 0;text-align:center;">
  <div style="font-size:13px;color:#6b7280;margin-bottom:8px;">Your new role</div>
  <div style="font-size:24px;font-weight:700;color:#16222c;">${roleLabel}</div>
</div>
<p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 20px;">If you have any questions please speak to your team owner or manager.</p>
${emailButton('Open Kitchen Control', 'https://kitchen-control.co.uk')}
${emailFooter()}`
    );

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('change-role error:', e);
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
