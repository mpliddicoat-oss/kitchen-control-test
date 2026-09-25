// /api/cancel-subscription.js

import { requireAuth, getCallerProfile, requireOwner } from './_auth.js';
import { sendEmail, emailHeader, emailFooter, emailButton, escHtml } from './_email.js';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller — userId is taken from the verified session, not request body
  const user = await requireAuth(req, res);
  if (!user) return;

  const profile = await getCallerProfile(user.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // 2. Only the owner holds the company's subscription — a team member has
  // no stripe_customer_id of their own, so without this check this endpoint
  // would silently mark the WRONG account as cancelled (their own row) and
  // send them a misleading "your subscription is cancelled" email, without
  // touching the company's actual Stripe subscription at all.
  if (!requireOwner(profile, res)) return;

  console.log('Cancel subscription: user', user.id, 'stripe_customer_id', profile.stripe_customer_id || 'NONE');

  try {
    // Cancel active Stripe subscriptions at period end
    if (profile.stripe_customer_id && STRIPE_SECRET) {
      // Query both active and trialing subscriptions
      const subsRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${profile.stripe_customer_id}&status=trialing`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      const activeSubs = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${profile.stripe_customer_id}&status=active`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      if (!subsRes.ok || !activeSubs.ok) {
        throw new Error('Could not look up your subscriptions with Stripe. Please try again.');
      }
      const activeData = await activeSubs.json();
      const subs = await subsRes.json();
      // Merge trialing and active subscriptions
      const allSubs = [...(subs.data || []), ...(activeData.data || [])];

      if (allSubs.length > 0) {
        for (const sub of allSubs) {
          const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${STRIPE_SECRET}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'cancel_at_period_end=true'
          });
          if (!cancelRes.ok) {
            throw new Error(`Stripe would not cancel subscription ${sub.id}. Please try again or contact support.`);
          }
        }
      }
    }

    // Deliberately NOT writing subscription_status/deletion_date here. Stripe
    // was told cancel_at_period_end=true above, so the subscription (and
    // this account's access) stays genuinely active until the paid period
    // actually ends -- exactly what the email below promises. The real
    // transition to 'cancelled' (and the 90-day deletion_date) is handled
    // by stripe-webhook.js's customer.subscription.deleted handler, which
    // only fires once Stripe actually ends the subscription at period end.
    // Setting it here too, immediately, used to cut off access (and start
    // the deletion clock) the moment someone clicked Cancel -- mid-billing-
    // period, while they were still a paying customer with unused access
    // and a broken promise sitting right there in this same email.

    const name = escHtml(profile.full_name || 'Chef');

    // Send cancellation email directly via shared utility
    await sendEmail(
      user.email,
      'Your Kitchen Control subscription has been cancelled',
      `${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Subscription cancelled</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Your Kitchen Control subscription has been cancelled. You will retain full access until the end of your current billing period.</p>
<div style="background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:20px 0;">
  <p style="color:#dc2626;font-size:14px;font-weight:700;margin:0 0 6px;">Your data will be permanently deleted 90 days after your billing period ends.</p>
  <p style="color:#dc2626;font-size:13px;margin:0;">If you change your mind and resubscribe before then, your data will be restored.</p>
</div>
<p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 16px;">We're sorry to see you go. If there's anything we could have done better please email <a href="mailto:support@kitchen-control.co.uk" style="color:#7fbf3f;">support@kitchen-control.co.uk</a></p>
${emailButton('Resubscribe', 'https://kitchen-control.co.uk')}
${emailFooter()}`
    );

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('cancel-subscription error:', e.message);
    return res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
}
