// api/_lib/session.js
// Shared by api/auth.js and api/sync.js. Files/folders starting with "_" under api/ aren't
// treated as routes by Vercel — this is just an importable helper, not a public endpoint.
//
// Token format: base64url(profile + '.' + expiresAtMs) + '.' + hex(HMAC-SHA256 of that
// payload, keyed with SESSION_SECRET). Deliberately hand-rolled instead of pulling in a JWT
// library — this app only ever needs "is this a real profile, and has it expired," so a
// plain HMAC token keeps this dependency-free and easy to audit line-by-line, rather than
// bringing in machinery for JWT features (claims, key rotation, multiple issuers) this app
// has no use for.

const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days. Long-lived on purpose — this is
// what actually fixes the "logged out constantly" problem Umang was hitting with Google's
// ~1hr access tokens. Re-entering a password once a month is a reasonable ask; every hour was not.

function sign(payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}

// Constant-time comparison — a plain === leaks timing information proportional to how many
// leading characters match, which is a real (if minor) attack vector for password/token
// checks. crypto.timingSafeEqual needs equal-length buffers, hence the length check first
// (a length mismatch is itself safe to reveal via early return — it doesn't leak *which*
// characters are right).
function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueToken(profile) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${profile}.${expiresAt}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  return { token, expiresAt };
}

// Returns 'umang' | 'chetna' if the token is validly signed and unexpired, otherwise null.
// This function is the entire access-control boundary for /api/sync — every check below
// (bad format, bad signature, expired, unrecognized profile) returns the same null rather
// than a specific reason, so a caller probing the endpoint can't learn which part failed.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  let payload;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  if (!safeEqual(signature, sign(payload))) return null;
  const [profile, expiresAtStr] = payload.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  if (profile !== 'umang' && profile !== 'chetna') return null;
  return profile;
}

module.exports = { issueToken, verifyToken, safeEqual, SESSION_TTL_MS };
