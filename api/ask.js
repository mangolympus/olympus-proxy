// api/ask.js
// Gemini proxy behind the AI Coach, Doubt Solver, Summary Generator and Study Chat.
//
// PREREQUISITE FIX (handoff known issue #7). Two problems, both live before this change:
//   1. No auth at all — anyone who found the URL could POST and spend the Gemini quota.
//   2. `Access-Control-Allow-Origin: *` actively invited them to, from any web page.
// Both are now closed. The wildcard origin is gone (the app is same-origin with this
// endpoint and never needed CORS in the first place), and a valid session token is required.
//
// NOTE ON THE PREFLIGHT: Access-Control-Allow-Headers now includes Authorization. Sending an
// Authorization header makes the request non-simple, so the browser fires an OPTIONS
// preflight first — if that header is not advertised, every AI feature in the app dies with
// an opaque CORS error rather than a clean 401. Do not remove it.
//
// Required env vars:
//   GEMINI_API_KEY
//   SESSION_SECRET   — same value api/auth.js signs with; this file only verifies.
//
// Request:  POST { prompt: string }, Authorization: Bearer <session token>
// Success:  200 { text: string }
// Failure:  401 { error: 'Not signed in' } | 400 | 500

import { createHmac, timingSafeEqual } from 'crypto';

function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Fifth copy of the same logic — see the note in api/send-push.js. Deliberate.
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!verifyToken(bearer)) { res.status(401).json({ error: 'Not signed in' }); return; }

  const { prompt } = req.body || {};
  if (!prompt) { res.status(400).json({ error: 'Missing prompt' }); return; }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return; }

  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await r.json();
    if (!r.ok) { res.status(r.status).json({ error: JSON.stringify(data) }); return; }
    res.status(200).json({ text: data?.candidates?.[0]?.content?.parts?.[0]?.text || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
