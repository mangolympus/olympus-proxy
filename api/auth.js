// api/auth.js
// Replaces Google Sign-In as the app's access gate. Verifies a per-profile password against
// Vercel env vars and issues a signed session token on success — the password itself never
// ships to the browser, only this endpoint ever sees it, and only in the one request that
// checks it.
//
// The token-signing logic below is intentionally duplicated in api/sync.js rather than
// imported from a shared api/_lib/session.js file — an earlier version did share it via
// that file, but Vercel's deployment bundle wasn't picking it up (ERR_MODULE_NOT_FOUND at
// runtime despite the file existing in the repo). ~40 duplicated lines across two small
// functions is a completely reasonable trade to sidestep that entire class of deploy issue,
// rather than continuing to debug exactly why the shared-file import wasn't bundled.
//
// Required env vars (Vercel → Settings → Environment Variables):
//   UMANG_PASSWORD    — Umang's login password
//   CHETNA_PASSWORD   — Chetna's login password
//   SESSION_SECRET    — any long random string, used only to sign tokens.
//
// Request:  POST { profile: 'umang' | 'chetna', password: string }
// Success:  200  { token: string, expiresAt: number, profile: string, firebaseToken: string }
// Failure:  401  { error: 'Incorrect password' }
//
// PHASE 0 (Firebase RTDB migration): this now ALSO mints a Firebase custom token alongside
// the existing HMAC token. The HMAC token is NOT going away — /api/sync still requires it
// throughout the dual-write phase, and /api/send-push and /api/ask now require it too.
// Firebase env var required from Phase 0 onward: FIREBASE_SERVICE_ACCOUNT.
//
// Minting is deliberately NON-FATAL: if Firebase is misconfigured, login still succeeds and
// simply returns no firebaseToken, and the client leaves S.rtdbReady false. Phase 0's whole
// promise is "no user-visible behaviour changes", and a broken Firebase project locking both
// people out of their own study tracker would be the opposite of that.

import { createHmac, timingSafeEqual } from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}

// Constant-time comparison — a plain === leaks timing information proportional to how many
// leading characters match, a real (if minor) attack vector for password checks.
function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Vercel keeps the module warm between invocations, so getApps() guards against
// re-initialising on a second request into the same container (which throws).
function ensureAdminApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const parsed = JSON.parse(raw);
  if (parsed.private_key && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  initializeApp({ credential: cert(parsed) });
}

function issueToken(profile) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${profile}.${expiresAt}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  return { token, expiresAt };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { profile, password } = req.body || {};
  const expected =
    profile === 'umang' ? process.env.UMANG_PASSWORD :
    profile === 'chetna' ? process.env.CHETNA_PASSWORD :
    null;

  // Same error either way — no reason to reveal whether the profile name or the password
  // was the part that didn't match.
  if (!expected || !safeEqual(password, expected)) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  const { token, expiresAt } = issueToken(profile);

  // Firebase custom token — uid is the bare profile id so security rules can compare
  // auth.uid === $p directly. Failure here is logged and swallowed, not surfaced: see the
  // non-fatal note at the top of this file.
  let firebaseToken = null;
  try {
    ensureAdminApp();
    firebaseToken = await getAuth().createCustomToken(profile, { profile });
  } catch (err) {
    console.error('Firebase custom token mint failed (login still succeeded):', err);
  }

  res.status(200).json({ token, expiresAt, profile, firebaseToken });
}
