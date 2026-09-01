// api/firebase-token.js
// Mints a Firebase custom token for an ALREADY-authenticated session.
//
// Why this endpoint exists at all (it is not in the migration plan):
//   /api/auth only runs on a fresh password login. index.html's init() restores a saved
//   session straight from localStorage (loadAppSession() → S.appSession → initAfterLogin())
//   and never calls /api/auth again for the whole 30-day token TTL. So if the Firebase
//   custom token were only minted in /api/auth, the overwhelming majority of app opens —
//   every one that isn't a fresh login — would have no Firebase identity at all.
//   This endpoint closes that hole: the client posts its existing HMAC bearer token and
//   gets a fresh Firebase custom token back.
//
// Firebase custom tokens are valid for 1 hour, but that only bounds the sign-IN window —
// once signInWithCustomToken() succeeds the SDK holds its own session and silently
// refreshes the underlying ID token, so a long-lived tab does not need to come back here.
//
// The token-verification logic below is duplicated from api/sync.js on purpose, for the
// same reason sync.js duplicates it from auth.js: an earlier shared api/_lib/session.js
// was not picked up by Vercel's deployment bundle (ERR_MODULE_NOT_FOUND at runtime despite
// existing in the repo). THERE ARE NOW THREE COPIES — auth.js signs, sync.js verifies,
// this file verifies. If session logic changes, change all three.
//
// Required env vars:
//   SESSION_SECRET             — same value auth.js signs with; this file only verifies.
//   FIREBASE_SERVICE_ACCOUNT   — the entire service-account JSON, minified to one line.
//
// Request:  POST, Authorization: Bearer <HMAC session token>   (no body)
// Success:  200 { firebaseToken: string }
// Failure:  401 { error: 'Not signed in' }

import { createHmac, timingSafeEqual } from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Returns 'umang' | 'chetna' if validly signed and unexpired, otherwise null. Same shape
// and same deliberate no-reason-given failure mode as sync.js's copy.
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

// Vercel keeps the module warm between invocations, so getApps() guards against
// re-initialising on a second request into the same container (which throws).
function ensureAdminApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const parsed = JSON.parse(raw);
  // Same literal-\n problem the Google service-account key already has in sync.js and
  // check-reminders.js: pasting JSON into a Vercel env var preserves the "\n" as two
  // characters inside the private_key string. JSON.parse turns \\n into \n correctly when
  // the value was pasted as valid JSON, but a key that was escaped twice needs this.
  if (parsed.private_key && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  initializeApp({ credential: cert(parsed) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const profile = verifyToken(token);
  if (!profile) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  try {
    ensureAdminApp();
    // uid is the bare profile id, so security rules can compare auth.uid === $p directly.
    const firebaseToken = await getAuth().createCustomToken(profile, { profile });
    res.status(200).json({ firebaseToken });
  } catch (err) {
    console.error('firebase-token failed:', err);
    res.status(500).json({ error: 'Failed to mint Firebase token' });
  }
}
