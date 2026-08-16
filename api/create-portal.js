// /api/create-portal.js

import { requireAuth, getCallerProfile } from './_auth.js';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller is authenticated
  const user = await requireAuth(req, res);
  if (!user) return;

  // 2. Get stripe_customer_id from their profile — don't trust the request body
  const profile = await getCallerProfile(user.id);
  const customerId = profile && profile.stripe_customer_id;

  if (!customerId) {
    return res.status(400).json({ error: 'No billing account found. Please set up your subscription first.' });
  }

  try {
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        customer: customerId,
        return_url: 'https://kitchen-control.co.uk/'
      })
    });
    const portal = await portalRes.json();
    if (!portal.url) throw new Error(portal.error?.message || 'Could not create portal session');
    return res.status(200).json({ url: portal.url });
  } catch (e) {
    console.error('create-portal error:', e.message);
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
