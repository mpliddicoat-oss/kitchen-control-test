// /api/cancel-subscription.js

import { requireAuth, getCallerProfile, serviceHeaders } from './_auth.js';
import { sendEmail, emailHeader, emailFooter, emailButton } from './_email.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify caller — userId is taken from the verified session, not request body
  const user = await requireAuth(req, res);
  if (!user) return;

  const profile = await getCallerProfile(user.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

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
      const activeData = await activeSubs.json();
      const subs = await subsRes.json();
      // Merge trialing and active subscriptions
      const allSubs = [...(subs.data || []), ...(activeData.data || [])];

      if (allSubs.length > 0) {
        for (const sub of allSubs) {
          await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${STRIPE_SECRET}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'cancel_at_period_end=true'
          });
        }
      }
    }

    // Mark cancelled in Supabase
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 90);
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}`, {
      method: 'PATCH',
      headers: serviceHeaders,
      body: JSON.stringify({
        subscription_status: 'cancelled',
        deletion_date: deletionDate.toISOString().split('T')[0]
      })
    });

    const name = profile.full_name || 'Chef';

    // Send cancellation email directly via shared utility
    await sendEmail(
      user.email,
      'Your Kitchen Control subscription has been cancelled',
      `${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Subscription cancelled</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Your Kitchen Control subscription has been cancelled. You will retain access until the end of your current billing period.</p>
<div style="background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:20px 0;">
  <p style="color:#dc2626;font-size:14px;font-weight:700;margin:0 0 6px;">Your data will be permanently deleted in 90 days.</p>
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
