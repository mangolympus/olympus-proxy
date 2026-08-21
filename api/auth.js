// api/auth.js
// Replaces Google Sign-In as the app's access gate. Verifies a per-profile password against
// Vercel env vars and issues a signed session token on success — the password itself never
// ships to the browser, only this endpoint ever sees it, and only in the one request that
// checks it.
//
// Required env vars (Vercel → Settings → Environment Variables):
//   UMANG_PASSWORD    — Umang's login password
//   CHETNA_PASSWORD   — Chetna's login password
//   SESSION_SECRET    — any long random string, used only to sign tokens. Generate one with
//                        `openssl rand -hex 32` in a terminal (Mac/Linux, or Git Bash on
//                        Windows), or any other long random string — it just needs to be
//                        unguessable and never shared. Changing this later invalidates every
//                        currently-issued token, forcing everyone to log in again — useful if
//                        a token ever leaked, not needed otherwise.
//
// Request:  POST { profile: 'umang' | 'chetna', password: string }
// Success:  200  { token: string, expiresAt: number, profile: string }
// Failure:  401  { error: 'Incorrect password' }

const { issueToken, safeEqual } = require('./_lib/session');

module.exports = async (req, res) => {
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
  res.status(200).json({ token, expiresAt, profile });
};
