import { sendEmail, emailHeader, emailFooter, emailButton } from './_email.js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_EMAIL = 'matt@kitchen-control.co.uk';

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
  };

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  // Standard Stripe replay-protection window — reject anything signed more
  // than 5 minutes ago, so a captured (payload, signature) pair can't be
  // resent indefinitely to re-trigger the effects below (e.g. resetting
  // scans_used via a replayed invoice.payment_succeeded).
  const TOLERANCE_SECONDS = 300;

  let event;
  try {
    const { createHmac, timingSafeEqual } = await import('crypto');
    const parts = sig.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
    const v1 = parts.find(p => p.startsWith('v1=')).split('=')[1];

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
      console.error('Webhook timestamp outside tolerance window:', timestamp);
      return res.status(400).json({error:'Timestamp outside tolerance'});
    }

    const payload = `${timestamp}.${rawBody.toString()}`;
    const expected = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(v1, 'hex');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      console.error('Invalid webhook signature');
      return res.status(400).json({error:'Invalid signature'});
    }
    event = JSON.parse(rawBody.toString());
  } catch(e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).json({error:'Webhook error: ' + e.message});
  }

  const eventObj = event.data && event.data.object;
  console.log('Stripe webhook event:', event.type);

  async function getCustomerEmail(customerId) {
    if(!customerId || !STRIPE_SECRET) return null;
    try {
      const r = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
      });
      const data = await r.json();
      return data.email || null;
    } catch(e) {
      console.error('getCustomerEmail error:', e.message);
      return null;
    }
  }

  // Look up profile by stripe_customer_id first (most reliable), then by email
  async function getProfile(email, customerId) {
    try {
      if(customerId) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=*`, {
          headers: supabaseHeaders
        });
        const profiles = await r.json();
        if(profiles && profiles[0]) {
          console.log('Profile found by stripe_customer_id:', profiles[0].full_name);
          return { ...profiles[0], email: profiles[0].email || email };
        }
      }
      if(email) {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1&filter=${encodeURIComponent(email)}`, {
          headers: supabaseHeaders
        });
        const userData = await r.json();
        const user = userData && userData.users && userData.users[0];
        if(user) {
          const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}&select=*`, {
            headers: supabaseHeaders
          });
          const profiles = await profileRes.json();
          if(profiles && profiles[0]) {
            console.log('Profile found by email:', profiles[0].full_name);
            return { ...profiles[0], email };
          }
        }
      }
      console.log('No profile found, using fallback');
      return { email, full_name: null, company_name: null, user_id: null };
    } catch(e) {
      console.error('getProfile error:', e.message);
      return { email, full_name: null, company_name: null, user_id: null };
    }
  }

  async function updateProfile(userId, data) {
    if(!userId) return;
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: supabaseHeaders,
      body: JSON.stringify(data)
    });
  }

  try {
    switch(event.type) {

      case 'customer.subscription.trial_will_end': {
        const customerId = eventObj.customer;
        const email = await getCustomerEmail(customerId);
        const profile = await getProfile(email, customerId);
        const name = (profile && profile.full_name) || 'Chef';
        const trialEnd = new Date(eventObj.trial_end * 1000).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'});
        console.log('Trial ending for:', name, email);

        await sendEmail(email, 'Your Kitchen Control trial ends in 3 days', `
${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Your trial ends soon</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Your Kitchen Control free trial ends on <strong>${trialEnd}</strong>. After that your subscription will automatically continue at <strong>£12.99/month</strong>.</p>
<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px 20px;margin:20px 0;">
<p style="color:#92400e;font-size:14px;margin:0;">If you do not want to continue, cancel before ${trialEnd} and you will not be charged.</p>
</div>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">If you are happy with Kitchen Control, nothing to do — your subscription continues automatically.</p>
${emailButton('Manage Subscription', 'https://kitchen-control.co.uk')}
${emailFooter()}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const customerId = eventObj.customer;
        const email = await getCustomerEmail(customerId);
        const profile = await getProfile(email, customerId);
        const name = (profile && profile.full_name) || 'Chef';
        const reason = eventObj.cancellation_details?.reason || 'cancelled';

        if(profile && profile.user_id) {
          const deletionDate = new Date();
          deletionDate.setDate(deletionDate.getDate() + 90);
          await updateProfile(profile.user_id, {
            subscription_status: 'cancelled',
            deletion_date: deletionDate.toISOString().split('T')[0]
          });
        }

        // Remove from the newsletter list
        if(email) {
          await fetch(`${SUPABASE_URL}/rest/v1/newsletter_subscribers?email=eq.${encodeURIComponent(email)}`, {
            method: 'PATCH',
            headers: supabaseHeaders,
            body: JSON.stringify({
              unsubscribed: true,
              unsubscribed_at: new Date().toISOString()
            })
          }).catch(e => console.error('webhook: failed to unsubscribe from newsletter', e.message));
        }

        await sendEmail(email, 'Your Kitchen Control subscription has ended', `
${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Your subscription has ended</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Your Kitchen Control subscription has ended. Your data will be retained for <strong>90 days</strong> before being permanently deleted.</p>
<div style="background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:20px 0;">
<p style="color:#dc2626;font-size:14px;margin:0;">Your account access has been suspended. Resubscribe to regain access to your data.</p>
</div>
${emailButton('Resubscribe Now', 'https://kitchen-control.co.uk')}
${emailFooter()}`);

        await sendEmail(ADMIN_EMAIL, `Subscription cancelled: ${name} (${email})`, `
${emailHeader()}
<h2 style="color:#16222c;margin:0 0 16px;">Subscription Cancelled</h2>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Customer:</strong> ${name}</p>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Email:</strong> ${email}</p>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Reason:</strong> ${reason}</p>
<p style="color:#374151;font-size:15px;margin:0;"><strong>Data deletion:</strong> 90 days from today</p>
${emailFooter()}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = eventObj;
        if(invoice.billing_reason === 'subscription_create') break;
        if(invoice.amount_paid === 0) break;
        const email = invoice.customer_email || await getCustomerEmail(invoice.customer);
        if(!email) break;
        const profile = await getProfile(email, invoice.customer);
        const name = (profile && profile.full_name) || 'Chef';
        const amount = `£${(invoice.amount_paid / 100).toFixed(2)}`;
        const date = new Date(invoice.created * 1000).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'});
        const invoiceUrl = invoice.hosted_invoice_url || 'https://kitchen-control.co.uk';
        console.log('Payment succeeded for:', name, email, amount);

        if(profile && profile.user_id) {
          await updateProfile(profile.user_id, {
            scans_used: 0,
            subscription_status: 'active',
            billing_start_date: new Date().toISOString().split('T')[0]
          });
        }

        await sendEmail(email, `Payment confirmed — ${amount} Kitchen Control`, `
${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Payment confirmed</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Your Kitchen Control subscription has been renewed.</p>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0;">
<p style="color:#166534;font-size:14px;font-weight:700;margin:0 0 6px;">Payment summary</p>
<p style="color:#166534;font-size:14px;margin:0 0 4px;">Amount: <strong>${amount}</strong></p>
<p style="color:#166534;font-size:14px;margin:0;">Date: ${date}</p>
</div>
<p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 16px;">Your scan counter has been reset for the new billing period. You have 1,000 scans available.</p>
${emailButton('View Invoice', invoiceUrl)}
${emailFooter()}`);

        await sendEmail(ADMIN_EMAIL, `Payment received: ${amount} from ${name} (${email})`, `
${emailHeader()}
<h2 style="color:#16222c;margin:0 0 16px;">Payment Received</h2>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Customer:</strong> ${name}</p>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Email:</strong> ${email}</p>
<p style="color:#374151;font-size:15px;margin:0;"><strong>Amount:</strong> ${amount}</p>
${emailFooter()}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = eventObj;
        const email = invoice.customer_email || await getCustomerEmail(invoice.customer);
        const profile = await getProfile(email, invoice.customer);
        const name = (profile && profile.full_name) || 'Chef';
        const attempt = invoice.attempt_count || 1;

        await sendEmail(email, 'Payment failed — action required', `
${emailHeader()}
<h1 style="color:#dc2626;font-size:24px;font-weight:700;margin:0 0 16px;">Payment failed</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">We were unable to process your Kitchen Control payment (attempt ${attempt} of 3).</p>
<div style="background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:20px 0;">
<p style="color:#dc2626;font-size:14px;margin:0;">Please update your payment details to avoid losing access to Kitchen Control.</p>
</div>
${emailButton('Update Payment Details', 'https://kitchen-control.co.uk')}
${emailFooter()}`);
        break;
      }

      case 'customer.source.expiring':
      case 'payment_method.expiring': {
        const email = await getCustomerEmail(eventObj.customer);
        const profile = await getProfile(email, eventObj.customer);
        const name = (profile && profile.full_name) || 'Chef';

        await sendEmail(email, 'Your card is expiring soon', `
${emailHeader()}
<h1 style="color:#16222c;font-size:24px;font-weight:700;margin:0 0 16px;">Your card is expiring</h1>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">The card on your Kitchen Control account is expiring soon.</p>
<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px 20px;margin:20px 0;">
<p style="color:#92400e;font-size:14px;margin:0;">Please update your payment details before your next billing date to avoid any interruption.</p>
</div>
${emailButton('Update Card Details', 'https://kitchen-control.co.uk')}
${emailFooter()}`);
        break;
      }

      case 'checkout.session.completed': {
        const session = eventObj;
        const email = session.customer_email || await getCustomerEmail(session.customer);
        const profile = await getProfile(email, session.customer);
        const name = (profile && profile.full_name) || 'New user';
        const company = (profile && profile.company_name) || 'Unknown';
        console.log('New subscriber:', name, email, company);

        if(profile && profile.user_id && session.customer) {
          await updateProfile(profile.user_id, {
            stripe_customer_id: session.customer,
            subscription_status: 'trialing'
          });
        }

        await sendEmail(ADMIN_EMAIL, `New subscriber: ${name} — ${company}`, `
${emailHeader()}
<h2 style="color:#16222c;margin:0 0 16px;">New Subscriber!</h2>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Name:</strong> ${name}</p>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Email:</strong> ${email}</p>
<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Company:</strong> ${company}</p>
<p style="color:#374151;font-size:15px;margin:0;"><strong>Stripe customer:</strong> ${session.customer}</p>
${emailFooter()}`);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }
  } catch(e) {
    console.error('Webhook handler error:', e.message);
  }

  // Return 200 after processing so Vercel doesn't kill the function early
  return res.status(200).json({ received: true });
}
