// /api/_ratelimit.js — generic in-memory per-IP rate limiter.
// Resets when the serverless instance recycles and isn't shared across
// concurrent instances — the same accepted limitation as _demo.js. This
// exists to blunt casual abuse and brute-forcing on unauthenticated
// endpoints, not to be a hard distributed-systems guarantee.

const _buckets = new Map(); // "prefix:ip" -> { count, resetAt }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns { ok: true } if under the limit (and records the hit), or
 * { ok: false, retryAfter } if this key has exceeded max hits within windowMs.
 */
export function checkRateLimit(req, { max, windowMs, prefix }) {
  const ip = clientIp(req);
  const key = `${prefix}:${ip}`;
  const now = Date.now();
  let entry = _buckets.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
  }

  if (entry.count >= max) {
    _buckets.set(key, entry);
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  _buckets.set(key, entry);
  return { ok: true };
}
