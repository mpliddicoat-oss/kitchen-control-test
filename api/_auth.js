// /api/_auth.js — shared auth helpers (not a route, prefixed with _)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const serviceHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only if the value is a well-formed UUID (Supabase user/profile IDs
 * always are). Reject anything else before it ever reaches a Supabase URL —
 * a value built from unvalidated request input must never be interpolated
 * into an Admin API path or REST filter without this check first.
 */
export function isValidUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

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

// Statuses that positively mean "no active subscription". A denylist rather
// than an allowlist deliberately: a status we don't recognise (a future
// Stripe status, or a profile predating this column) must fail open, not
// silently start blocking real customers.
export const BLOCKED_SUBSCRIPTION_STATUSES = ['incomplete', 'incomplete_expired', 'canceled', 'cancelled', 'unpaid', 'paused'];

/**
 * Returns the profile row that actually governs this account's billing —
 * its own profile if the caller IS the owner, otherwise the company
 * owner's profile, looked up via companies.owner_id. Kitchen Control bills
 * one subscription AND one shared scan quota per company, held by the
 * owner, not per user — a team member added via accept-invite.js never
 * gets a real subscription_status (it's simply never set on that profile),
 * and their own scans_used starts at 0 independently of everyone else's,
 * so anything that reads a non-owner's own row directly either
 * under-reports usage or over-reports access. Every check that needs to
 * know "does this company have an active subscription" or "how many scans
 * has this company used this month" must resolve to this same row.
 * Falls back to the caller's own profile if the owner can't be resolved,
 * so a lookup error fails open rather than blocking access outright.
 */
export async function getBillingProfile(profile) {
  if (!profile) return null;
  if (profile.role === 'owner' || !profile.company_id) return profile;

  try {
    const companyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/companies?id=eq.${profile.company_id}&select=owner_id`,
      { headers: serviceHeaders }
    );
    const companyRows = await companyRes.json();
    const ownerId = companyRows && companyRows[0] && companyRows[0].owner_id;
    if (!ownerId) return profile;

    const ownerRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${ownerId}&select=user_id,role,company_id,subscription_status,scans_used,stripe_customer_id`,
      { headers: serviceHeaders }
    );
    const ownerRows = await ownerRes.json();
    const ownerProfile = ownerRows && ownerRows[0];
    return ownerProfile || profile;
  } catch (e) {
    console.error('getBillingProfile error:', e.message);
    return profile;
  }
}

/**
 * Returns the subscription status that should actually govern this
 * caller's access — see getBillingProfile for why this can't just be
 * profile.subscription_status for a non-owner.
 */
export async function getEffectiveSubscriptionStatus(profile) {
  const billing = await getBillingProfile(profile);
  return billing ? billing.subscription_status : null;
}

/**
 * True if this status positively means no active subscription.
 */
export function isSubscriptionBlocked(status) {
  return !!(status && BLOCKED_SUBSCRIPTION_STATUSES.indexOf(status) !== -1);
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
