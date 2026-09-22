// /api/check-access.js
// Returns whether the caller's account currently has access to the app.
// This has to be a server-side check rather than a client-side read of the
// caller's own profile row: team members' access is governed by their
// company owner's subscription, not their own (which accept-invite.js
// never sets), so answering this correctly means looking up the owner's
// status too — see getEffectiveSubscriptionStatus in _auth.js.

import { requireAuth, getCallerProfile, getEffectiveSubscriptionStatus, isSubscriptionBlocked } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  const profile = await getCallerProfile(user.id);
  if (!profile) {
    // No profile yet (e.g. init-user hasn't run for this session yet) —
    // fail open, same reasoning as everywhere else in this check: an
    // unknown state must never turn into an accidental lockout.
    return res.status(200).json({ allowed: true });
  }

  const status = await getEffectiveSubscriptionStatus(profile);
  return res.status(200).json({ allowed: !isSubscriptionBlocked(status) });
}
