// api/sync.js
// Reads and writes the same shared olympus-data.json file the app has always used — just
// through the service account instead of whichever person's personal Google session was
// active. Folder ID and filename copied directly from the existing client-side sync code
// (SHARED_DRIVE_FOLDER_ID / DRIVE_FILE_NAME in index.html) so this targets the exact same
// file, not a new one.
//
// Required env vars (already present if the Vercel dashboard already lists them — this app
// likely already had these for another purpose):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
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
// GET  → 200 { data: <shared JSON, or null if the file doesn't exist yet>, modifiedTime }
// POST → body is the full shared JSON payload to save; 200 { ok: true }

import pkg from 'googleapis';
import { Readable } from 'stream';
import { verifyToken } from './_lib/session.js';

// googleapis ships as CommonJS — importing its default export and destructuring is the safe
// way to get `google` out of it regardless of how completely Node's ESM/CJS interop detects
// named exports for third-party packages (Node's own builtins like crypto/stream have more
// reliable named-export interop than arbitrary npm packages do).
const { google } = pkg;

const FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s';
const FILE_NAME = 'olympus-data.json';

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

async function findFile(drive) {
  const q = `name='${FILE_NAME}' and '${FOLDER_ID}' in parents and trashed=false`;
  const result = await drive.files.list({ q, fields: 'files(id, name, modifiedTime)' });
  return (result.data.files && result.data.files[0]) || null;
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
    try {
      const existing = await findFile(drive);
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
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Missing or invalid body' });
      return;
    }
    try {
      const existing = await findFile(drive);
      const media = { mimeType: 'application/json', body: stringToStream(JSON.stringify(payload)) };
      if (existing) {
        await drive.files.update({ fileId: existing.id, media });
      } else {
        // Only reachable if the file genuinely doesn't exist yet — if this fires on what
        // should be an existing file, it almost always means the Drive-sharing setup step
        // above wasn't done, not that the file is actually missing. Worth checking Drive
        // directly for a stray duplicate file if this ever happens unexpectedly.
        await drive.files.create({ requestBody: { name: FILE_NAME, parents: [FOLDER_ID] }, media });
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
