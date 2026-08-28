// /api/_ratelimit.js — generic in-memory per-IP rate limiter.
// Resets when the serverless instance recycles and isn't shared across
// concurrent instances — the same accepted limitation as _demo.js. This
// exists to blunt casual abuse and brute-forcing on unauthenticated
// endpoints, not to be a hard distributed-systems guarantee.

const _buckets = new Map(); // "prefix:ip" -> { count, resetAt }

function clientIp(req) {
  // Prefer x-real-ip: Vercel's edge network sets this from the actual TCP
  // connection, overwriting any client-supplied value, whereas the FIRST
  // entry of x-forwarded-for is client-controlled/spoofable — a request can
  // just prepend a fake IP to that header. Falls back to the last entry of
  // x-forwarded-for (closest hop to us) rather than the first. Exact proxy
  // semantics aren't independently verifiable from this environment, so
  // this is a best-effort hardening, not a hard guarantee.
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const parts = String(fwd).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
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
