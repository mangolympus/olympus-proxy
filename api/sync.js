// api/sync.js
// Reads and writes files in the same shared Drive folder the app has always used — just
// through the service account instead of whichever person's personal Google session was
// active. Folder ID copied directly from the existing client-side sync code
// (SHARED_DRIVE_FOLDER_ID in index.html) so this targets the exact same folder, not a new one.
//
// Handles three different files by name, not just the main one — the frontend also keeps
// chat photos and an archive in two separate files in this same folder (see
// PHOTOS_FILE_NAME/ARCHIVE_FILE_NAME in index.html), both read/written through this same
// endpoint via the ?file= query param (GET) or file body field (POST). Defaults to the main
// data file when omitted, so the primary sync call site doesn't need to specify anything.
//
// The token-verification logic below is intentionally duplicated from api/auth.js rather
// than imported from a shared api/_lib/session.js file — an earlier version shared it via
// that file, but Vercel's deployment bundle wasn't picking it up (ERR_MODULE_NOT_FOUND at
// runtime despite the file existing in the repo). Duplicating ~25 lines across two small
// functions is a reasonable trade to sidestep that entire class of deploy issue. If either
// file's session logic ever needs to change, remember to update both copies.
//
// Required env vars (already present if the Vercel dashboard already lists them — this app
// likely already had these for another purpose):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   SESSION_SECRET   — same value as api/auth.js uses to sign tokens; this file only verifies.
//
// One-time manual setup step, separate from env vars: the service account is its own distinct
// Google identity, so it needs to be individually invited to the Drive folder — open the
// "Olympus CA Tracker" folder in Drive → Share → paste GOOGLE_SERVICE_ACCOUNT_EMAIL's address
// → Editor. Skipping this means every request below fails with a 404/403 from Drive, not
// because the code is wrong but because the service account genuinely can't see the folder yet.
//
// Needs the `googleapis` package in package.json dependencies.
//
// Auth: every request needs `Authorization: Bearer <token>` from a prior /api/auth call.
// GET  /api/sync?file=<name>  → 200 { data: <JSON, or null if the file doesn't exist yet>, modifiedTime }
// POST /api/sync              → body { file?: <name>, payload: <JSON to save> }; 200 { ok: true }
//   (file defaults to the main data file on both GET and POST when omitted)

import pkg from 'googleapis';
import { Readable } from 'stream';
import { createHmac, timingSafeEqual } from 'crypto';

// googleapis ships as CommonJS — importing its default export and destructuring is the safe
// way to get `google` out of it regardless of how completely Node's ESM/CJS interop detects
// named exports for third-party packages.
const { google } = pkg;

const FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s';
const DEFAULT_FILE_NAME = 'olympus-data.json';

function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Returns 'umang' | 'chetna' if the token is validly signed and unexpired, otherwise null —
// the entire access-control boundary for this endpoint. Every failure mode (bad format, bad
// signature, expired, unrecognized profile) returns the same null rather than a specific
// reason, so a caller probing the endpoint can't learn which part failed.
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

function getDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // Vercel env vars are single-line — the PEM key's real newlines get stored as the
      // literal two characters "\n", which need converting back before the key will parse.
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function findFile(drive, fileName) {
  const q = `name='${fileName}' and '${FOLDER_ID}' in parents and trashed=false`;
  const result = await drive.files.list({ q, fields: 'files(id, name, modifiedTime)' });
  return (result.data.files && result.data.files[0]) || null;
}

// Only letters, digits, dots, hyphens, underscores — every filename this endpoint actually
// uses (olympus-data.json, olympus-chat-photos.json, olympus-archive.json) fits this, and it
// keeps an arbitrary ?file= value from being usable to inject anything into the Drive query
// string built above.
function isValidFileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name);
}

function stringToStream(str) {
  const s = new Readable();
  s.push(str);
  s.push(null);
  return s;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const profile = verifyToken(token);
  if (!profile) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  let drive;
  try {
    drive = getDrive();
  } catch (err) {
    console.error('Service account credentials not configured correctly:', err);
    res.status(500).json({ error: 'Server misconfigured — check GOOGLE_SERVICE_ACCOUNT_* env vars' });
    return;
  }

  if (req.method === 'GET') {
    const fileName = req.query && req.query.file ? req.query.file : DEFAULT_FILE_NAME;
    if (!isValidFileName(fileName)) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    try {
      const existing = await findFile(drive, fileName);
      if (!existing) {
        res.status(200).json({ data: null, modifiedTime: null });
        return;
      }
      const content = await drive.files.get(
        { fileId: existing.id, alt: 'media' },
        { responseType: 'text' }
      );
      let data;
      try {
        data = JSON.parse(content.data);
      } catch (e) {
        console.error('Shared file content was not valid JSON:', e);
        res.status(500).json({ error: 'Shared data file is corrupted' });
        return;
      }
      res.status(200).json({ data, modifiedTime: existing.modifiedTime });
    } catch (err) {
      console.error('sync GET failed:', err);
      res.status(500).json({ error: 'Failed to read shared data' });
    }
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const fileName = body.file || DEFAULT_FILE_NAME;
    const payload = body.payload;
    if (!isValidFileName(fileName)) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Missing or invalid payload' });
      return;
    }
    try {
      const existing = await findFile(drive, fileName);
      const media = { mimeType: 'application/json', body: stringToStream(JSON.stringify(payload)) };
      if (existing) {
        await drive.files.update({ fileId: existing.id, media });
      } else {
        // Only reachable if the file genuinely doesn't exist yet — for the main data file,
        // if this fires on what should already exist, it almost always means the Drive-
        // sharing setup step above wasn't done. For the photos/archive files, it's normal
        // the first time either feature is ever used.
        await drive.files.create({ requestBody: { name: fileName, parents: [FOLDER_ID] }, media });
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('sync POST failed:', err);
      res.status(500).json({ error: 'Failed to save shared data' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
