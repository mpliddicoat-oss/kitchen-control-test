// /api/_auth.js — shared auth helpers (not a route, prefixed with _)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const serviceHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
};

/**
 * Verifies the Bearer JWT from the request and returns the Supabase user.
 * Returns { user } on success, or sends a 401 and returns null.
 */
export async function requireAuth(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!r.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const user = await r.json();
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return user;
}

/**
 * Fetches the caller's profile (role, company_id etc.) using the service key.
 */
export async function getCallerProfile(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}&select=user_id,role,company_id,full_name,company_name,stripe_customer_id,scans_used,subscription_status`,
    { headers: serviceHeaders }
  );
  const rows = await r.json();
  return (rows && rows[0]) || null;
}

/**
 * Asserts the caller is an owner. Sends 403 and returns false if not.
 */
export function requireOwner(profile, res) {
  if (!profile || profile.role !== 'owner') {
    res.status(403).json({ error: 'Owner access required' });
    return false;
  }
  return true;
}

/**
 * Asserts the target user is in the same company as the caller.
 * Sends 403 and returns false if not.
 */
export async function requireSameCompany(callerProfile, targetUserId, res) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${targetUserId}&select=company_id`,
    { headers: serviceHeaders }
  );
  const rows = await r.json();
  const targetCompanyId = rows && rows[0] && rows[0].company_id;

  if (!targetCompanyId || targetCompanyId !== callerProfile.company_id) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}
