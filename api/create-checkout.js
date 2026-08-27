// /api/create-checkout.js
// Supports two modes:
// 1. Signup mode: userId + email passed in body, verified server-side via service key
// 2. Authenticated mode: JWT in Authorization header (existing users managing billing)

import { getCallerProfile, serviceHeaders, isValidUuid } from './_auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;

async function verifyUserExists(userId, email) {
  // Reject anything that isn't a real UUID before it ever reaches a Supabase
  // URL — never let unvalidated request input reach an Admin API path.
  if (!isValidUuid(userId)) return null;
  // Confirm this userId actually exists in Supabase auth before trusting it
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: serviceHeaders
  });
  if (!r.ok) return null;
  const user = await r.json();
  // Confirm email matches to prevent ID spoofing
  if (!user || user.email !== email) return null;
  return user;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!STRIPE_SECRET || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  let userId, email, companyName;

  // Mode 1: JWT auth (existing logged-in user)
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    if (r.ok) {
      const user = await r.json();
      if (user && user.id) {
        userId = user.id;
        email = user.email;
        const profile = await getCallerProfile(userId);
        companyName = (profile && profile.company_name) || (req.body && req.body.companyName) || '';
      }
    }
  }

  // Mode 2: Signup mode — userId + email in body, verified server-side
  if (!userId && req.body && req.body.userId && req.body.email) {
    const verified = await verifyUserExists(req.body.userId, req.body.email);
    if (!verified) {
      return res.status(401).json({ error: 'Could not verify user' });
    }
    userId = req.body.userId;
    email = req.body.email;
    companyName = req.body.companyName || '';
  }

  if (!userId || !email) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Check if Stripe customer already exists
    const existingRes = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
    );
    const existing = await existingRes.json();
    const existingCustomer = existing.data && existing.data[0];

    let customer;
    let trialDays = 30;

    if (existingCustomer) {
      customer = existingCustomer;

      // Make sure the customer's metadata always carries the current Supabase
      // user ID. This matters because init-user.js looks the customer up by
      // this ID to reliably attach stripe_customer_id to the right profile —
      // older customers created before this existed won't have it set yet.
      if (!existingCustomer.metadata || existingCustomer.metadata.userId !== userId) {
        const metaParams = new URLSearchParams();
        metaParams.append('metadata[userId]', userId);
        await fetch(`https://api.stripe.com/v1/customers/${existingCustomer.id}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: metaParams.toString()
        }).catch(e => console.error('Failed to refresh customer metadata:', e.message));
      }

      const prevSubsRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${existingCustomer.id}&status=all&limit=5`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      const prevSubs = await prevSubsRes.json();
      if (prevSubs.data && prevSubs.data.length > 0) {
        trialDays = 0;
        console.log('Returning customer — no trial period');
      }
    } else {
      const params = new URLSearchParams();
      params.append('email', email);
      if (companyName) params.append('name', companyName);
      params.append('metadata[userId]', userId);

      const customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
      customer = await customerRes.json();
      if (!customer.id) throw new Error(customer.error?.message || 'Could not create Stripe customer');
    }

    console.log('Customer:', customer.id, 'Trial days:', trialDays);

    const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams([
        ['customer', customer.id],
        ['mode', 'subscription'],
        ['line_items[0][price]', STRIPE_PRICE_ID],
        ['line_items[0][quantity]', '1'],
        ...(trialDays > 0 ? [['subscription_data[trial_period_days]', String(trialDays)]] : []),
        ['success_url', 'https://kitchen-control.co.uk/?checkout=success'],
        ['cancel_url', 'https://kitchen-control.co.uk/signup.html'],
        ['allow_promotion_codes', 'true']
      ]).toString()
    });

    const session = await sessionRes.json();
    if (!session.url) throw new Error(session.error?.message || 'Could not create checkout session');

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e.message);
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
