// /api/_demo.js — helpers for anonymous demo scan requests
// In-memory IP rate limiting. Resets when the serverless instance recycles,
// which is fine — it only needs to stop a single visitor hammering the endpoint.

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PER_IP = 20;                  // generous: real demo users need 3+3

const _hits = new Map(); // ip -> { count, resetAt }

export function isDemoRequest(req) {
  const h = req.headers['x-kc-demo'];
  const bodyFlag = req.body && req.body.demo === true;
  return h === '1' || h === 'true' || bodyFlag === true;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns { ok: true } if under the limit (and records the hit),
 * or { ok: false, retryAfter } if the IP has exceeded the daily demo cap.
 */
export function checkDemoRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let entry = _hits.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
  }

  if (entry.count >= MAX_PER_IP) {
    _hits.set(ip, entry);
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  _hits.set(ip, entry);
  return { ok: true, remaining: MAX_PER_IP - entry.count };
}
