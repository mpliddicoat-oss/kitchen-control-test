// /api/init-user.js

import { requireAuth, serviceHeaders } from './_auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

// Find the Stripe customer that belongs to this Supabase user.
// Checkout always creates/finds the customer BEFORE this endpoint ever runs
// (the browser redirects here only after Stripe checkout completes), so the
// customer is guaranteed to already exist by the time we look for it.
async function findStripeCustomerId(userId, email) {
  if (!STRIPE_SECRET) return null;
  try {
    // Primary: List customers by email. This hits Stripe's live database
    // directly and is immediately consistent — important right after checkout,
    // since the Search API below can lag a few seconds before it's queryable.
    if (email) {
      const byEmail = await fetch(
        `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      const emailData = await byEmail.json();
      if (emailData.data && emailData.data[0]) return emailData.data[0].id;
    }
    // Fallback: Search API by the userId stamped into the customer's metadata
    // at checkout time (see create-checkout.js). Used only if the email lookup
    // above didn't find anything.
    const byMeta = await fetch(
      `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`metadata['userId']:'${userId}'`)}`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
    );
    const metaData = await byMeta.json();
    if (metaData.data && metaData.data[0]) return metaData.data[0].id;
  } catch (e) {
    console.error('findStripeCustomerId error:', e.message);
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller — userId comes from verified session
  const user = await requireAuth(req, res);
  if (!user) return;

  const { fullName, companyName } = req.body || {};
  if (!fullName || !companyName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // Pull the "how did you hear about us" answer set at signup, if any.
  const referralSource = (user.user_metadata && user.user_metadata.referral_source) || null;

  try {
    // Check if profile already exists with a company_id
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}&select=user_id,company_id,stripe_customer_id`,
      { headers: serviceHeaders }
    );
    const existing = await checkRes.json();

    if (existing && existing.length > 0 && existing[0].company_id) {
      // Profile already exists. If it's still missing its Stripe link — e.g.
      // the checkout webhook fired before this profile was ever created — fill
      // it in now rather than leaving it permanently blank.
      if (!existing[0].stripe_customer_id) {
        const stripeId = await findStripeCustomerId(user.id, user.email);
        if (stripeId) {
          await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}`, {
            method: 'PATCH',
            headers: serviceHeaders,
            body: JSON.stringify({ stripe_customer_id: stripeId })
          }).catch(e => console.error('Failed to backfill stripe_customer_id:', e.message));
        }
      }
      return res.status(200).json({ company_id: existing[0].company_id, created: false });
    }

    // Create company record
    const compRes = await fetch(`${SUPABASE_URL}/rest/v1/companies`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: companyName, owner_id: user.id })
    });
    const compData = await compRes.json();
    const companyId = Array.isArray(compData) ? compData[0]?.id : compData?.id;

    // Look up the Stripe customer created during checkout so the link is saved
    // on the very first write — this is the piece that was previously missing.
    const stripeCustomerId = await findStripeCustomerId(user.id, user.email);

    // Create or update profile
    await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: user.id,
        full_name: fullName,
        company_name: companyName,
        company_id: companyId || null,
        role: 'owner',
        scans_used: 0,
        subscription_status: 'trialing',
        stripe_customer_id: stripeCustomerId,
        referral_source: referralSource,
        billing_start_date: new Date().toISOString().split('T')[0]
      })
    });

    return res.status(200).json({ company_id: companyId, created: true });
  } catch (e) {
    console.error('init-user error:', e);
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
